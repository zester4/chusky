import { DaytonaProcessExecutionTimeoutError, type FileInfo, type Sandbox, type PtyHandle } from "@daytona/sdk";
import { randomUUID } from "node:crypto";
import PptxGenJS from "pptxgenjs";
import { config } from "../../config.js";
import { clearDaytonaWorkspace, getDaytonaWorkspace, getSession, saveDaytonaWorkspace, saveSession, type ArtifactRecord, type ArtifactType } from "../../store.js";
import { DaytonaInputError } from "./errors.js";
import { getDaytonaClient } from "./client.js";
import type { DaytonaArtifactDelivery, DaytonaCommandResult, DaytonaFileInfo, DaytonaGitResult, DaytonaPreviewResult, DaytonaPtyResult, DaytonaScreenshotResult, DaytonaSnapshotResult, DaytonaWorkspaceInfo } from "./types.js";

const createPromises = new Map<number, Promise<Sandbox>>();
const configuredAutoPauseMinutes = Number.parseInt(config.daytonaAutoPauseInterval, 10);
// Daytona rejects autoPauseInterval for container sandboxes. Keep it disabled
// by default and let deployments opt in after choosing a pausable target.
const DAYTONA_AUTO_PAUSE_MINUTES = Number.isInteger(configuredAutoPauseMinutes) && configuredAutoPauseMinutes > 0
  ? configuredAutoPauseMinutes
  : 0;
const DAYTONA_MAX_COMMAND_LENGTH = 8000;
const DAYTONA_MAX_OUTPUT_CHARS = 12000;
const DAYTONA_MAX_FILE_CONTENT = 48000;
const DAYTONA_MAX_PTY_OUTPUT = 12000;
const DAYTONA_MAX_ARTIFACT_BYTES = 45 * 1024 * 1024;
const DAYTONA_MAX_EXECUTION_SECONDS = 900;

function boundedInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export function safeDaytonaPath(value: unknown, label = "path"): string {
  let path = String(value ?? "").trim();
  const daytonaHome = "/home/user/";
  if (path.toLowerCase().startsWith(daytonaHome)) path = path.slice(daytonaHome.length);
  const absolute = path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
  if (!path || absolute || path.includes("\0") || path.split(/[\\/]+/).includes("..")) {
    throw new DaytonaInputError(`${label} must be a non-empty workspace-relative path without '..'; /home/user/... is normalized automatically`);
  }
  return path;
}

function workspaceInfo(sandbox: Sandbox): DaytonaWorkspaceInfo {
  return {
    id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    sandboxClass: sandbox.sandboxClass,
    cpu: sandbox.cpu,
    memory: sandbox.memory,
    disk: sandbox.disk,
    createdAt: sandbox.createdAt,
    updatedAt: sandbox.updatedAt,
    autoPauseInterval: sandbox.autoPauseInterval,
    networkBlockAll: sandbox.networkBlockAll,
    domainAllowList: sandbox.domainAllowList,
  };
}

function workspaceRecord(sandbox: Sandbox) {
  return {
    sandboxId: sandbox.id,
    name: sandbox.name,
    createdAt: Date.parse(sandbox.createdAt ?? "") || Date.now(),
    updatedAt: Date.now(),
    lastKnownState: sandbox.state,
  };
}

function coordinate(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw new DaytonaInputError(`${label} must be a coordinate between 0 and 10000`);
  return Math.floor(n);
}

function boundedText(value: unknown, label: string, max: number): string {
  const text = String(value ?? "");
  if (!text || text.length > max) throw new DaytonaInputError(`${label} must be 1-${max} characters`);
  return text;
}

const ARTIFACT_TYPES = new Set<ArtifactType>(["website", "report", "docx", "presentation", "pdf", "spreadsheet", "image", "video", "zip", "project"]);
const ARTIFACT_MIME: Record<ArtifactType, string> = {
  website: "text/html", report: "text/markdown", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf", spreadsheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", image: "image/png",
  video: "video/mp4", zip: "application/zip", project: "application/zip",
};
const ARTIFACT_EXTENSION: Record<ArtifactType, string> = {
  website: "html", report: "md", docx: "docx", presentation: "pptx", pdf: "pdf",
  spreadsheet: "xlsx", image: "png", video: "mp4", zip: "zip", project: "zip",
};

const STRUCTURED_ARTIFACT_TYPES = new Set<ArtifactType>(["docx", "presentation", "pdf", "spreadsheet"]);

function artifactValidationScript(type: ArtifactType, path: string): string {
  const officeRoots: Partial<Record<ArtifactType, string>> = {
    docx: "word/document.xml",
    presentation: "ppt/presentation.xml",
    spreadsheet: "xl/workbook.xml",
  };
  const root = officeRoots[type];
  return [
    "import os, posixpath, sys, zipfile, xml.etree.ElementTree as ET",
    `path=${JSON.stringify(path)}`,
    `kind=${JSON.stringify(type)}`,
    "def fail(message):",
    "    print(message, file=sys.stderr)",
    "    raise SystemExit(2)",
    "if not os.path.isfile(path): fail('artifact file does not exist')",
    "if kind == 'pdf':",
    "    with open(path, 'rb') as f:",
    "        header = f.read(5)",
    "        f.seek(max(0, os.path.getsize(path) - 4096))",
    "        tail = f.read()",
    "    if header != b'%PDF-': fail('invalid PDF header')",
    "    if b'%%EOF' not in tail: fail('PDF is missing an EOF marker')",
    "else:",
    "    try:",
    "        with zipfile.ZipFile(path) as archive:",
    "            bad = archive.testzip()",
    "            names = set(archive.namelist())",
    "    except (OSError, zipfile.BadZipFile) as error:",
    "        fail('invalid Office Open XML package: ' + str(error))",
    "    if bad: fail('Office Open XML package has a corrupt member: ' + bad)",
    `    required = ['[Content_Types].xml', ${JSON.stringify(root ?? "")} ]`,
    "    missing = [name for name in required if name and name not in names]",
    "    if missing: fail('Office Open XML package is missing: ' + ', '.join(missing))",
    "    try:",
    "        with zipfile.ZipFile(path) as archive:",
    "            for name in required:",
    "                if name: ET.fromstring(archive.read(name))",
    "            # Validate every XML part and every internal OOXML relationship.",
    "            # A ZIP with presentation.xml can still be unreadable by Office",
    "            # when a slide, media target, or relationship is missing.",
    "            for name in names:",
    "                if name.lower().endswith('.xml') or name.lower().endswith('.rels'):",
    "                    try:",
    "                        ET.fromstring(archive.read(name))",
    "                    except ET.ParseError as error:",
    "                        fail('invalid XML in ' + name + ': ' + str(error))",
    "            rel_ns='{http://schemas.openxmlformats.org/package/2006/relationships}'",
    "            for rels_name in [name for name in names if name.endswith('.rels')]:",
    "                try:",
    "                    rels=ET.fromstring(archive.read(rels_name))",
    "                except ET.ParseError as error:",
    "                    fail('invalid relationships XML in ' + rels_name + ': ' + str(error))",
    "                source_dir='' if rels_name == '_rels/.rels' else posixpath.dirname(rels_name).rsplit('/_rels', 1)[0]",
    "                for rel in rels.findall(rel_ns + 'Relationship'):",
    "                    target=rel.attrib.get('Target', '')",
    "                    if not target or rel.attrib.get('TargetMode') == 'External': continue",
    "                    # OOXML package targets are package-relative even when they begin with '/'.",
    "                    target_path=posixpath.normpath(posixpath.join(source_dir, target.lstrip('/'))) ",
    "                    if target_path.startswith('../') or target_path not in names:",
    "                        fail('OOXML relationship target is missing: ' + rels_name + ' -> ' + target)",
    "    except (KeyError, ET.ParseError, OSError) as error:",
    "        fail('Office Open XML package contains invalid XML: ' + str(error))",
    "print('artifact structure validated')",
  ].join("\n");
}

function artifactVisualQaScript(type: ArtifactType, path: string): string {
  return [
    "import os, shutil, subprocess, sys, tempfile",
    `path=${JSON.stringify(path)}`,
    `kind=${JSON.stringify(type)}`,
    "if not os.path.isfile(path):",
    "    print('visual QA failed: artifact file does not exist', file=sys.stderr)",
    "    raise SystemExit(2)",
    "tmp=tempfile.mkdtemp(prefix='chusky-artifact-qa-')",
    "try:",
    "    pdf=path",
    "    if kind != 'pdf':",
    "        office=shutil.which('libreoffice') or shutil.which('soffice')",
    "        if not office:",
    "            print('visual QA skipped: LibreOffice renderer is not installed')",
    "            raise SystemExit(0)",
    "        converted=subprocess.run([office, '--headless', '--convert-to', 'pdf', '--outdir', tmp, path], text=True, capture_output=True, timeout=120)",
    "        if converted.returncode != 0:",
    "            print('visual QA failed: Office-to-PDF rendering failed: ' + (converted.stderr or converted.stdout)[-800:], file=sys.stderr)",
    "            raise SystemExit(2)",
    "        pdf=os.path.join(tmp, os.path.splitext(os.path.basename(path))[0] + '.pdf')",
    "    if not os.path.isfile(pdf) or os.path.getsize(pdf) < 10:",
    "        print('visual QA failed: renderer produced no PDF output', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    pdfinfo=shutil.which('pdfinfo')",
    "    if pdfinfo:",
    "        info=subprocess.run([pdfinfo, pdf], text=True, capture_output=True, timeout=30)",
    "        if info.returncode != 0 or not any(line.startswith('Pages:') and int(line.split(':', 1)[1].strip()) > 0 for line in info.stdout.splitlines() if ':' in line and line.startswith('Pages:')):",
    "            print('visual QA failed: PDF has no readable pages', file=sys.stderr)",
    "            raise SystemExit(2)",
    "    raster=shutil.which('pdftoppm')",
    "    if raster:",
    "        png=os.path.join(tmp, 'page')",
    "        rendered=subprocess.run([raster, '-f', '1', '-l', '1', '-png', '-singlefile', pdf, png], capture_output=True, timeout=120)",
    "        preview=png + '.png'",
    "        if rendered.returncode != 0 or not os.path.isfile(preview) or os.path.getsize(preview) < 100:",
    "            print('visual QA failed: first page could not be rasterized', file=sys.stderr)",
    "            raise SystemExit(2)",
    "        print('visual QA passed: rendered first page (' + str(os.path.getsize(preview)) + ' bytes)')",
    "    else:",
    "        print('visual QA passed: PDF page structure verified; pixel renderer unavailable')",
    "finally:",
    "    shutil.rmtree(tmp, ignore_errors=True)",
  ].join("\n");
}

function artifactType(value: unknown): ArtifactType {
  const type = String(value ?? "").trim() as ArtifactType;
  if (!ARTIFACT_TYPES.has(type)) throw new DaytonaInputError("type must be a supported artifact type");
  return type;
}

function artifactName(value: unknown): string {
  const name = String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!name || name.length > 120) throw new DaytonaInputError("name must be 1-120 safe characters");
  return name;
}

function artifactNameForType(value: unknown, type: ArtifactType): string {
  const name = artifactName(value);
  const extension = `.${ARTIFACT_EXTENSION[type]}`;
  if (name.toLowerCase().endsWith(extension)) return name;
  const maxBaseLength = 120 - extension.length;
  return `${name.slice(0, maxBaseLength)}${extension}`;
}

function isBinaryFile(path: string, bytes: Buffer): string | undefined {
  const lowerPath = path.toLowerCase();
  const knownBinaryExtensions = [".pdf", ".docx", ".pptx", ".xlsx", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp3", ".m4a", ".wav", ".ogg", ".mp4"];
  if (knownBinaryExtensions.some((extension) => lowerPath.endsWith(extension))) return "binary";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "PDF";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "archive";
  if (bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0)) return "binary";
  return undefined;
}

function boundedNumber(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

type PresentationSlideInput = {
  title: string;
  body?: string;
  bullets?: string[];
  imagePaths?: string[];
  table?: string[][];
  chart?: { categories: string[]; series: Array<{ name: string; values: number[] }> };
};

function presentationText(value: unknown, label: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new DaytonaInputError(`${label} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new DaytonaInputError(`${label} must be text`);
  const result = value.trim();
  if ((required && !result) || result.length > max) throw new DaytonaInputError(`${label} must be ${required ? "1-" : "0-"}${max} characters`);
  return result || undefined;
}

function presentationTableCell(value: unknown, label: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return presentationText(value, label, 400) ?? "";
}

function presentationTable(value: unknown, slideIndex: number): string[][] | undefined {
  if (value === undefined || value === null) return undefined;
  let rows: unknown[];
  if (Array.isArray(value)) {
    // Models often include an empty optional table field on narrative slides.
    // Treat it as absent instead of rejecting the entire deck.
    if (value.length === 0) return undefined;
    rows = value;
  } else if (typeof value === "object") {
    // Accept the common LLM-friendly { headers, rows } form as well as the
    // documented matrix form. Both are normalized before presentation output.
    const table = value as Record<string, unknown>;
    const headers = table.headers;
    const body = table.rows;
    if (headers !== undefined && !Array.isArray(headers)) throw new DaytonaInputError(`slides[${slideIndex}].table.headers must be an array`);
    if (body !== undefined && !Array.isArray(body)) throw new DaytonaInputError(`slides[${slideIndex}].table.rows must be an array`);
    if (headers === undefined && body === undefined) throw new DaytonaInputError(`slides[${slideIndex}].table must be a matrix or { headers, rows } object`);
    rows = [
      ...(headers === undefined ? [] : [headers]),
      ...(body ?? []),
    ];
    if (rows.length === 0) return undefined;
  } else {
    throw new DaytonaInputError(`slides[${slideIndex}].table must be a matrix or { headers, rows } object`);
  }
  if (rows.length > 20) throw new DaytonaInputError(`slides[${slideIndex}].table has ${rows.length} rows; split it across slides so each table has at most 20 rows`);
  return rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 10) throw new DaytonaInputError(`slides[${slideIndex}].table[${rowIndex}] must contain 1-10 cells`);
    return row.map((cell, cellIndex) => presentationTableCell(cell, `slides[${slideIndex}].table[${rowIndex}][${cellIndex}]`));
  });
}

function presentationSlides(value: unknown): PresentationSlideInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw new DaytonaInputError("slides must contain 1-30 slide definitions");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DaytonaInputError(`slides[${index}] must be an object`);
    const slide = raw as Record<string, unknown>;
    const bullets = slide.bullets === undefined ? undefined : Array.isArray(slide.bullets)
      ? slide.bullets.slice(0, 12).map((item, bulletIndex) => presentationText(item, `slides[${index}].bullets[${bulletIndex}]`, 500, true)!)
      : (() => { throw new DaytonaInputError(`slides[${index}].bullets must be an array`); })();
    const imagePaths = slide.imagePaths === undefined ? undefined : Array.isArray(slide.imagePaths)
      ? slide.imagePaths.slice(0, 4).map((item, imageIndex) => safeDaytonaPath(presentationText(item, `slides[${index}].imagePaths[${imageIndex}]`, 500, true)!))
      : (() => { throw new DaytonaInputError(`slides[${index}].imagePaths must be an array`); })();
    const table = presentationTable(slide.table, index);
    const rawChart = slide.chart;
    let chart: PresentationSlideInput["chart"];
    if (rawChart !== undefined) {
      if (!rawChart || typeof rawChart !== "object" || Array.isArray(rawChart)) throw new DaytonaInputError(`slides[${index}].chart must be an object`);
      const input = rawChart as Record<string, unknown>;
      if (!Array.isArray(input.categories) || input.categories.length < 1 || input.categories.length > 12 || !Array.isArray(input.series) || input.series.length < 1 || input.series.length > 6) throw new DaytonaInputError(`slides[${index}].chart needs 1-12 categories and 1-6 series`);
      const categories = input.categories as unknown[];
      chart = {
        categories: categories.map((item, categoryIndex) => presentationText(item, `slides[${index}].chart.categories[${categoryIndex}]`, 100, true)!),
        series: input.series.map((item, seriesIndex) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new DaytonaInputError(`slides[${index}].chart.series[${seriesIndex}] must be an object`);
          const series = item as Record<string, unknown>;
          if (!Array.isArray(series.values) || series.values.length !== categories.length || series.values.some((number) => typeof number !== "number" || !Number.isFinite(number))) throw new DaytonaInputError(`slides[${index}].chart.series[${seriesIndex}].values must match category count`);
          return { name: presentationText(series.name, `slides[${index}].chart.series[${seriesIndex}].name`, 100, true)!, values: series.values };
        }),
      };
    }
    // The standard layout deliberately reserves the lower portion of a slide
    // for one data component. Keeping tables and charts on separate slides
    // prevents valid files that nevertheless have overlapping content.
    if (table && chart) {
      throw new DaytonaInputError(`slides[${index}] cannot include both table and chart; use separate slides`);
    }
    return { title: presentationText(slide.title, `slides[${index}].title`, 200, true)!, body: presentationText(slide.body, `slides[${index}].body`, 2000), bullets, imagePaths, table, chart };
  });
}

function presentationGenerationScript(title: string, slides: PresentationSlideInput[], path: string): string {
  const payload = Buffer.from(JSON.stringify({ title, slides, path }), "utf8").toString("base64");
  return [
    "import base64, importlib, json, os, subprocess, sys",
    `payload=json.loads(base64.b64decode(${JSON.stringify(payload)}))`,
    "dependency_dir=os.path.abspath(os.path.join('workspace', '.chusky', 'python-pptx'))",
    "if dependency_dir not in sys.path: sys.path.insert(0, dependency_dir)",
    "def load_presentation():",
    "    try:",
    "        from pptx import Presentation",
    "        return Presentation",
    "    except ImportError:",
    "        return None",
    "Presentation=load_presentation()",
    "if Presentation is None:",
    "    os.makedirs(dependency_dir, exist_ok=True)",
    "    install_args=[sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', '--target', dependency_dir, 'python-pptx']",
    "    install=subprocess.run(install_args, text=True, capture_output=True, timeout=180)",
    "    if install.returncode != 0 and ('No module named pip' in (install.stderr or '') or 'No module named pip' in (install.stdout or '')):",
    "        subprocess.run([sys.executable, '-m', 'ensurepip', '--upgrade'], text=True, capture_output=True, timeout=90)",
    "        install=subprocess.run(install_args, text=True, capture_output=True, timeout=180)",
    "    if install.returncode != 0:",
    "        detail=(install.stderr or install.stdout or 'unknown pip error').strip().replace('\\n', ' ')",
    "        raise RuntimeError('python-pptx could not be installed in this Daytona workspace: ' + detail[-500:])",
    "    importlib.invalidate_caches()",
    "    Presentation=load_presentation()",
    "    if Presentation is None: raise RuntimeError('python-pptx was installed but cannot be imported from the workspace dependency directory')",
    "from pptx.util import Inches, Pt",
    "from pptx.enum.text import PP_ALIGN",
    "from pptx.enum.chart import XL_CHART_TYPE",
    "from pptx.chart.data import CategoryChartData",
    "from pptx.dml.color import RGBColor",
    "path=payload['path']",
    "os.makedirs(os.path.dirname(path) or '.', exist_ok=True)",
    "prs=Presentation()",
    "prs.slide_width=Inches(13.333)",
    "prs.slide_height=Inches(7.5)",
    "def add_text(slide, value, left, top, width, height, size, bold=False, color=(20,35,55)):",
    "    box=slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))",
    "    tf=box.text_frame; tf.clear(); tf.word_wrap=True",
    "    p=tf.paragraphs[0]; p.text=value; p.font.size=Pt(size); p.font.bold=bold; p.font.color.rgb=RGBColor(*color)",
    "    return box",
    "cover=prs.slides.add_slide(prs.slide_layouts[6])",
    "cover.background.fill.solid(); cover.background.fill.fore_color.rgb=RGBColor(246,249,252)",
    "add_text(cover, payload['title'], 0.9, 2.4, 11.5, 1.3, 32, True)",
    "add_text(cover, 'Created by Chusky', 0.95, 3.85, 5.0, 0.4, 14, False, (73,101,128))",
    "for spec in payload['slides']:",
    "    slide=prs.slides.add_slide(prs.slide_layouts[6])",
    "    slide.background.fill.solid(); slide.background.fill.fore_color.rgb=RGBColor(255,255,255)",
    "    add_text(slide, spec['title'], 0.7, 0.45, 11.9, 0.6, 24, True)",
    "    images=spec.get('imagePaths') or []",
    "    text_width=7.1 if images else 11.8",
    "    cursor=1.3",
    "    if spec.get('body'):",
    "        add_text(slide, spec['body'], 0.8, cursor, text_width, 1.0, 16)",
    "        cursor += 1.05",
    "    if spec.get('bullets'):",
    "        box=slide.shapes.add_textbox(Inches(0.9), Inches(cursor), Inches(text_width), Inches(4.8-cursor))",
    "        tf=box.text_frame; tf.clear(); tf.word_wrap=True",
    "        for i, bullet in enumerate(spec['bullets']):",
    "            p=tf.paragraphs[0] if i == 0 else tf.add_paragraph(); p.text=bullet; p.level=0; p.font.size=Pt(15); p.space_after=Pt(8)",
    "    if spec.get('table'):",
    "        rows=spec['table']; cols=max(len(row) for row in rows)",
    "        table=slide.shapes.add_table(len(rows), cols, Inches(0.8), Inches(3.8), Inches(text_width), Inches(2.8)).table",
    "        for r,row in enumerate(rows):",
    "            for c in range(cols): table.cell(r,c).text=row[c] if c < len(row) else ''",
    "    if spec.get('chart'):",
    "        data=CategoryChartData(); data.categories=spec['chart']['categories']",
    "        for series in spec['chart']['series']: data.add_series(series['name'], series['values'])",
    "        slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(6.8 if not images else 0.8), Inches(3.7), Inches(5.5), Inches(2.8), data)",
    "    for i,image in enumerate(images):",
    "        if not os.path.isfile(image): raise FileNotFoundError('slide image does not exist: ' + image)",
    "        top=1.35 + i * (5.4 / max(1, len(images))); height=max(1.1, 5.0 / max(1, len(images)))",
    "        slide.shapes.add_picture(image, Inches(8.25), Inches(top), width=Inches(4.3), height=Inches(height))",
    "prs.save(path)",
    "# Re-open before returning. This catches a bad write before registration.",
    "check=Presentation(path)",
    "if len(check.slides) != len(payload['slides']) + 1: raise RuntimeError('presentation slide count verification failed')",
    "if not os.path.isfile(path) or os.path.getsize(path) < 1024: raise RuntimeError('presentation output was not written')",
    "print(json.dumps({'path': path, 'slides': len(check.slides), 'bytes': os.path.getsize(path)}))",
  ].join("\n");
}

function presentationImageMime(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
}

async function presentationBytes(sandbox: Sandbox, title: string, slides: PresentationSlideInput[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Chusky";
  pptx.company = "Chusky";
  pptx.subject = title;
  pptx.title = title;
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
  };

  const cover = pptx.addSlide();
  cover.background = { color: "F6F9FC" };
  cover.addText(title, { x: 0.9, y: 2.35, w: 11.5, h: 1.25, fontSize: 32, bold: true, color: "142337", breakLine: false, margin: 0 });
  cover.addText("Created by Chusky", { x: 0.95, y: 3.9, w: 5, h: 0.35, fontSize: 14, color: "496580", margin: 0 });

  for (const spec of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(spec.title, { x: 0.7, y: 0.45, w: 11.9, h: 0.55, fontSize: 24, bold: true, color: "142337", margin: 0 });
    const images = spec.imagePaths ?? [];
    const textWidth = images.length ? 7.1 : 11.8;
    let cursor = 1.3;
    if (spec.body) {
      slide.addText(spec.body, { x: 0.8, y: cursor, w: textWidth, h: 1, fontSize: 16, color: "142337", breakLine: false, margin: 0.03, valign: "top" });
      cursor += 1.05;
    }
    if (spec.bullets?.length) {
      slide.addText(spec.bullets.map((bullet) => `• ${bullet}`).join("\n"), { x: 0.9, y: cursor, w: textWidth, h: Math.max(1.2, 5.2 - cursor), fontSize: 15, color: "142337", breakLine: false, margin: 0.04, valign: "top" });
    }
    if (spec.table) {
      slide.addTable(spec.table as PptxGenJS.TableRow[], {
        x: 0.8, y: 3.8, w: textWidth, h: 2.8, fontSize: 12, color: "142337",
        border: { type: "solid", color: "CBD5E1", pt: 1 },
        fill: { color: "FFFFFF" }, bold: false, margin: 0.05,
        autoPage: false,
      });
    }
    if (spec.chart) {
      slide.addChart("bar", spec.chart.series.map((series) => ({ name: series.name, labels: spec.chart!.categories, values: series.values })), {
        x: images.length ? 0.8 : 6.8, y: 3.7, w: 5.5, h: 2.8,
        catAxisLabelFontSize: 10, valAxisLabelFontSize: 10, showLegend: spec.chart.series.length > 1,
        showTitle: false, showValue: true, chartColors: ["0F766E", "0284C7", "EA580C", "7C3AED"],
      });
    }
    for (let index = 0; index < images.length; index += 1) {
      const imagePath = images[index]!;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(await sandbox.fs.downloadFile(imagePath));
      } catch (error) {
        throw new DaytonaInputError(`Unable to read slide image ${imagePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!bytes.length) throw new DaytonaInputError(`Slide image is empty: ${imagePath}`);
      const top = 1.35 + index * (5.4 / Math.max(1, images.length));
      const height = Math.max(1.1, 5 / Math.max(1, images.length));
      slide.addImage({ data: `data:${presentationImageMime(imagePath)};base64,${bytes.toString("base64")}`, x: 8.25, y: top, w: 4.3, h: height, sizing: { type: "contain", x: 8.25, y: top, w: 4.3, h: height } });
    }
  }
  const output = await pptx.write({ outputType: "nodebuffer", compression: true });
  const bytes = Buffer.from(output as Uint8Array);
  if (bytes.length < 1024 || !bytes.subarray(0, 2).equals(Buffer.from("PK"))) throw new DaytonaInputError("Presentation generator returned an invalid Office Open XML package");
  if (bytes.length > DAYTONA_MAX_ARTIFACT_BYTES) throw new DaytonaInputError(`Presentation is larger than the ${Math.floor(DAYTONA_MAX_ARTIFACT_BYTES / 1024 / 1024)} MB delivery limit`);
  return bytes;
}

function collectPtyOutput(): { chunks: string[]; onData: (data: Uint8Array) => void } {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  return { chunks, onData: (data) => { chunks.push(decoder.decode(data, { stream: true })); } };
}

async function brieflyCollect(handle: PtyHandle, milliseconds = 250): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  if (!handle.isConnected()) return;
}

export class DaytonaEngine {
  constructor(private readonly clientFactory: typeof getDaytonaClient = getDaytonaClient) {}

  private async getSandbox(userId: number): Promise<Sandbox | undefined> {
    const stored = await getDaytonaWorkspace(userId);
    if (!stored?.sandboxId) return undefined;
    try {
      const sandbox = await this.clientFactory().get(stored.sandboxId);
      await sandbox.refreshData();
      if (sandbox.recoverable && sandbox.state !== "started") await sandbox.recover(60);
      else if (sandbox.state !== "started") await sandbox.start(60);
      await sandbox.refreshActivity();
      await saveDaytonaWorkspace(userId, { ...stored, name: sandbox.name, updatedAt: Date.now(), lastKnownState: sandbox.state });
      return sandbox;
    } catch (error) {
      const message = String(error);
      if (/not found|404|destroyed/i.test(message)) {
        await clearDaytonaWorkspace(userId);
        return undefined;
      }
      throw error;
    }
  }

  async getOrCreateWorkspace(userId: number): Promise<Sandbox> {
    const existing = await this.getSandbox(userId);
    if (existing) return existing;

    const pending = createPromises.get(userId);
    if (pending) return pending;

    const creation = (async () => {
      const client = this.clientFactory();
      const createParams = {
        ...(config.daytonaSnapshot ? { snapshot: config.daytonaSnapshot } : {}),
        name: `chusky-${userId}`,
        language: "typescript",
        ...(config.daytonaDomainAllowList ? { domainAllowList: config.daytonaDomainAllowList } : { networkBlockAll: config.daytonaNetworkBlockAll }),
        labels: { agent: "chusky", user_id: String(userId) },
        ...(DAYTONA_AUTO_PAUSE_MINUTES > 0 ? { autoPauseInterval: DAYTONA_AUTO_PAUSE_MINUTES } : {}),
      };
      const sandbox = await client.create(createParams, { timeout: 120 });
      await saveDaytonaWorkspace(userId, workspaceRecord(sandbox));
      return sandbox;
    })();
    createPromises.set(userId, creation);
    try {
      return await creation;
    } finally {
      createPromises.delete(userId);
    }
  }

  async workspace(userId: number, action: "get" | "create" | "status" | "pause" | "archive" | "delete"): Promise<DaytonaWorkspaceInfo | { exists: false; message: string } | { paused: boolean; sandboxId: string } | { deleted: boolean; sandboxId: string }> {
    if (action === "delete") return this.deleteWorkspace(userId);
    if (action === "pause") return this.pause(userId);
    if (action === "create") return workspaceInfo(await this.getOrCreateWorkspace(userId));
    const sandbox = await this.getSandbox(userId);
    if (!sandbox) {
      return { exists: false, message: "No Daytona workspace exists yet. Use action=create, or use a file/computer tool and Chusky will create it automatically." };
    }
    if (action === "status") await sandbox.refreshData();
    if (action === "archive") {
      await sandbox.stop(60);
      await sandbox.archive();
      await saveDaytonaWorkspace(userId, { ...(await getDaytonaWorkspace(userId))!, updatedAt: Date.now(), lastKnownState: "archived" });
    }
    return workspaceInfo(sandbox);
  }

  async execute(userId: number, command: string, cwd?: string, timeoutSeconds?: number): Promise<DaytonaCommandResult> {
    const normalized = String(command ?? "").trim();
    if (!normalized || normalized.length > DAYTONA_MAX_COMMAND_LENGTH) {
      throw new DaytonaInputError(`command must be 1-${DAYTONA_MAX_COMMAND_LENGTH} characters`);
    }
    const sandbox = await this.getOrCreateWorkspace(userId);
    const normalizedCwd = cwd ? safeDaytonaPath(cwd, "cwd") : undefined;
    const normalizedTimeout = boundedInt(timeoutSeconds, 60, DAYTONA_MAX_EXECUTION_SECONDS);
    let result: { exitCode?: number; result?: string; artifacts?: { stdout?: string } };
    try {
      result = await sandbox.process.executeCommand(normalized, normalizedCwd, undefined, normalizedTimeout);
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? "");
      if (error instanceof DaytonaProcessExecutionTimeoutError || code === "PROCESS_EXECUTION_TIMEOUT") {
        return {
          sandboxId: sandbox.id,
          command: normalized,
          cwd: normalizedCwd,
          exitCode: 124,
          output: `Command exceeded the ${normalizedTimeout}-second execution limit. Use CHUCK_DAYTONA_PTY for long-running processes, or split the work into smaller verified commands.`,
          truncated: false,
          timedOut: true,
          timeoutSeconds: normalizedTimeout,
        };
      }
      throw error;
    }
    const raw = String(result.result ?? result.artifacts?.stdout ?? "");
    const output = raw.slice(0, DAYTONA_MAX_OUTPUT_CHARS);
    return { sandboxId: sandbox.id, command: normalized, cwd: normalizedCwd, exitCode: result.exitCode ?? 1, output, truncated: raw.length > output.length, timeoutSeconds: normalizedTimeout };
  }

  async listFiles(userId: number, path?: string, depth?: number): Promise<DaytonaFileInfo[]> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    const files = await sandbox.fs.listFiles(path ? safeDaytonaPath(path) : ".", { depth: boundedInt(depth, 1, 5) });
    return (files as FileInfo[]).map((file) => ({
      name: file.name,
      path: file.path ?? file.name,
      size: file.size,
      isDir: file.isDir,
      modifiedAt: file.modifiedAt,
    }));
  }

  async readFile(userId: number, path: string, maxChars?: number): Promise<{ path: string; content: string; truncated: boolean }> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    const normalizedPath = safeDaytonaPath(path);
    const bytes = await sandbox.fs.downloadFile(normalizedPath);
    const binaryKind = isBinaryFile(normalizedPath, bytes);
    if (binaryKind) throw new DaytonaInputError(`${normalizedPath} is a ${binaryKind} file and cannot be read as text. Register it with CHUCK_ARTIFACT or inspect it with the Daytona computer tool.`);
    const limit = boundedInt(maxChars, DAYTONA_MAX_OUTPUT_CHARS, DAYTONA_MAX_OUTPUT_CHARS);
    const content = bytes.toString("utf8");
    return { path: normalizedPath, content: content.slice(0, limit), truncated: content.length > limit };
  }

  async writeFile(userId: number, path: string, content: string): Promise<{ path: string; bytes: number }> {
    const normalizedPath = safeDaytonaPath(path);
    const normalizedContent = String(content ?? "");
    if (normalizedContent.length > DAYTONA_MAX_FILE_CONTENT) throw new DaytonaInputError(`content must be at most ${DAYTONA_MAX_FILE_CONTENT} characters`);
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.fs.uploadFile(Buffer.from(normalizedContent, "utf8"), normalizedPath);
    return { path: normalizedPath, bytes: Buffer.byteLength(normalizedContent, "utf8") };
  }

  async writeBinaryFile(userId: number, path: string, content: Buffer): Promise<{ path: string; bytes: number }> {
    const normalizedPath = safeDaytonaPath(path);
    if (!Buffer.isBuffer(content) || content.length < 1) throw new DaytonaInputError("binary content must not be empty");
    if (content.length > DAYTONA_MAX_ARTIFACT_BYTES) throw new DaytonaInputError(`binary content must be at most ${DAYTONA_MAX_ARTIFACT_BYTES} bytes`);
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.fs.uploadFile(content, normalizedPath);
    return { path: normalizedPath, bytes: content.length };
  }

  async findFiles(userId: number, path: string | undefined, pattern: string): Promise<unknown> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    const normalizedPattern = String(pattern ?? "").trim();
    if (!normalizedPattern || normalizedPattern.length > 200) throw new DaytonaInputError("pattern must be 1-200 characters");
    return sandbox.fs.findFiles(path ? safeDaytonaPath(path) : ".", normalizedPattern);
  }

  async searchFiles(userId: number, path: string | undefined, pattern: string): Promise<unknown> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    const normalizedPattern = String(pattern ?? "").trim();
    if (!normalizedPattern || normalizedPattern.length > 200) throw new DaytonaInputError("pattern must be 1-200 characters");
    return sandbox.fs.searchFiles(path ? safeDaytonaPath(path) : ".", normalizedPattern);
  }

  async fileDetails(userId: number, path: string): Promise<unknown> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    return sandbox.fs.getFileDetails(safeDaytonaPath(path));
  }

  async createFolder(userId: number, path: string): Promise<{ path: string; created: boolean }> {
    const normalizedPath = safeDaytonaPath(path);
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.fs.createFolder(normalizedPath, "755");
    return { path: normalizedPath, created: true };
  }

  async moveFiles(userId: number, source: string, destination: string): Promise<{ source: string; destination: string; moved: boolean }> {
    const normalizedSource = safeDaytonaPath(source, "source");
    const normalizedDestination = safeDaytonaPath(destination, "destination");
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.fs.moveFiles(normalizedSource, normalizedDestination);
    return { source: normalizedSource, destination: normalizedDestination, moved: true };
  }

  async deleteFile(userId: number, path: string, recursive = false): Promise<{ path: string; deleted: boolean }> {
    const normalizedPath = safeDaytonaPath(path);
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.fs.deleteFile(normalizedPath, recursive);
    return { path: normalizedPath, deleted: true };
  }

  async preview(userId: number, port: number): Promise<DaytonaPreviewResult> {
    const normalizedPort = boundedInt(port, 3000, 65535);
    const sandbox = await this.getOrCreateWorkspace(userId);
    const result = await sandbox.getPreviewLink(normalizedPort);
    const url = String(result.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new DaytonaInputError("Daytona returned an invalid preview URL");
    return { sandboxId: sandbox.id, port: normalizedPort, url };
  }

  async createSnapshot(userId: number, name: string): Promise<DaytonaSnapshotResult> {
    const normalizedName = String(name ?? "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,80}$/.test(normalizedName)) throw new DaytonaInputError("snapshot name must be 2-81 safe characters");
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.createSnapshot(normalizedName, 120);
    return { sandboxId: sandbox.id, name: normalizedName, created: true };
  }

  async computer(userId: number, args: Record<string, unknown>): Promise<unknown> {
    const action = boundedText(args.action, "action", 40);
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.computerUse.start();
    const computer = sandbox.computerUse;
    switch (action) {
      case "status": return computer.getStatus();
      case "display": return computer.display.getInfo();
      case "windows": return computer.display.getWindows();
      case "screenshot": {
        const result = await computer.screenshot.takeCompressed({ format: "jpeg", quality: 70, scale: 0.75, showCursor: args.showCursor === true });
        if (!result.screenshot) throw new DaytonaInputError("Daytona returned an empty screenshot");
        return { __daytonaScreenshot: true, sandboxId: sandbox.id, mediaType: "image/jpeg", base64: result.screenshot, sizeBytes: result.sizeBytes } satisfies DaytonaScreenshotResult & { __daytonaScreenshot: true };
      }
      case "mouse_move": return computer.mouse.move(coordinate(args.x, "x"), coordinate(args.y, "y"));
      case "mouse_click": return computer.mouse.click(coordinate(args.x, "x"), coordinate(args.y, "y"), args.button ? boundedText(args.button, "button", 10) : "left", args.double === true);
      case "mouse_drag": return computer.mouse.drag(coordinate(args.startX, "startX"), coordinate(args.startY, "startY"), coordinate(args.endX, "endX"), coordinate(args.endY, "endY"), args.button ? boundedText(args.button, "button", 10) : "left");
      case "mouse_scroll": return computer.mouse.scroll(coordinate(args.x, "x"), coordinate(args.y, "y"), args.direction === "up" ? "up" : "down", Math.min(Math.max(Math.floor(Number(args.amount ?? 1)), 1), 20));
      case "keyboard_type": await computer.keyboard.type(boundedText(args.text, "text", 4000), Math.min(Math.max(Math.floor(Number(args.delayMs ?? 0)), 0), 1000)); return { typed: true };
      case "keyboard_press": await computer.keyboard.press(boundedText(args.key, "key", 40), Array.isArray(args.modifiers) ? args.modifiers.map((m) => boundedText(m, "modifier", 20)) : []); return { pressed: true };
      case "keyboard_hotkey": await computer.keyboard.hotkey(boundedText(args.keys, "keys", 100)); return { pressed: true };
      case "accessibility_tree": return computer.accessibility.getTree({ scope: args.scope ? boundedText(args.scope, "scope", 20) : "all", maxDepth: Math.min(Math.max(Math.floor(Number(args.maxDepth ?? 4)), 0), 8) });
      case "accessibility_find": {
        const nameMatch = args.nameMatch ? boundedText(args.nameMatch, "nameMatch", 30) : undefined;
        if (nameMatch && !["exact", "substring", "regex"].includes(nameMatch)) throw new DaytonaInputError("nameMatch must be exact, substring, or regex");
        return computer.accessibility.findNodes({ scope: "all", role: args.role ? boundedText(args.role, "role", 60) : undefined, name: args.name ? boundedText(args.name, "name", 200) : undefined, nameMatch, limit: Math.min(Math.max(Math.floor(Number(args.limit ?? 20)), 1), 50) });
      }
      case "accessibility_focus": await computer.accessibility.focusNode(boundedText(args.nodeId, "nodeId", 200)); return { focused: true };
      case "accessibility_invoke": await computer.accessibility.invokeNode(boundedText(args.nodeId, "nodeId", 200), args.nodeAction ? boundedText(args.nodeAction, "nodeAction", 80) : undefined); return { invoked: true };
      case "accessibility_set_value": await computer.accessibility.setNodeValue(boundedText(args.nodeId, "nodeId", 200), boundedText(args.value, "value", 4000)); return { updated: true };
      default: throw new DaytonaInputError(`Unsupported computer action: ${action}`);
    }
  }

  async pty(userId: number, args: Record<string, unknown>): Promise<DaytonaPtyResult> {
    const action = boundedText(args.action, "action", 20);
    const stored = await getDaytonaWorkspace(userId);
    const sandbox = await this.getOrCreateWorkspace(userId);
    const known = new Set((stored?.ptySessions ?? []).map((session) => session.id));
    const requestedId = args.id ? boundedText(args.id, "id", 120) : undefined;
    const ensureOwned = () => {
      if (!requestedId || !known.has(requestedId)) throw new DaytonaInputError("PTY session not found or not owned by you");
      return requestedId;
    };
    const saveSessions = async (sessions: Array<{ id: string; createdAt: number }>) => {
      const current = await getDaytonaWorkspace(userId);
      if (current) await saveDaytonaWorkspace(userId, { ...current, ptySessions: sessions, updatedAt: Date.now() });
    };

    if (action === "status") {
      const sessions = await sandbox.process.listPtySessions();
      return { sandboxId: sandbox.id, sessionId: "", sessions: sessions.filter((session) => known.has(session.id)) };
    }
    if (action === "create") {
      const id = requestedId ?? `chusky-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (known.has(id)) throw new DaytonaInputError("A PTY session with that id already exists");
      const output = collectPtyOutput();
      const handle = await sandbox.process.createPty({ id, cwd: args.cwd ? safeDaytonaPath(args.cwd, "cwd") : undefined, cols: boundedNumber(args.cols, 120, 300), rows: boundedNumber(args.rows, 30, 200), onData: output.onData });
      await handle.waitForConnection();
      await brieflyCollect(handle);
      await handle.disconnect();
      await saveSessions([...((await getDaytonaWorkspace(userId))?.ptySessions ?? []), { id, createdAt: Date.now() }]);
      return { sandboxId: sandbox.id, sessionId: id, output: output.chunks.join("").slice(-DAYTONA_MAX_PTY_OUTPUT), created: true };
    }
    const id = ensureOwned();
    if (action === "resize") {
      await sandbox.process.resizePtySession(id, boundedNumber(args.cols, 120, 300), boundedNumber(args.rows, 30, 200));
      return { sandboxId: sandbox.id, sessionId: id };
    }
    if (action === "kill") {
      await sandbox.process.killPtySession(id);
      await saveSessions((await getDaytonaWorkspace(userId))?.ptySessions?.filter((session) => session.id !== id) ?? []);
      return { sandboxId: sandbox.id, sessionId: id, killed: true };
    }
    if (action !== "read" && action !== "write") throw new DaytonaInputError(`Unsupported PTY action: ${action}`);
    const output = collectPtyOutput();
    const handle = await sandbox.process.connectPty(id, { onData: output.onData });
    try {
      await handle.waitForConnection();
      if (action === "write") await handle.sendInput(boundedText(args.input, "input", 8000));
      await brieflyCollect(handle, action === "write" ? 400 : 250);
    } finally {
      await handle.disconnect();
    }
    return { sandboxId: sandbox.id, sessionId: id, output: output.chunks.join("").slice(-DAYTONA_MAX_PTY_OUTPUT) };
  }

  async git(userId: number, args: Record<string, unknown>): Promise<DaytonaGitResult> {
    const action = boundedText(args.action, "action", 30);
    const sandbox = await this.getOrCreateWorkspace(userId);
    const path = safeDaytonaPath(args.path ?? "workspace/repo", "path");
    const git = sandbox.git;
    let result: unknown;
    switch (action) {
      case "clone": {
        const url = boundedText(args.repoUrl, "repoUrl", 500);
        if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?:\/)?$/i.test(url)) throw new DaytonaInputError("repoUrl must be an HTTPS GitHub repository URL without embedded credentials");
        await git.clone(url, path, args.branch ? boundedText(args.branch, "branch", 200) : undefined, undefined, undefined, undefined, false, 50);
        result = { cloned: true, url };
        break;
      }
      case "status": result = await git.status(path); break;
      case "branches": result = await git.branches(path); break;
      case "create_branch": await git.createBranch(path, boundedText(args.branch, "branch", 200)); result = { created: true }; break;
      case "checkout": await git.checkoutBranch(path, boundedText(args.branch, "branch", 200)); result = { checkedOut: true }; break;
      case "pull": await git.pull(path, undefined, undefined, args.branch ? boundedText(args.branch, "branch", 200) : undefined, args.remote ? boundedText(args.remote, "remote", 100) : undefined); result = { pulled: true }; break;
      case "add": {
        const files = Array.isArray(args.files) && args.files.length ? args.files.map((file) => safeDaytonaPath(file, "file")) : ["."];
        await git.add(path, files); result = { staged: files };
        break;
      }
      case "commit": result = await git.commit(path, boundedText(args.message, "message", 500), boundedText(args.author ?? "Chusky", "author", 120), boundedText(args.email ?? "chusky@localhost", "email", 200)); break;
      case "push": await git.push(path, undefined, undefined, args.branch ? boundedText(args.branch, "branch", 200) : undefined, args.remote ? boundedText(args.remote, "remote", 100) : undefined, true); result = { pushed: true }; break;
      default: throw new DaytonaInputError(`Unsupported Git action: ${action}`);
    }
    return { sandboxId: sandbox.id, path, action, result };
  }

  async browser(userId: number, args: Record<string, unknown>): Promise<unknown> {
    const action = boundedText(args.action, "action", 20);
    const sandbox = await this.getOrCreateWorkspace(userId);
    if (action === "status") {
      const stored = await getDaytonaWorkspace(userId);
      return { sandboxId: sandbox.id, lastUrl: stored?.browser?.lastUrl, computer: await this.computer(userId, { action: "status" }), windows: await this.computer(userId, { action: "windows" }) };
    }
    if (action === "open") {
      const url = boundedText(args.url, "url", 2000);
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new DaytonaInputError("Browser URL must be a valid http(s) URL"); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new DaytonaInputError("Browser URL must use http:// or https://");
      if (parsed.username || parsed.password) throw new DaytonaInputError("Browser URLs cannot contain embedded credentials");
      await this.computer(userId, { action: "keyboard_hotkey", keys: "CTRL+L" });
      await this.computer(userId, { action: "keyboard_type", text: url });
      await this.computer(userId, { action: "keyboard_press", key: "ENTER" });
      const current = await getDaytonaWorkspace(userId);
      if (current) await saveDaytonaWorkspace(userId, { ...current, browser: { lastUrl: parsed.toString(), updatedAt: Date.now() }, updatedAt: Date.now() });
      return { sandboxId: sandbox.id, opened: url };
    }
    if (action === "snapshot") {
      return { sandboxId: sandbox.id, accessibility: await this.computer(userId, { action: "accessibility_tree", scope: "focused", maxDepth: boundedNumber(args.maxDepth, 6, 10) }) };
    }
    if (action === "find") {
      return { sandboxId: sandbox.id, matches: await this.computer(userId, { action: "accessibility_find", role: args.role, name: args.name, nameMatch: args.nameMatch, limit: boundedNumber(args.limit, 20, 50) }) };
    }
    if (action === "focus") return this.computer(userId, { action: "accessibility_focus", nodeId: args.nodeId });
    if (action === "invoke") return this.computer(userId, { action: "accessibility_invoke", nodeId: args.nodeId, nodeAction: args.nodeAction });
    if (action === "fill") return this.computer(userId, { action: "accessibility_set_value", nodeId: args.nodeId, value: args.value ?? args.text });
    if (action === "windows") return this.computer(userId, { action: "windows" });
    if (action === "screenshot") return this.computer(userId, { action: "screenshot", showCursor: false });
    if (action === "click") return this.computer(userId, { action: "mouse_click", x: args.x, y: args.y, button: "left" });
    if (action === "type") return this.computer(userId, { action: "keyboard_type", text: args.text, delayMs: 0 });
    if (action === "press") return this.computer(userId, { action: "keyboard_press", key: args.key, modifiers: Array.isArray(args.modifiers) ? args.modifiers : [] });
    if (action === "scroll") return this.computer(userId, { action: "mouse_scroll", x: args.x ?? 500, y: args.y ?? 400, direction: args.direction, amount: args.amount ?? 3 });
    if (action === "back" || action === "forward" || action === "refresh") {
      const key = action === "back" ? "ALT+LEFT" : action === "forward" ? "ALT+RIGHT" : "CTRL+R";
      return this.computer(userId, { action: "keyboard_hotkey", keys: key });
    }
    throw new DaytonaInputError(`Unsupported browser action: ${action}`);
  }

  private async saveArtifact(userId: number, artifact: ArtifactRecord): Promise<void> {
    const session = await getSession(userId);
    session.artifacts = [...(session.artifacts ?? []).filter((item) => item.id !== artifact.id), artifact].slice(-100);
    await saveSession(userId, session);
  }

  private async validateArtifactStructure(sandbox: Sandbox, path: string, type: ArtifactType): Promise<void> {
    if (!STRUCTURED_ARTIFACT_TYPES.has(type)) return;
    const script = artifactValidationScript(type, path);
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const result = await sandbox.process.executeCommand(`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`, undefined, undefined, 120);
    if (result.exitCode !== 0) {
      throw new DaytonaInputError(`${type.toUpperCase()} validation failed: ${String(result.result ?? "unknown validation error").slice(0, 500)}`);
    }
  }

  private async validateArtifactVisual(sandbox: Sandbox, path: string, type: ArtifactType): Promise<void> {
    if (!STRUCTURED_ARTIFACT_TYPES.has(type)) return;
    const script = artifactVisualQaScript(type, path);
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const result = await sandbox.process.executeCommand(`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`, undefined, undefined, 180);
    if (result.exitCode !== 0) {
      throw new DaytonaInputError(`${type.toUpperCase()} visual QA failed: ${String(result.result ?? "unknown rendering error").slice(0, 500)}`);
    }
  }

  async createPresentation(userId: number, args: Record<string, unknown>): Promise<ArtifactRecord & { __chuskyArtifactReady: true; generated: true; slideCount: number }> {
    const title = presentationText(args.title, "title", 200, true)!;
    const slides = presentationSlides(args.slides);
    const requestedPath = args.path === undefined
      ? `artifacts/${artifactNameForType(`${title.slice(0, 70).replace(/\s+/g, "_") || "presentation"}`, "presentation")}`
      : safeDaytonaPath(args.path, "path");
    const path = requestedPath.toLowerCase().endsWith(".pptx") ? requestedPath : `${requestedPath}.pptx`;
    const sandbox = await this.getOrCreateWorkspace(userId);
    const bytes = await presentationBytes(sandbox, title, slides);
    await sandbox.fs.uploadFile(bytes, path);
    const result = await this.registerArtifact(userId, sandbox, path, String(args.name ?? path.split("/").pop() ?? "presentation.pptx"), "presentation", ARTIFACT_MIME.presentation);
    return { ...result, generated: true, slideCount: slides.length + 1 };
  }

  async artifact(userId: number, args: Record<string, unknown>): Promise<unknown> {
    const action = boundedText(args.action, "action", 20);
    const session = await getSession(userId);
    const artifacts = session.artifacts ?? [];
    if (action === "list") return artifacts.slice(-100).reverse();
    if (action === "get" || action === "delete") {
      const id = boundedText(args.id, "id", 120);
      const existing = artifacts.find((item) => item.id === id);
      if (!existing) throw new DaytonaInputError("Artifact not found or not owned by you");
      if (action === "get") return existing;
      if (args.removeFile === true) {
        const sandbox = await this.getOrCreateWorkspace(userId);
        await sandbox.fs.deleteFile(existing.path, false);
      }
      session.artifacts = artifacts.filter((item) => item.id !== id);
      await saveSession(userId, session);
      return { id, deleted: true, fileRemoved: args.removeFile === true };
    }
    const sandbox = await this.getOrCreateWorkspace(userId);
    if (action === "package") {
      const files = Array.isArray(args.files) ? args.files.map((file) => safeDaytonaPath(file, "file")) : [];
      if (!files.length || files.length > 100) throw new DaytonaInputError("files must contain 1-100 workspace-relative paths");
      const name = artifactNameForType(args.name ?? "chusky-project.zip", "zip");
      const path = safeDaytonaPath(`artifacts/${name}`, "output path");
      const script = `import zipfile\nz=zipfile.ZipFile(${JSON.stringify(path)},'w',zipfile.ZIP_DEFLATED)\n[z.write(p) for p in ${JSON.stringify(files)}]\nz.close()`;
      const encoded = Buffer.from(script, "utf8").toString("base64");
      const result = await sandbox.process.executeCommand(`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`, undefined, undefined, 120);
      if (result.exitCode !== 0) throw new DaytonaInputError(`ZIP creation failed: ${String(result.result ?? "unknown error").slice(0, 500)}`);
      return this.registerArtifact(userId, sandbox, path, name, "zip", "application/zip");
    }
    const type = artifactType(args.type);
    if (action === "create") {
      if (args.path) {
        const path = safeDaytonaPath(args.path, "path");
        return this.registerArtifact(userId, sandbox, path, String(args.name ?? String(path).split(/[\\/]/).pop() ?? "artifact"), type, args.contentType ? boundedText(args.contentType, "contentType", 120) : ARTIFACT_MIME[type]);
      }
      if (typeof args.content !== "string") throw new DaytonaInputError("create requires content for text artifacts or path for generated binary artifacts");
      if (!["website", "report"].includes(type)) throw new DaytonaInputError("Binary artifacts must be generated in Daytona and passed by path; only website and report accept text content directly");
      if (args.content.length > DAYTONA_MAX_FILE_CONTENT) throw new DaytonaInputError(`content must be at most ${DAYTONA_MAX_FILE_CONTENT} characters`);
      const name = artifactNameForType(args.name ?? (type === "website" ? "website.html" : "report.md"), type);
      const path = safeDaytonaPath(`artifacts/${name}`, "output path");
      await sandbox.fs.uploadFile(Buffer.from(args.content, "utf8"), path);
      return this.registerArtifact(userId, sandbox, path, name, type, args.contentType ? boundedText(args.contentType, "contentType", 120) : ARTIFACT_MIME[type]);
    }
    if (action === "register") {
      const path = safeDaytonaPath(args.path, "path");
      return this.registerArtifact(userId, sandbox, path, String(args.name ?? String(path).split(/[\\/]/).pop() ?? "artifact"), type, args.contentType ? boundedText(args.contentType, "contentType", 120) : ARTIFACT_MIME[type]);
    }
    throw new DaytonaInputError(`Unsupported artifact action: ${action}`);
  }

  private async registerArtifact(userId: number, sandbox: Sandbox, path: string, name: string, type: ArtifactType, contentType: string): Promise<ArtifactRecord & { __chuskyArtifactReady: true }> {
    const extension = `.${ARTIFACT_EXTENSION[type]}`;
    const normalizedPath = path.toLowerCase().endsWith(extension) ? path : `${path}${extension}`;
    if (normalizedPath !== path) await sandbox.fs.moveFiles(path, normalizedPath);
    const normalizedName = artifactNameForType(name, type);
    let details: { size?: number; isDir?: boolean };
    try {
      details = await sandbox.fs.getFileDetails(normalizedPath) as { size?: number; isDir?: boolean };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found|no such file|does not exist/i.test(message)) {
        throw new DaytonaInputError(`Artifact file was not found at '${normalizedPath}'. Generate the file in Daytona and verify that exact path before registering it.`);
      }
      throw error;
    }
    const size = Number(details.size ?? 0);
    if (details.isDir) throw new DaytonaInputError("Artifact path must be a file, not a directory");
    if (!Number.isFinite(size) || size < 1 || size > DAYTONA_MAX_ARTIFACT_BYTES) throw new DaytonaInputError(`Artifact must be between 1 byte and ${DAYTONA_MAX_ARTIFACT_BYTES} bytes`);
    await this.validateArtifactStructure(sandbox, normalizedPath, type);
    await this.validateArtifactVisual(sandbox, normalizedPath, type);
    const now = Date.now();
    const artifact: ArtifactRecord = { id: `artifact_${randomUUID()}`, userId, sandboxId: sandbox.id, name: normalizedName, type, path: normalizedPath, contentType, size, status: "available", createdAt: now, updatedAt: now };
    await this.saveArtifact(userId, artifact);
    return { ...artifact, __chuskyArtifactReady: true };
  }

  async downloadArtifact(userId: number, id: string): Promise<DaytonaArtifactDelivery> {
    const artifact = (await getSession(userId)).artifacts?.find((item) => item.id === id);
    if (!artifact) throw new DaytonaInputError("Artifact not found or not owned by you");
    const bytes = await (await this.getOrCreateWorkspace(userId)).fs.downloadFile(artifact.path);
    if (bytes.length > DAYTONA_MAX_ARTIFACT_BYTES) throw new DaytonaInputError("Artifact is too large to deliver through Telegram");
    return { id: artifact.id, name: artifact.name, type: artifact.type, path: artifact.path, contentType: artifact.contentType, size: bytes.length, data: bytes };
  }

  async deleteWorkspace(userId: number): Promise<{ sandboxId: string; deleted: boolean }> {
    const stored = await getDaytonaWorkspace(userId);
    if (!stored) throw new DaytonaInputError("No Daytona workspace exists.");
    const sandbox = await this.clientFactory().get(stored.sandboxId);
    await sandbox.delete(60, true);
    await clearDaytonaWorkspace(userId);
    return { sandboxId: stored.sandboxId, deleted: true };
  }

  async pause(userId: number): Promise<{ paused: boolean; sandboxId: string }> {
    const sandbox = await this.getSandbox(userId);
    if (!sandbox) throw new DaytonaInputError("No Daytona workspace exists.");
    await sandbox.pause(60);
    return { paused: true, sandboxId: sandbox.id };
  }
}

export const daytonaEngine = new DaytonaEngine();
