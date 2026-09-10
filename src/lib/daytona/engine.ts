import { DaytonaProcessExecutionTimeoutError, type FileInfo, type Sandbox, type PtyHandle } from "@daytona/sdk";
import { randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
import { AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, ImageRun, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { config } from "../../config.js";
import { guardVaultBrowserAction, rememberVaultBrowserNodes } from "../../vault/browserGuard.js";
import { clearDaytonaWorkspace, getDaytonaWorkspace, getSession, saveDaytonaWorkspace, saveSession, type ArtifactRecord, type ArtifactType, type DaytonaAppCheck, type DaytonaAppFramework, type DaytonaAppRecord, type DaytonaAppVerification } from "../../store.js";
import { DaytonaInputError } from "./errors.js";
import { artifactVisualQaScript } from "./artifactQa.js";
import { artifactRendererImage } from "./renderer.js";
import { getDaytonaClient } from "./client.js";
import type { DaytonaAppResult, DaytonaArtifactDelivery, DaytonaCommandResult, DaytonaFileInfo, DaytonaGitResult, DaytonaPreviewResult, DaytonaPtyResult, DaytonaScreenshotResult, DaytonaSnapshotResult, DaytonaWorkspaceInfo } from "./types.js";

const createPromises = new Map<number, Promise<Sandbox>>();
const configuredAutoPauseMinutes = Number.parseInt(config.daytonaAutoPauseInterval, 10);
// Daytona rejects autoPauseInterval for container sandboxes. Keep it disabled
// by default and let deployments opt in after choosing a pausable target.
const DAYTONA_AUTO_PAUSE_MINUTES = Number.isInteger(configuredAutoPauseMinutes) && configuredAutoPauseMinutes > 0
  ? configuredAutoPauseMinutes
  : 0;
const DAYTONA_MAX_COMMAND_LENGTH = 64000;
const DAYTONA_MAX_OUTPUT_CHARS = 12000;
const DAYTONA_MAX_FILE_CONTENT = 48000;
const DAYTONA_MAX_PTY_OUTPUT = 12000;
const DAYTONA_MAX_ARTIFACT_BYTES = 45 * 1024 * 1024;
const DAYTONA_MAX_EXECUTION_SECONDS = 900;
const DAYTONA_PREVIEW_MIN_SECONDS = 60;
const DAYTONA_PREVIEW_MAX_SECONDS = 24 * 60 * 60;
const APP_SCAFFOLD_MAX_REGISTRY_ATTEMPTS = 3;
const TRANSIENT_NPM_REGISTRY_FAILURE = /\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|getaddrinfo)\b|network\s+(?:request|error)/i;
const DAYTONA_TIER_NETWORK_RESTRICTION = /network access is restricted and cannot be overridden|tier[- ]based network restriction/i;
const DAYTONA_TRANSIENT_COMPUTER_CONNECTION = /unexpected eof|connection is shut down|failed to start computer use|connection reset|transport.*closed/i;

function isTransientComputerConnection(error: unknown): boolean {
  return DAYTONA_TRANSIENT_COMPUTER_CONNECTION.test(String((error as { message?: unknown })?.message ?? error));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * New sandboxes occasionally resolve registry.npmjs.org before their DNS is
 * ready. Retry only known transient network failures and clean only the
 * validated, not-yet-registered app directory between attempts.
 */
export function appScaffoldCommand(framework: DaytonaAppFramework, id: string): string {
  const appPath = `workspace/apps/${id}`;
  const scaffold = framework === "vite-react"
    ? `mkdir -p workspace/apps && cd workspace/apps && npm create vite@latest ${id} -- --template react-ts && cd ${id} && npm install`
    : `mkdir -p workspace/apps && npx --yes create-next-app@latest ${id} --yes --use-npm && cd ${id} && npm install`;
  return [
    "set +e",
    "attempt=1",
    "log=/tmp/chusky-app-scaffold.log",
    `while [ \"$attempt\" -le ${APP_SCAFFOLD_MAX_REGISTRY_ATTEMPTS} ]; do`,
    `  rm -rf \"${appPath}\"`,
    `  ( NPM_CONFIG_FETCH_RETRIES=2 NPM_CONFIG_FETCH_RETRY_FACTOR=2 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=1000 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=8000 ${scaffold} ) >\"$log\" 2>&1`,
    "  code=$?",
    "  cat \"$log\"",
    "  if [ \"$code\" -eq 0 ]; then exit 0; fi",
    `  if ! grep -Eqi 'EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|getaddrinfo|network[[:space:]]+(request|error)' \"$log\"; then exit \"$code\"; fi`,
    `  if [ \"$attempt\" -ge ${APP_SCAFFOLD_MAX_REGISTRY_ATTEMPTS} ]; then echo \"Temporary npm registry network failure after ${APP_SCAFFOLD_MAX_REGISTRY_ATTEMPTS} attempts.\"; exit \"$code\"; fi`,
    "  sleep $((attempt * 3))",
    "  attempt=$((attempt + 1))",
    "done",
  ].join("\n");
}

function appScaffoldFailure(output: string): string {
  if (TRANSIENT_NPM_REGISTRY_FAILURE.test(output)) {
    return "App scaffold could not reach the npm registry after bounded automatic retries. This is a temporary Daytona network/DNS issue; retry scaffold later. The incomplete app directory was safely removed before each retry.";
  }
  return `App scaffold failed: ${output.slice(-800)}`;
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export function safeDaytonaPath(value: unknown, label = "path"): string {
  let path = String(value ?? "").trim();
  const daytonaHome = "/home/user/";
  if (path.toLowerCase().startsWith(daytonaHome)) path = path.slice(daytonaHome.length);
  if (path.toLowerCase().startsWith("home/user/")) path = path.slice("home/user/".length);
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

function isDaytonaConflict(error: unknown): boolean {
  const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  const message = String(candidate?.message ?? error ?? "");
  return candidate?.statusCode === 409 || candidate?.code === "CONFLICT" || /already exists|conflict/i.test(message);
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
    "path=os.path.abspath(path)",
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
    "                    # A leading slash means an OOXML package-root target;",
    "                    # otherwise the target is relative to the .rels source.",
    "                    target_path=posixpath.normpath(target.lstrip('/')) if target.startswith('/') else posixpath.normpath(posixpath.join(source_dir, target))",
    "                    if target_path.startswith('../') or target_path not in names:",
    "                        fail('OOXML relationship target is missing: ' + rels_name + ' -> ' + target)",
    "            if kind == 'presentation':",
    "                presentation=ET.fromstring(archive.read('ppt/presentation.xml'))",
    "                slide_ids=[node for node in presentation.iter() if node.tag.endswith('}sldId')]",
    "                if not slide_ids: fail('Presentation contains no slides')",
    "            if kind == 'spreadsheet':",
    "                workbook=ET.fromstring(archive.read('xl/workbook.xml'))",
    "                sheets=[node for node in workbook.iter() if node.tag.endswith('}sheet')]",
    "                if not sheets: fail('Spreadsheet contains no worksheets')",
    "                # Formula errors indicate a workbook that opens but is not usable.",
    "                for name in names:",
    "                    if name.startswith('xl/') and name.lower().endswith('.xml'):",
    "                        xml_text=archive.read(name).decode('utf-8', 'ignore').upper()",
    "                        for marker in ('#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#NUM!'):",
    "                            if marker in xml_text: fail('Spreadsheet contains formula error ' + marker + ' in ' + name)",
    "            if kind == 'docx':",
    "                document=ET.fromstring(archive.read('word/document.xml'))",
    "                body=[node for node in document.iter() if node.tag.endswith('}body')]",
    "                if not body: fail('DOCX contains no document body')",
    "    except (KeyError, ET.ParseError, OSError) as error:",
    "        fail('Office Open XML package contains invalid XML: ' + str(error))",
    "print('artifact structure validated')",
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
  imageAltTexts?: string[];
  imageFit?: "contain" | "cover";
  backgroundImagePath?: string;
  backgroundImageAltText?: string;
  overlayColor?: string;
  overlayOpacity?: number;
  textColor?: string;
  table?: string[][];
  chart?: { categories: string[]; series: Array<{ name: string; values: number[] }> };
  layout?: PresentationLayout;
  eyebrow?: string;
  accent?: string;
  quote?: string;
  metrics?: Array<{ label: string; value: string; detail?: string }>;
  notes?: string;
};

type PresentationLayout = "auto" | "title" | "section" | "two_column" | "hero" | "metrics" | "comparison" | "timeline" | "image_focus" | "background" | "chart" | "table" | "quote" | "closing";

type PresentationStyle = {
  preset: "executive" | "modern" | "bold" | "minimal" | "brand";
  primary: string;
  accent: string;
  secondary: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  fontFace: string;
  headingFontFace: string;
  footer?: string;
  includeSlideNumbers: boolean;
  logoPath?: string;
};

type PdfSectionInput = {
  heading?: string;
  body?: string;
  bullets?: string[];
  table?: string[][];
  /** Relative table column weights, for example [1, 3, 1]. */
  columnWidths?: number[];
  imagePath?: string;
  imageAltText?: string;
  imageWidth?: number;
  chart?: { categories: string[]; series: Array<{ name: string; values: number[] }> };
  pageBreakBefore?: boolean;
};

type PdfStyleInput = {
  pageSize: "A4" | "LETTER" | "LEGAL";
  margin: number;
  preset: "executive" | "modern" | "bold" | "minimal" | "brand";
  fontFamily: "sans" | "serif" | "mono";
  fontName: string;
  fontBold: string;
  fontItalic: string;
  monoFont: string;
  primary: string;
  accent: string;
  text: string;
  muted: string;
  fontSize: number;
  header?: string;
  footer?: string;
  includePageNumbers: boolean;
  author?: string;
  logoPath?: string;
};

/** Shared company identity. Format-specific style fields still take precedence. */
type BrandInput = {
  companyName?: string;
  tagline?: string;
  logoPath?: string;
  header?: string;
  footer?: string;
  preset?: "executive" | "modern" | "bold" | "minimal" | "brand";
  primary?: string;
  accent?: string;
  secondary?: string;
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  fontFamily?: "sans" | "serif" | "mono";
};

type DocumentSectionInput = PdfSectionInput;
type SpreadsheetSheetInput = { name: string; rows: string[][]; tabColor?: string };

function brandInput(value: unknown): BrandInput {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const preset = input.preset === undefined ? undefined : String(input.preset).toLowerCase();
  if (preset !== undefined && !(preset in PDF_STYLE_PRESETS)) throw new DaytonaInputError("brand.preset must be executive, modern, bold, minimal, or brand");
  const fontFamily = input.fontFamily === undefined ? undefined : String(input.fontFamily).toLowerCase();
  if (fontFamily !== undefined && !(fontFamily in PDF_FONT_FAMILIES)) throw new DaytonaInputError("brand.fontFamily must be sans, serif, or mono");
  const text = (key: keyof BrandInput, max = 180) => {
    const value = input[key];
    // Optional brand fields are often emitted as an empty string by the
    // model. Treat that exactly like an omitted field; non-empty values still
    // receive the normal length/content validation.
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
    return presentationText(value, `brand.${key}`, max, true);
  };
  const logoPath = text("logoPath", 500);
  return {
    ...(text("companyName") ? { companyName: text("companyName") } : {}),
    ...(text("tagline") ? { tagline: text("tagline") } : {}),
    ...(logoPath ? { logoPath: safeDaytonaPath(logoPath) } : {}),
    ...(text("header") ? { header: text("header") } : {}),
    ...(text("footer") ? { footer: text("footer") } : {}),
    ...(preset === undefined ? {} : { preset: preset as BrandInput["preset"] }),
    ...(fontFamily === undefined ? {} : { fontFamily: fontFamily as BrandInput["fontFamily"] }),
    ...Object.fromEntries(["primary", "accent", "secondary", "background", "surface", "text", "muted"].filter((key) => input[key] !== undefined).map((key) => [key, presentationColor(input[key], `brand.${key}`, "000000")])) as Partial<BrandInput>,
  };
}

function mergeBrandStyle(style: unknown, brand: BrandInput): Record<string, unknown> {
  const explicit = style && typeof style === "object" && !Array.isArray(style) ? style as Record<string, unknown> : {};
  const identity: Record<string, unknown> = {
    ...(brand.preset ? { preset: brand.preset } : {}),
    ...(brand.primary ? { primary: brand.primary } : {}),
    ...(brand.accent ? { accent: brand.accent } : {}),
    ...(brand.secondary ? { secondary: brand.secondary } : {}),
    ...(brand.background ? { background: brand.background } : {}),
    ...(brand.surface ? { surface: brand.surface } : {}),
    ...(brand.text ? { text: brand.text } : {}),
    ...(brand.muted ? { muted: brand.muted } : {}),
    ...(brand.logoPath ? { logoPath: brand.logoPath } : {}),
    ...(brand.header || brand.companyName ? { header: brand.header ?? brand.companyName } : {}),
    ...(brand.footer || brand.tagline ? { footer: brand.footer ?? brand.tagline } : {}),
    ...(brand.fontFamily ? { fontFamily: brand.fontFamily } : {}),
  };
  return { ...identity, ...explicit };
}

const PDF_STYLE_PRESETS: Record<PdfStyleInput["preset"], Pick<PdfStyleInput, "primary" | "accent" | "text" | "muted">> = {
  executive: { primary: "123B5D", accent: "0F766E", text: "243B53", muted: "52606D" },
  modern: { primary: "312E81", accent: "DB2777", text: "1F2937", muted: "64748B" },
  bold: { primary: "111827", accent: "F97316", text: "1F2937", muted: "475569" },
  minimal: { primary: "334155", accent: "2563EB", text: "0F172A", muted: "64748B" },
  brand: { primary: "0F766E", accent: "0284C7", text: "142337", muted: "496580" },
};

const PDF_FONT_FAMILIES: Record<PdfStyleInput["fontFamily"], Pick<PdfStyleInput, "fontName" | "fontBold" | "fontItalic" | "monoFont">> = {
  sans: { fontName: "Helvetica", fontBold: "Helvetica-Bold", fontItalic: "Helvetica-Oblique", monoFont: "Courier" },
  serif: { fontName: "Times-Roman", fontBold: "Times-Bold", fontItalic: "Times-Italic", monoFont: "Courier" },
  mono: { fontName: "Courier", fontBold: "Courier-Bold", fontItalic: "Courier-Oblique", monoFont: "Courier" },
};

const PRESENTATION_LAYOUTS = new Set<PresentationLayout>([
  "auto", "title", "section", "two_column", "hero", "metrics", "comparison", "timeline", "image_focus", "background", "chart", "table", "quote", "closing",
]);

const PRESENTATION_STYLE_PRESETS: Record<PresentationStyle["preset"], Omit<PresentationStyle, "preset" | "footer" | "includeSlideNumbers" | "logoPath">> = {
  executive: { primary: "102A43", accent: "0F766E", secondary: "2563EB", background: "F7FAFC", surface: "E6FFFA", text: "102A43", muted: "52606D", fontFace: "Aptos", headingFontFace: "Aptos Display" },
  modern: { primary: "312E81", accent: "DB2777", secondary: "0891B2", background: "FAFAFF", surface: "EEF2FF", text: "1F2937", muted: "64748B", fontFace: "Aptos", headingFontFace: "Aptos Display" },
  bold: { primary: "111827", accent: "F97316", secondary: "14B8A6", background: "F8FAFC", surface: "FFF7ED", text: "111827", muted: "475569", fontFace: "Aptos", headingFontFace: "Aptos Display" },
  minimal: { primary: "334155", accent: "2563EB", secondary: "64748B", background: "FFFFFF", surface: "F1F5F9", text: "0F172A", muted: "64748B", fontFace: "Aptos", headingFontFace: "Aptos Display" },
  brand: { primary: "0F766E", accent: "0284C7", secondary: "EA580C", background: "F8FAFC", surface: "ECFEFF", text: "142337", muted: "496580", fontFace: "Aptos", headingFontFace: "Aptos Display" },
};

function presentationColor(value: unknown, label: string, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new DaytonaInputError(`${label} must be a six-digit hex color`);
  const color = value.trim().replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(color)) throw new DaytonaInputError(`${label} must be a six-digit hex color`);
  return color;
}

function presentationOpacity(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const opacity = Number(value);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) throw new DaytonaInputError(`${label} must be a number from 0 to 100`);
  return opacity;
}

function presentationImageFit(value: unknown, index: number): "contain" | "cover" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const fit = String(value).toLowerCase();
  if (fit !== "contain" && fit !== "cover") throw new DaytonaInputError(`slides[${index}].imageFit must be contain or cover`);
  return fit;
}

function presentationColorLuminance(color: string): number {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255).map((channel) => channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4));
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function presentationStyle(value: unknown): PresentationStyle {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const requestedPreset = input.preset === undefined ? "executive" : String(input.preset).toLowerCase();
  if (!(requestedPreset in PRESENTATION_STYLE_PRESETS)) throw new DaytonaInputError("style.preset must be executive, modern, bold, minimal, or brand");
  const preset = requestedPreset as PresentationStyle["preset"];
  const defaults = PRESENTATION_STYLE_PRESETS[preset];
  const fontFamily = input.fontFamily === undefined ? undefined : String(input.fontFamily).toLowerCase();
  if (fontFamily !== undefined && !(fontFamily in PDF_FONT_FAMILIES)) throw new DaytonaInputError("style.fontFamily must be sans, serif, or mono");
  const familyFonts = fontFamily === "serif" ? { body: "Georgia", heading: "Georgia" } : fontFamily === "mono" ? { body: "Cascadia Mono", heading: "Cascadia Mono" } : undefined;
  const fontFace = input.fontFace === undefined ? (familyFonts?.body ?? defaults.fontFace) : presentationText(input.fontFace, "style.fontFace", 80, true)!;
  const headingFontFace = input.headingFontFace === undefined ? (familyFonts?.heading ?? defaults.headingFontFace) : presentationText(input.headingFontFace, "style.headingFontFace", 80, true)!;
  const footer = input.footer === undefined ? undefined : presentationText(input.footer, "style.footer", 160);
  const logoPath = input.logoPath === undefined ? undefined : safeDaytonaPath(presentationText(input.logoPath, "style.logoPath", 500, true)!);
  return {
    preset,
    primary: presentationColor(input.primary, "style.primary", defaults.primary),
    accent: presentationColor(input.accent, "style.accent", defaults.accent),
    secondary: presentationColor(input.secondary, "style.secondary", defaults.secondary),
    background: presentationColor(input.background, "style.background", defaults.background),
    surface: presentationColor(input.surface, "style.surface", defaults.surface),
    text: presentationColor(input.text, "style.text", defaults.text),
    muted: presentationColor(input.muted, "style.muted", defaults.muted),
    fontFace,
    headingFontFace,
    footer,
    includeSlideNumbers: input.includeSlideNumbers === undefined ? true : input.includeSlideNumbers === true,
    logoPath,
  };
}

function presentationLayout(value: unknown, index: number): PresentationLayout {
  if (value === undefined || value === null || value === "") return "auto";
  const layout = String(value).toLowerCase() as PresentationLayout;
  if (!PRESENTATION_LAYOUTS.has(layout)) throw new DaytonaInputError(`slides[${index}].layout must be one of ${Array.from(PRESENTATION_LAYOUTS).join(", ")}`);
  return layout;
}

function presentationMetrics(value: unknown, index: number): PresentationSlideInput["metrics"] {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new DaytonaInputError(`slides[${index}].metrics must contain 1-4 metrics`);
  return value.map((raw, metricIndex) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DaytonaInputError(`slides[${index}].metrics[${metricIndex}] must be an object`);
    const metric = raw as Record<string, unknown>;
    return {
      label: presentationText(metric.label, `slides[${index}].metrics[${metricIndex}].label`, 80, true)!,
      value: presentationText(metric.value, `slides[${index}].metrics[${metricIndex}].value`, 80, true)!,
      detail: presentationText(metric.detail, `slides[${index}].metrics[${metricIndex}].detail`, 160),
    };
  });
}

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

function pdfTable(value: unknown, label: string): string[][] | undefined {
  if (value === undefined || value === null) return undefined;
  let rows: unknown[];
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    rows = value;
  } else if (typeof value === "object") {
    const table = value as Record<string, unknown>;
    const headers = table.headers;
    const body = table.rows;
    if (headers !== undefined && !Array.isArray(headers)) throw new DaytonaInputError(`${label}.headers must be an array`);
    if (body !== undefined && !Array.isArray(body)) throw new DaytonaInputError(`${label}.rows must be an array`);
    if (headers === undefined && body === undefined) throw new DaytonaInputError(`${label} must be a matrix or { headers, rows } object`);
    rows = [...(headers === undefined ? [] : [headers]), ...(body ?? [])];
  } else {
    throw new DaytonaInputError(`${label} must be a matrix or { headers, rows } object`);
  }
  if (rows.length === 0) return undefined;
  if (rows.length > 100) throw new DaytonaInputError(`${label} must contain at most 100 rows; split large data across sections`);
  const width = Math.max(...rows.map((row) => Array.isArray(row) ? row.length : 0));
  if (width < 1 || width > 12) throw new DaytonaInputError(`${label} rows must contain 1-12 cells`);
  return rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 12) throw new DaytonaInputError(`${label}[${rowIndex}] must contain 1-12 cells`);
    return row.map((cell, cellIndex) => presentationTableCell(cell, `${label}[${rowIndex}][${cellIndex}]`));
  });
}

function pdfChart(value: unknown, label: string): PdfSectionInput["chart"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DaytonaInputError(`${label} must be an object`);
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.categories) || input.categories.length < 1 || input.categories.length > 20 || !Array.isArray(input.series) || input.series.length < 1 || input.series.length > 6) {
    throw new DaytonaInputError(`${label} needs 1-20 categories and 1-6 series`);
  }
  const categories = input.categories.map((item, index) => presentationText(item, `${label}.categories[${index}]`, 100, true)!);
  const series = input.series.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new DaytonaInputError(`${label}.series[${index}] must be an object`);
    const raw = item as Record<string, unknown>;
    if (!Array.isArray(raw.values) || raw.values.length !== categories.length || raw.values.some((number) => typeof number !== "number" || !Number.isFinite(number))) {
      throw new DaytonaInputError(`${label}.series[${index}].values must match category count`);
    }
    return { name: presentationText(raw.name, `${label}.series[${index}].name`, 100, true)!, values: raw.values as number[] };
  });
  return { categories, series };
}

function pdfSections(value: unknown): PdfSectionInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new DaytonaInputError("sections must contain 1-50 section definitions");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DaytonaInputError(`sections[${index}] must be an object`);
    const section = raw as Record<string, unknown>;
    const bullets = section.bullets === undefined ? undefined : Array.isArray(section.bullets)
      ? section.bullets.slice(0, 30).map((item, bulletIndex) => presentationText(item, `sections[${index}].bullets[${bulletIndex}]`, 500, true)!)
      : (() => { throw new DaytonaInputError(`sections[${index}].bullets must be an array`); })();
    const imagePath = section.imagePath === undefined ? undefined : safeDaytonaPath(presentationText(section.imagePath, `sections[${index}].imagePath`, 500, true)!);
    const imageWidth = section.imageWidth === undefined ? undefined : boundedNumber(section.imageWidth, 5.5, 7.0);
    const table = pdfTable(section.table, `sections[${index}].table`);
    const columnWidths = section.columnWidths === undefined ? undefined : Array.isArray(section.columnWidths)
      ? section.columnWidths.map((item, columnIndex) => {
        const width = Number(item);
        if (!Number.isFinite(width) || width <= 0 || width > 100) throw new DaytonaInputError(`sections[${index}].columnWidths[${columnIndex}] must be a number from 0 to 100`);
        return width;
      })
      : (() => { throw new DaytonaInputError(`sections[${index}].columnWidths must be an array of relative widths`); })();
    if (columnWidths && (!table || columnWidths.length !== Math.max(...table.map((row) => row.length)))) throw new DaytonaInputError(`sections[${index}].columnWidths must contain one width for each table column`);
    const chart = pdfChart(section.chart, `sections[${index}].chart`);
    return {
      heading: presentationText(section.heading, `sections[${index}].heading`, 200),
      body: presentationText(section.body, `sections[${index}].body`, 8000),
      bullets,
      table,
      columnWidths,
      imagePath,
      imageAltText: presentationText(section.imageAltText, `sections[${index}].imageAltText`, 300),
      imageWidth,
      chart,
      pageBreakBefore: section.pageBreakBefore === true,
    };
  });
}

function pdfStyle(value: unknown): PdfStyleInput {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const preset = input.preset === undefined ? "executive" : String(input.preset).toLowerCase();
  if (!(preset in PDF_STYLE_PRESETS)) throw new DaytonaInputError("style.preset must be executive, modern, bold, minimal, or brand");
  const fontFamily = input.fontFamily === undefined ? "sans" : String(input.fontFamily).toLowerCase();
  if (!(fontFamily in PDF_FONT_FAMILIES)) throw new DaytonaInputError("style.fontFamily must be sans, serif, or mono");
  const pageSize = input.pageSize === undefined ? "A4" : String(input.pageSize).toUpperCase();
  if (pageSize !== "A4" && pageSize !== "LETTER" && pageSize !== "LEGAL") throw new DaytonaInputError("style.pageSize must be A4, LETTER, or LEGAL");
  const margin = input.margin === undefined ? 0.65 : Number(input.margin);
  if (!Number.isFinite(margin) || margin < 0.35 || margin > 1.25) throw new DaytonaInputError("style.margin must be between 0.35 and 1.25 inches");
  const fontSize = input.fontSize === undefined ? 10.5 : Number(input.fontSize);
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 18) throw new DaytonaInputError("style.fontSize must be between 8 and 18 points");
  const presetColors = PDF_STYLE_PRESETS[preset as PdfStyleInput["preset"]];
  const fonts = PDF_FONT_FAMILIES[fontFamily as PdfStyleInput["fontFamily"]];
  return {
    pageSize: pageSize as PdfStyleInput["pageSize"],
    margin,
    preset: preset as PdfStyleInput["preset"],
    fontFamily: fontFamily as PdfStyleInput["fontFamily"],
    ...fonts,
    primary: presentationColor(input.primary, "style.primary", presetColors.primary),
    accent: presentationColor(input.accent, "style.accent", presetColors.accent),
    text: presentationColor(input.text, "style.text", presetColors.text),
    muted: presentationColor(input.muted, "style.muted", presetColors.muted),
    fontSize,
    ...(input.header === undefined ? {} : { header: presentationText(input.header, "style.header", 180, true) }),
    ...(input.footer === undefined ? { footer: "Created by Chusky" } : { footer: presentationText(input.footer, "style.footer", 180) }),
    includePageNumbers: input.includePageNumbers !== false,
    ...(input.author === undefined ? {} : { author: presentationText(input.author, "style.author", 180) }),
    ...(input.logoPath === undefined ? {} : { logoPath: safeDaytonaPath(presentationText(input.logoPath, "style.logoPath", 500, true)!) }),
  };
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
    const imageAltTexts = slide.imageAltTexts === undefined ? undefined : Array.isArray(slide.imageAltTexts)
      ? slide.imageAltTexts.slice(0, 4).map((item, imageIndex) => presentationText(item, `slides[${index}].imageAltTexts[${imageIndex}]`, 300, true)!)
      : (() => { throw new DaytonaInputError(`slides[${index}].imageAltTexts must be an array`); })();
    const backgroundImagePath = slide.backgroundImagePath === undefined ? undefined : safeDaytonaPath(presentationText(slide.backgroundImagePath, `slides[${index}].backgroundImagePath`, 500, true)!);
    const backgroundImageAltText = slide.backgroundImageAltText === undefined ? undefined : presentationText(slide.backgroundImageAltText, `slides[${index}].backgroundImageAltText`, 300, true);
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
    const layout = presentationLayout(slide.layout, index);
    if (layout === "background" && !backgroundImagePath) throw new DaytonaInputError(`slides[${index}].backgroundImagePath is required when layout is background`);
    if (backgroundImagePath && imagePaths?.length) throw new DaytonaInputError(`slides[${index}] must use backgroundImagePath or imagePaths, not both`);
    return {
      title: presentationText(slide.title, `slides[${index}].title`, 200, true)!,
      body: presentationText(slide.body, `slides[${index}].body`, 2000),
      bullets,
      imagePaths,
      imageAltTexts,
      imageFit: presentationImageFit(slide.imageFit, index),
      backgroundImagePath,
      backgroundImageAltText,
      overlayColor: slide.overlayColor === undefined ? undefined : presentationColor(slide.overlayColor, `slides[${index}].overlayColor`, "0F172A"),
      overlayOpacity: presentationOpacity(slide.overlayOpacity, `slides[${index}].overlayOpacity`, 52),
      textColor: slide.textColor === undefined ? undefined : presentationColor(slide.textColor, `slides[${index}].textColor`, "FFFFFF"),
      table,
      chart,
      layout,
      eyebrow: presentationText(slide.eyebrow, `slides[${index}].eyebrow`, 80),
      accent: slide.accent === undefined ? undefined : presentationColor(slide.accent, `slides[${index}].accent`, "0F766E"),
      quote: presentationText(slide.quote, `slides[${index}].quote`, 1000),
      metrics: presentationMetrics(slide.metrics, index),
      notes: presentationText(slide.notes, `slides[${index}].notes`, 3000),
    };
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

function pdfGenerationScript(title: string, sections: PdfSectionInput[], style: PdfStyleInput, path: string): string {
  const payload = Buffer.from(JSON.stringify({ title, sections, style, path }), "utf8").toString("base64");
  return [
    "import base64, importlib, json, os, re, shutil, subprocess, sys",
    `payload=json.loads(base64.b64decode(${JSON.stringify(payload)}))`,
    "dependency_dir=os.path.abspath(os.path.join('workspace', '.chusky', 'python-reportlab'))",
    "if dependency_dir not in sys.path: sys.path.insert(0, dependency_dir)",
    "def load_reportlab():",
    "    try:",
    "        from reportlab.lib import colors",
    "        return colors",
    "    except ImportError:",
    "        return None",
    "colors=load_reportlab()",
    "if colors is None:",
    "    os.makedirs(dependency_dir, exist_ok=True)",
    "    install_args=[sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', '--target', dependency_dir, 'reportlab', 'pypdf']",
    "    install=subprocess.run(install_args, text=True, capture_output=True, timeout=180)",
    "    if install.returncode != 0 and ('No module named pip' in (install.stderr or '') or 'No module named pip' in (install.stdout or '')):",
    "        subprocess.run([sys.executable, '-m', 'ensurepip', '--upgrade'], text=True, capture_output=True, timeout=90)",
    "        install=subprocess.run(install_args, text=True, capture_output=True, timeout=180)",
    "    importlib.invalidate_caches()",
    "    colors=load_reportlab()",
    "if colors is None:",
    "    raise RuntimeError('ReportLab is unavailable. Install reportlab and pypdf in the Daytona sandbox, then retry PDF generation.')",
    "else:",
    "    from xml.sax.saxutils import escape",
    "    from reportlab.lib.enums import TA_LEFT, TA_CENTER",
    "    from reportlab.lib.pagesizes import A4, LETTER, LEGAL",
    "    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet",
    "    from reportlab.lib.units import inch",
    "    from reportlab.lib.utils import ImageReader",
    "    from reportlab.platypus import Image, KeepTogether, LongTable, Paragraph, PageBreak, SimpleDocTemplate, Spacer, TableStyle",
    "    from reportlab.graphics.charts.barcharts import VerticalBarChart",
    "    from reportlab.graphics.shapes import Drawing, String",
    "    page_sizes={'A4': A4, 'LETTER': LETTER, 'LEGAL': LEGAL}",
    "    style=payload['style']; primary=colors.HexColor('#' + style['primary']); accent=colors.HexColor('#' + style['accent']); text=colors.HexColor('#' + style['text']); muted=colors.HexColor('#' + style['muted'])",
    "    margin=float(style['margin'])*inch",
    "    path=payload['path']; os.makedirs(os.path.dirname(path) or '.', exist_ok=True)",
    "    doc=SimpleDocTemplate(path, pagesize=page_sizes[style['pageSize']], leftMargin=margin, rightMargin=margin, topMargin=margin+0.55*inch, bottomMargin=margin+0.28*inch, title=payload['title'], author=style.get('author') or 'Chusky')",
    "    styles=getSampleStyleSheet()",
    "    styles.add(ParagraphStyle(name='ChuskyTitle', parent=styles['Title'], fontName=style['fontBold'], fontSize=24, leading=29, textColor=primary, alignment=TA_LEFT, spaceAfter=14, keepWithNext=True))",
    "    styles.add(ParagraphStyle(name='ChuskyHeading', parent=styles['Heading1'], fontName=style['fontBold'], fontSize=15, leading=19, textColor=primary, spaceBefore=12, spaceAfter=7, keepWithNext=True, keepTogether=True))",
    "    styles.add(ParagraphStyle(name='ChuskyBody', parent=styles['BodyText'], fontName=style['fontName'], fontSize=float(style['fontSize']), leading=float(style['fontSize'])*1.4, textColor=text, spaceAfter=8, widowControl=True))",
    "    styles.add(ParagraphStyle(name='ChuskyBullet', parent=styles['BodyText'], fontName=style['fontName'], fontSize=float(style['fontSize']), leading=float(style['fontSize'])*1.35, leftIndent=14, firstLineIndent=-8, textColor=text, spaceAfter=4, widowControl=True))",
    "    styles.add(ParagraphStyle(name='ChuskyCell', parent=styles['BodyText'], fontName=style['fontName'], fontSize=8.5, leading=10.5, textColor=text, spaceAfter=0, widowControl=True))",
    // ReportLab's sample stylesheet does not guarantee a Caption style. Use
    // BodyText as the stable base for captions across renderer versions.
    "    styles.add(ParagraphStyle(name='ChuskyCaption', parent=styles['BodyText'], fontName=style['fontItalic'], fontSize=8.5, leading=11, textColor=muted, alignment=TA_CENTER, spaceBefore=4, spaceAfter=10, keepWithNext=False))",
    "    def rich(value):",
    "        value=escape(str(value)).replace('\\n', '<br/>')",
    "        value=re.sub(r'\\*\\*(.+?)\\*\\*', r'<b>\\1</b>', value)",
    "        value=re.sub(r'(?<!\\*)\\*([^*]+)\\*(?!\\*)', r'<i>\\1</i>', value)",
    "        value=re.sub(r'`([^`]+)`', r'<font name=\"' + style['monoFont'] + '\">\\1</font>', value)",
    "        return value",
    "    def para(value, paragraph_style='ChuskyBody'): return Paragraph(rich(value), styles[paragraph_style])",
    "    def draw_page(canvas, document):",
    "        canvas.saveState(); width,height=page_sizes[style['pageSize']]",
    "        canvas.setStrokeColor(accent); canvas.setLineWidth(1.2); canvas.line(margin, height-margin-0.04*inch, width-margin, height-margin-0.04*inch)",
    "        canvas.setFont(style['fontName'], 8); canvas.setFillColor(muted); header=style.get('header') or payload['title']; footer=style.get('footer') or ''; canvas.drawString(margin, height-margin+0.05*inch, str(header)[:120]); canvas.drawString(margin, 0.35*inch, str(footer)[:120]);",
    "        logo=style.get('logoPath');",
    "        if logo:",
    "            if not os.path.isfile(logo): raise FileNotFoundError('PDF logo does not exist: ' + logo)",
    "            canvas.drawImage(logo, width-margin-0.95*inch, height-margin+0.01*inch, width=0.9*inch, height=0.32*inch, preserveAspectRatio=True, anchor='ne', mask='auto')",
    "        if style.get('includePageNumbers', True): canvas.drawRightString(width-margin, 0.35*inch, 'Page ' + str(document.page))",
    "        canvas.restoreState()",
    "    def add_image(story, section):",
    "        image_path=section['imagePath']",
    "        if not os.path.isfile(image_path): raise FileNotFoundError('PDF image does not exist: ' + image_path)",
    "        native_w,native_h=ImageReader(image_path).getSize()",
    "        if native_w <= 0 or native_h <= 0: raise RuntimeError('PDF image has invalid dimensions: ' + image_path)",
    "        max_w=doc.width; requested=min(float(section.get('imageWidth') or max_w/inch), max_w/inch); image_w=max(1.0, min(requested, max_w/inch))*inch; image_h=image_w*native_h/native_w",
    "        max_h=6.2*inch",
    "        if image_h > max_h: image_h=max_h; image_w=image_h*native_w/native_h",
    "        image=Image(image_path, width=image_w, height=image_h, hAlign='CENTER'); image.hAlign='CENTER'",
    "        caption=section.get('imageAltText') or os.path.basename(image_path)",
    "        story.append(KeepTogether([image, Paragraph(escape(str(caption)), styles['ChuskyCaption'])]))",
    "    def add_chart(story, chart_data):",
    "        drawing=Drawing(doc.width, 235); chart=VerticalBarChart(); chart.x=45; chart.y=35; chart.width=doc.width-65; chart.height=170; chart.data=[series['values'] for series in chart_data['series']]; chart.categoryAxis.categoryNames=chart_data['categories']; chart.categoryAxis.labels.fontName=style['fontName']; chart.categoryAxis.labels.fontSize=8; chart.valueAxis.labels.fontName=style['fontName']; chart.valueAxis.labels.fontSize=8; chart.valueAxis.valueMin=0; chart.valueAxis.valueMax=max(1, max(max(series['values']) for series in chart_data['series'])*1.15); chart.valueAxis.valueStep=max(1, chart.valueAxis.valueMax/5); chart.bars[0].fillColor=accent; chart.bars[0].strokeColor=accent; drawing.add(chart); drawing.add(String(0, 220, chart_data['series'][0]['name'], fontName=style['fontBold'], fontSize=9, fillColor=primary)); story.append(drawing); story.append(Spacer(1, 8))",
    "    story=[Paragraph(escape(payload['title']), styles['ChuskyTitle'])]",
    "    story.append(Spacer(1, 3))",
    "    for section in payload['sections']:",
    "        if section.get('pageBreakBefore'): story.append(PageBreak())",
    "        block=[]",
    "        if section.get('heading'): block.append(para(section['heading'], 'ChuskyHeading'))",
    "        if section.get('body'): block.append(para(section['body']))",
    "        for bullet in section.get('bullets') or []: block.append(para('- ' + str(bullet), 'ChuskyBullet'))",
    "        if block: story.extend(block)",
    "        if section.get('table'):",
    "            data=[]",
    "            for row_index,row in enumerate(section['table']): data.append([para(cell, 'ChuskyCell') for cell in row])",
    "            cols=max(len(row) for row in section['table']); weights=section.get('columnWidths') or [1]*cols; total=sum(float(weight) for weight in weights); widths=[doc.width*float(weight)/total for weight in weights]; table=LongTable(data, colWidths=widths, repeatRows=1, splitByRow=1, hAlign='LEFT')",
    "            commands=[('BACKGROUND',(0,0),(-1,0),primary),('TEXTCOLOR',(0,0),(-1,0),colors.white),('FONTNAME',(0,0),(-1,0),style['fontBold']),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, colors.HexColor('#F3F7FA')]),('GRID',(0,0),(-1,-1),0.4,muted),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]",
    "            for row_index,row in enumerate(section['table'][1:], start=1):",
    "                for col_index,cell in enumerate(row):",
    "                    if re.match(r'^\\s*[+-]?(?:[$€£]\\s*)?\\d[\\d,]*(?:\\.\\d+)?%?\\s*$', str(cell)): commands.append(('ALIGN',(col_index,row_index),(col_index,row_index),'RIGHT'))",
    "            table.setStyle(TableStyle(commands)); story.append(table); story.append(Spacer(1, 12))",
    "        if section.get('chart'): add_chart(story, section['chart'])",
    "        if section.get('imagePath'): add_image(story, section)",
    "    doc.build(story, onFirstPage=draw_page, onLaterPages=draw_page)",
    "path=payload['path']",
    "if not os.path.isfile(path) or os.path.getsize(path) < 100: raise RuntimeError('PDF output was not written or is too small')",
    "page_count=0",
    "try:",
    "    from pypdf import PdfReader",
    "    check=PdfReader(path)",
    "    page_count=len(check.pages)",
    "except Exception: pass",
    "if page_count < 1:",
    "    try:",
    "        with open(path, 'rb') as _f:",
    "            _b=_f.read()",
    "            page_count=len(re.findall(rb'/Type\\s*/Page\\b', _b))",
    "            if not page_count:",
    "                _m=re.search(rb'/Count\\s+(\\d+)', _b)",
    "                if _m: page_count=int(_m.group(1))",
    "    except Exception: pass",
    "print(json.dumps({'path': path, 'pages': max(1, page_count), 'bytes': os.path.getsize(path)}))",
  ].join("\n");
}

function presentationImageMime(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
}

function presentationChosenLayout(spec: PresentationSlideInput): PresentationLayout {
  if (spec.layout && spec.layout !== "auto") return spec.layout;
  if (spec.metrics?.length) return "metrics";
  if (spec.quote) return "quote";
  if (spec.backgroundImagePath) return "background";
  if (spec.table) return "table";
  if (spec.chart) return "chart";
  if (spec.imagePaths?.length && spec.bullets?.length) return "hero";
  if (spec.imagePaths?.length) return "image_focus";
  if (spec.bullets?.length && spec.body) return "two_column";
  return "title";
}

function presentationShape(slide: PptxGenJS.Slide, color: string, x: number, y: number, w: number, h: number, transparency = 0): void {
  slide.addShape("rect", { x, y, w, h, fill: { color, transparency }, line: { color, transparency: 100 } });
}

async function validatePresentationPackage(bytes: Buffer): Promise<void> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new DaytonaInputError(`Presentation generator returned an unreadable OOXML package: ${error instanceof Error ? error.message : String(error)}`);
  }
  const names = new Set(Object.entries(archive.files).filter(([, entry]) => !entry.dir).map(([name]) => name));
  if (!names.has("[Content_Types].xml") || !names.has("ppt/presentation.xml")) throw new DaytonaInputError("Presentation generator returned an incomplete OOXML package");
  for (const relsName of [...names].filter((name) => name.endsWith(".rels"))) {
    const xml = await archive.file(relsName)?.async("text");
    if (!xml) throw new DaytonaInputError(`Presentation OOXML relationship file is unreadable: ${relsName}`);
    const sourceDir = relsName === "_rels/.rels" ? "" : pathPosix.dirname(relsName).replace(/\/_rels$/, "");
    for (const relationship of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
      const target = relationship.match(/\bTarget=(['"])(.*?)\1/i)?.[2];
      const targetMode = relationship.match(/\bTargetMode=(['"])(.*?)\1/i)?.[2];
      if (!target || /^external$/i.test(targetMode ?? "")) continue;
      const targetPath = target.startsWith("/")
        ? pathPosix.normalize(target.slice(1))
        : pathPosix.normalize(pathPosix.join(sourceDir, target));
      if (targetPath.startsWith("../") || !names.has(targetPath)) {
        throw new DaytonaInputError(`Presentation generator produced a missing OOXML relationship target: ${relsName} -> ${target}`);
      }
    }
  }
}

async function presentationBytes(sandbox: Sandbox, title: string, slides: PresentationSlideInput[], style: PresentationStyle): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Chusky";
  pptx.company = "Chusky";
  pptx.subject = title;
  pptx.title = title;
  pptx.theme = { headFontFace: style.headingFontFace, bodyFontFace: style.fontFace };

  pptx.defineSlideMaster({
    title: "CHUSKY_CONTENT",
    background: { color: style.background },
    objects: [
      { rect: { x: 0, y: 0, w: 13.333, h: 0.12, fill: { color: style.primary }, line: { color: style.primary } } },
      ...(style.footer ? [{ text: { text: style.footer, options: { x: 0.7, y: 7.08, w: 10.5, h: 0.2, fontFace: style.fontFace, fontSize: 8, color: style.muted, margin: 0 } } }] : []),
    ],
    slideNumber: style.includeSlideNumbers ? { x: 12.2, y: 7.03, w: 0.45, h: 0.2, fontFace: style.fontFace, fontSize: 8, color: style.muted, align: "right", margin: 0 } : undefined,
  });
  pptx.defineSlideMaster({
    title: "CHUSKY_COVER",
    background: { color: style.primary },
    objects: [
      { rect: { x: 0, y: 0, w: 13.333, h: 0.16, fill: { color: style.accent }, line: { color: style.accent } } },
    ],
  });

  const imageData = new Map<string, string>();
  const loadImage = async (imagePath: string): Promise<string> => {
    const cached = imageData.get(imagePath);
    if (cached) return cached;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await sandbox.fs.downloadFile(imagePath));
    } catch (error) {
      throw new DaytonaInputError(`Unable to read slide image ${imagePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!bytes.length) throw new DaytonaInputError(`Slide image is empty: ${imagePath}`);
    const data = `data:${presentationImageMime(imagePath)};base64,${bytes.toString("base64")}`;
    imageData.set(imagePath, data);
    return data;
  };

  const cover = pptx.addSlide({ masterName: "CHUSKY_COVER" });
  cover.addText(title, { x: 0.9, y: 2.05, w: 11.3, h: 1.5, fontFace: style.headingFontFace, fontSize: 34, bold: true, color: "FFFFFF", fit: "shrink", margin: 0 });
  presentationShape(cover, style.accent, 0.95, 3.78, 1.1, 0.08);
  cover.addText(style.footer ?? "Created by Chusky", { x: 0.95, y: 4.03, w: 8.5, h: 0.35, fontFace: style.fontFace, fontSize: 14, color: "E6FFFA", margin: 0 });
  if (style.logoPath) {
    cover.addImage({ data: await loadImage(style.logoPath), x: 10.9, y: 0.75, w: 1.6, h: 1.1, sizing: { type: "contain", x: 10.9, y: 0.75, w: 1.6, h: 1.1 }, altText: "Presentation brand logo" });
  }

  for (const spec of slides) {
    const slide = pptx.addSlide({ masterName: "CHUSKY_CONTENT" });
    // Add the identity mark on every slide, not only the cover. Keeping this
    // in the generator avoids relying on a PowerPoint master relationship
    // that can be stripped by different Office renderers.
    if (style.logoPath) {
      slide.addImage({ data: await loadImage(style.logoPath), x: 11.8, y: 0.27, w: 0.82, h: 0.42, sizing: { type: "contain", x: 11.8, y: 0.27, w: 0.82, h: 0.42 }, altText: "Presentation brand logo" });
    }
    const layout = presentationChosenLayout(spec);
    const backgroundSlide = layout === "background" || Boolean(spec.backgroundImagePath);
    const images = backgroundSlide ? [] : spec.imagePaths ?? [];
    const foregroundColor = backgroundSlide ? (spec.textColor ?? "FFFFFF") : (spec.textColor ?? style.text);
    const mutedForegroundColor = backgroundSlide ? foregroundColor : style.muted;
    if (backgroundSlide && spec.backgroundImagePath) {
      const x = 0;
      const y = 0;
      const w = 13.333;
      const h = 7.5;
      slide.addImage({ data: await loadImage(spec.backgroundImagePath), x, y, w, h, sizing: { type: "cover", x, y, w, h }, altText: spec.backgroundImageAltText ?? `Background image for ${spec.title}` });
      const overlay = spec.overlayColor ?? (presentationColorLuminance(foregroundColor) > 0.5 ? "0F172A" : "FFFFFF");
      presentationShape(slide, overlay, 0, 0, w, h, spec.overlayOpacity ?? 52);
      // A denser left safe zone keeps long titles and bullets legible over busy photography.
      presentationShape(slide, overlay, 0.52, 1.52, 7.15, 4.95, Math.max(0, (spec.overlayOpacity ?? 52) - 18));
    }
    const titleY = spec.eyebrow ? 0.73 : 0.48;
    if (spec.eyebrow) slide.addText(spec.eyebrow.toUpperCase(), { x: 0.78, y: 0.38, w: 7.5, h: 0.2, fontFace: style.fontFace, fontSize: 9, bold: true, charSpacing: 1.4, color: style.accent, margin: 0 });
    slide.addText(spec.title, { x: 0.78, y: titleY, w: style.logoPath ? 10.65 : 11.75, h: 0.58, fontFace: style.headingFontFace, fontSize: 26, bold: true, color: foregroundColor, fit: "shrink", margin: 0 });
    presentationShape(slide, spec.accent ?? style.accent, 0.8, 1.28, layout === "section" || layout === "closing" ? 1.4 : 0.65, 0.07);

    if (layout === "section" || layout === "closing") {
      slide.addText(spec.body ?? spec.title, { x: 1.25, y: 2.55, w: 10.8, h: 1.15, fontFace: style.headingFontFace, fontSize: 30, bold: true, color: backgroundSlide ? foregroundColor : style.primary, align: "center", valign: "middle", fit: "shrink", margin: 0.08 });
      if (spec.bullets?.length) slide.addText(spec.bullets.join("  •  "), { x: 1.5, y: 4.05, w: 10.3, h: 0.65, fontFace: style.fontFace, fontSize: 16, color: backgroundSlide ? mutedForegroundColor : style.muted, align: "center", fit: "shrink", margin: 0.05 });
      if (spec.notes) slide.addNotes(spec.notes);
      continue;
    }

    if (layout === "metrics" && spec.metrics?.length) {
      const gap = 0.22;
      const cardW = (11.7 - gap * (spec.metrics.length - 1)) / spec.metrics.length;
      spec.metrics.forEach((metric, index) => {
        const x = 0.8 + index * (cardW + gap);
        presentationShape(slide, style.surface, x, 2.05, cardW, 2.2);
        slide.addText(metric.value, { x: x + 0.2, y: 2.35, w: cardW - 0.4, h: 0.58, fontFace: style.headingFontFace, fontSize: 28, bold: true, color: style.primary, fit: "shrink", margin: 0 });
        slide.addText(metric.label, { x: x + 0.2, y: 3.08, w: cardW - 0.4, h: 0.3, fontFace: style.fontFace, fontSize: 13, bold: true, color: style.text, fit: "shrink", margin: 0 });
        if (metric.detail) slide.addText(metric.detail, { x: x + 0.2, y: 3.48, w: cardW - 0.4, h: 0.45, fontFace: style.fontFace, fontSize: 10, color: style.muted, fit: "shrink", margin: 0 });
      });
      if (spec.notes) slide.addNotes(spec.notes);
      continue;
    }

    if (layout === "quote" && spec.quote) {
      slide.addText(`“${spec.quote}”`, { x: 1.15, y: 2.05, w: 10.95, h: 2.3, fontFace: style.headingFontFace, fontSize: 28, italic: true, color: backgroundSlide ? foregroundColor : style.primary, align: "center", valign: "middle", fit: "shrink", margin: 0.12 });
      if (spec.body) slide.addText(spec.body, { x: 2, y: 4.8, w: 9.3, h: 0.45, fontFace: style.fontFace, fontSize: 13, color: backgroundSlide ? mutedForegroundColor : style.muted, align: "center", fit: "shrink", margin: 0 });
      if (spec.notes) slide.addNotes(spec.notes);
      continue;
    }

    const imageFocus = layout === "image_focus" || layout === "hero";
    const hasSideImage = images.length > 0 && imageFocus;
    const textWidth = hasSideImage ? 6.15 : 11.65;
    let cursor = 1.68;
    if (spec.body) {
      slide.addText(spec.body, { x: 0.86, y: cursor, w: textWidth, h: layout === "two_column" || layout === "comparison" ? 3.85 : 1.15, fontFace: style.fontFace, fontSize: 18, color: foregroundColor, fit: "shrink", valign: "top", margin: 0.03 });
      cursor += layout === "two_column" || layout === "comparison" ? 0 : 1.22;
    }
    if (spec.bullets?.length && layout !== "timeline") {
      const bulletText = spec.bullets.map((bullet) => `• ${bullet}`).join("\n");
      const bulletX = layout === "two_column" || layout === "comparison" ? 6.95 : 0.92;
      const bulletW = layout === "two_column" || layout === "comparison" ? 5.25 : textWidth;
      slide.addText(bulletText, { x: bulletX, y: layout === "two_column" || layout === "comparison" ? 1.78 : cursor, w: bulletW, h: 4.75, fontFace: style.fontFace, fontSize: 17, color: foregroundColor, fit: "shrink", valign: "top", breakLine: false, margin: 0.04, paraSpaceAfter: 9 });
    }
    if (layout === "timeline" && spec.bullets?.length) {
      presentationShape(slide, style.accent, 1.05, 1.85, 0.06, 4.35);
      spec.bullets.forEach((item, index) => {
        const y = 1.82 + index * Math.min(1.05, 4.35 / spec.bullets!.length);
        presentationShape(slide, style.accent, 0.94, y + 0.08, 0.28, 0.28);
        slide.addText(item, { x: 1.55, y, w: 10.5, h: 0.65, fontFace: style.fontFace, fontSize: 16, color: foregroundColor, fit: "shrink", margin: 0 });
      });
    }
    if (spec.table) {
      const tableRows = spec.table.map((row, rowIndex) => row.map((cell) => ({ text: cell, options: { bold: rowIndex === 0, color: rowIndex === 0 ? "FFFFFF" : style.text, fill: { color: rowIndex === 0 ? style.primary : rowIndex % 2 === 0 ? style.surface : style.background }, margin: 0.07 } })));
      slide.addTable(tableRows as PptxGenJS.TableRow[], { x: 0.82, y: spec.body ? 3.05 : 1.8, w: textWidth, h: 3.6, fontFace: style.fontFace, fontSize: 13, color: style.text, border: { type: "solid", color: style.muted, pt: 0.6 }, fill: { color: style.background }, margin: 0.05, autoPage: false });
    }
    if (spec.chart) {
      slide.addChart(pptx.ChartType.bar, spec.chart.series.map((series) => ({ name: series.name, labels: spec.chart!.categories, values: series.values })), { x: images.length ? 0.8 : 6.45, y: 1.82, w: images.length ? 6.0 : 6.4, h: 4.55, barDir: "col", barGrouping: "clustered", catAxisLabelFontSize: 11, valAxisLabelFontSize: 11, showLegend: spec.chart.series.length > 1, showTitle: false, showValue: true, chartColors: [style.primary, style.accent, style.secondary, "7C3AED"], altText: `${spec.title} chart` });
    }
    for (let index = 0; index < images.length; index += 1) {
      const imagePath = images[index]!;
      const x = imageFocus ? 7.35 : 8.25;
      const y = imageFocus ? 1.78 + index * (4.9 / Math.max(1, images.length)) : 1.55 + index * (5.15 / Math.max(1, images.length));
      const w = imageFocus ? 5.15 : 4.3;
      const h = imageFocus ? Math.max(1.25, 4.6 / Math.max(1, images.length)) : Math.max(1.1, 4.8 / Math.max(1, images.length));
      const fit = spec.imageFit ?? (imageFocus ? "cover" : "contain");
      slide.addImage({ data: await loadImage(imagePath), x, y, w, h, sizing: { type: fit, x, y, w, h }, altText: spec.imageAltTexts?.[index] ?? `Image ${index + 1} for ${spec.title}` });
    }
    if (spec.notes) slide.addNotes(spec.notes);
  }
  const output = await pptx.write({ outputType: "nodebuffer", compression: true });
  const bytes = Buffer.from(output as Uint8Array);
  if (bytes.length < 1024 || !bytes.subarray(0, 2).equals(Buffer.from("PK"))) throw new DaytonaInputError("Presentation generator returned an invalid Office Open XML package");
  if (bytes.length > DAYTONA_MAX_ARTIFACT_BYTES) throw new DaytonaInputError(`Presentation is larger than the ${Math.floor(DAYTONA_MAX_ARTIFACT_BYTES / 1024 / 1024)} MB delivery limit`);
  await validatePresentationPackage(bytes);
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
  private networkPolicyOverrideUnavailable = false;

  constructor(private readonly clientFactory: typeof getDaytonaClient = getDaytonaClient) {}

  /**
   * A sandbox can outlive a deployment configuration change. In particular,
   * an older Chusky workspace may retain `networkBlockAll: true` even after
   * the deployment has been changed to permit npm access. Reconcile the
   * retained sandbox with the configured policy before using it.
   */
  private async reconcileNetworkPolicy(sandbox: Sandbox): Promise<void> {
    if (this.networkPolicyOverrideUnavailable) return;
    const domainAllowList = config.daytonaDomainAllowList.trim();
    try {
      if (domainAllowList) {
        if (sandbox.domainAllowList !== domainAllowList) {
          await sandbox.updateNetworkSettings({ domainAllowList });
          await sandbox.refreshData();
        }
        return;
      }
      // Older SDK responses can omit this optional field. In that case there is
      // no explicit retained policy to repair, so preserve the provider default.
      if (typeof sandbox.networkBlockAll !== "boolean" || sandbox.networkBlockAll === config.daytonaNetworkBlockAll) return;
      await sandbox.updateNetworkSettings({ networkBlockAll: config.daytonaNetworkBlockAll });
      await sandbox.refreshData();
    } catch (error) {
      // On Daytona Tier 1/2, the organization firewall is authoritative. Do
      // not turn every normal filesystem/artifact call into a failure by
      // retrying an update the provider has explicitly forbidden.
      if (DAYTONA_TIER_NETWORK_RESTRICTION.test(String(error))) {
        this.networkPolicyOverrideUnavailable = true;
        return;
      }
      throw error;
    }
  }

  private async getSandbox(userId: number): Promise<Sandbox | undefined> {
    const stored = await getDaytonaWorkspace(userId);
    if (!stored?.sandboxId) return undefined;
    try {
      const sandbox = await this.clientFactory().get(stored.sandboxId);
      await sandbox.refreshData();
      if (sandbox.recoverable && sandbox.state !== "started") await sandbox.recover(60);
      else if (sandbox.state !== "started") await sandbox.start(60);
      await this.reconcileNetworkPolicy(sandbox);
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
      try {
        const sandbox = await client.create(createParams, { timeout: 120 });
        await saveDaytonaWorkspace(userId, workspaceRecord(sandbox));
        return sandbox;
      } catch (error) {
        if (!isDaytonaConflict(error)) throw error;
        // Redis may have been flushed while Daytona retained the named
        // sandbox. Recover it by its deterministic name instead of creating a
        // replacement. A short bounded retry handles provider read-after-write
        // lag when another process won the create race.
        let lastError: unknown = error;
        for (const delayMs of [0, 250, 750]) {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          try {
            const sandbox = await client.get(createParams.name);
            const labels = sandbox.labels ?? {};
            if (labels.user_id && labels.user_id !== String(userId)) {
              throw new Error("Daytona returned a sandbox owned by another user");
            }
            await sandbox.refreshData();
            if (sandbox.recoverable && sandbox.state !== "started") await sandbox.recover(60);
            else if (sandbox.state !== "started") await sandbox.start(60);
            await this.reconcileNetworkPolicy(sandbox);
            await sandbox.refreshActivity();
            await saveDaytonaWorkspace(userId, { ...workspaceRecord(sandbox), lastKnownState: sandbox.state });
            return sandbox;
          } catch (recoveryError) {
            lastError = recoveryError;
          }
        }
        throw lastError;
      }
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
    const expiresInSeconds = 3600;
    const result = await sandbox.getSignedPreviewUrl(normalizedPort, expiresInSeconds);
    const url = String(result.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new DaytonaInputError("Daytona returned an invalid preview URL");
    return { sandboxId: sandbox.id, port: normalizedPort, url, expiresAt: Date.now() + expiresInSeconds * 1000 };
  }

  /**
   * Creates a deliberately short-lived bearer URL to the noVNC process that
   * Computer Use started inside the caller's retained sandbox. This is the
   * one controlled way for a person to solve CAPTCHA/2FA in exactly the
   * browser Chusky is using; it neither creates a second profile nor exports
   * cookies/credentials to the model. The returned URL is private output and
   * must only be delivered by the caller's direct channel.
   */
  async browserHandoff(userId: number, reason?: string): Promise<{ sandboxId: string; url: string; expiresAt: number; message: string }> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.computerUse.start();
    const vnc = await sandbox.computerUse.getProcessStatus("novnc") as { status?: unknown; state?: unknown };
    const state = String(vnc?.status ?? vnc?.state ?? "").toLowerCase();
    if (/(failed|stopped|error|not.?running)/.test(state)) throw new DaytonaInputError("Daytona's private browser handoff is unavailable because the noVNC process is not running.");
    const port = boundedInt(config.daytonaVncPort, 6080, 65535);
    const requestedTtl = Number(config.daytonaBrowserHandoffTtlSeconds);
    const ttlSeconds = Number.isFinite(requestedTtl) ? Math.min(900, Math.max(60, Math.floor(requestedTtl))) : 300;
    const preview = await sandbox.getSignedPreviewUrl(port, ttlSeconds);
    const url = String(preview.url ?? "").trim();
    if (!/^https:\/\//i.test(url)) throw new DaytonaInputError("Daytona returned an invalid private browser handoff URL");
    return {
      sandboxId: sandbox.id,
      url,
      expiresAt: Date.now() + ttlSeconds * 1000,
      message: `Open this private browser session to complete ${reason || "the website step"}. It expires soon. When you are done, return here and say continue; Chusky will inspect the same retained browser before it does anything else.`,
    };
  }

  /**
   * App-project control plane. This deliberately keeps a project's source,
   * verification evidence, local branch and preview process together rather
   * than treating a preview URL as proof that an application works.
   */
  async app(userId: number, args: Record<string, unknown>): Promise<DaytonaAppResult | { apps: DaytonaAppRecord[] } | (DaytonaScreenshotResult & { app: DaytonaAppRecord; url: string; expiresAt: number })> {
    const action = boundedText(args.action, "action", 20);
    const sandbox = await this.getOrCreateWorkspace(userId);
    const stored = await getDaytonaWorkspace(userId);
    const apps = [...(stored?.apps ?? [])];
    const saveApps = async (next: DaytonaAppRecord[]) => {
      const current = await getDaytonaWorkspace(userId);
      if (current) await saveDaytonaWorkspace(userId, { ...current, apps: next.slice(-20), updatedAt: Date.now() });
    };
    const result = (app: DaytonaAppRecord, output?: string): DaytonaAppResult => ({
      sandboxId: sandbox.id, ...app, url: app.previewUrl, expiresAt: app.previewExpiresAt, ...(output ? { output } : {}),
    });
    const update = async (index: number, app: DaytonaAppRecord) => {
      apps[index] = app;
      await saveApps(apps);
      return app;
    };
    const verify = async (index: number, app: DaytonaAppRecord): Promise<DaytonaAppRecord> => {
      // --if-present makes optional project scripts explicit skips, while build
      // is mandatory for both supported templates. This is executable evidence,
      // not a model assertion that a project probably compiles.
      const commands: Array<{ name: DaytonaAppCheck["name"]; command: string; required: boolean }> = [
        { name: "typecheck", command: "npm run typecheck --if-present", required: false },
        { name: "lint", command: "npm run lint --if-present", required: false },
        { name: "test", command: "npm run test --if-present -- --run", required: false },
        { name: "build", command: "npm run build", required: true },
      ];
      const checks: DaytonaAppCheck[] = [];
      for (const check of commands) {
        const execution = await this.execute(userId, check.command, app.path, 900);
        const skipped = !check.required && /missing script|unknown script/i.test(execution.output);
        checks.push({
          name: check.name,
          status: skipped ? "skipped" : execution.exitCode === 0 ? "passed" : "failed",
          output: execution.output.slice(-2000),
          completedAt: Date.now(),
        });
      }
      const passed = checks.every((check) => check.status !== "failed");
      const verification: DaytonaAppVerification = {
        status: passed ? "passed" : "failed",
        checks,
        ...(passed ? { verifiedAt: Date.now() } : {}),
      };
      return update(index, {
        ...app,
        status: passed ? "verified" : "failed",
        verification,
        release: { status: "not_requested" },
        updatedAt: Date.now(),
      });
    };

    if (action === "list") return { apps };
    const id = boundedText(args.id ?? args.name, "id", 64).toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(id)) throw new DaytonaInputError("id must be 2-63 lowercase letters, numbers, or hyphens and start with a letter");
    const index = apps.findIndex((app) => app.id === id);
    const existing = index >= 0 ? apps[index] : undefined;
    if (action === "scaffold") {
      if (existing) throw new DaytonaInputError(`An app named '${id}' already exists; use its project actions instead.`);
      const framework = boundedText(args.framework, "framework", 20) as DaytonaAppFramework;
      if (framework !== "vite-react" && framework !== "nextjs") throw new DaytonaInputError("framework must be vite-react or nextjs");
      if (sandbox.networkBlockAll === true && this.networkPolicyOverrideUnavailable) {
        throw new DaytonaInputError("This Daytona organization tier blocks outbound network access, so npm dependencies cannot be installed in this workspace. The project files are unchanged. Use a Daytona tier or organization policy that permits npm registry access, then retry scaffold.");
      }
      const path = `workspace/apps/${id}`;
      const branch = `chusky/${id}`;
      const scaffold = appScaffoldCommand(framework, id);
      const run = await this.execute(userId, scaffold, undefined, 900);
      if (run.exitCode !== 0) throw new DaytonaInputError(appScaffoldFailure(run.output));
      // Keep generated work isolated from the outset. It is local-only: remote
      // repository creation, push and deployment retain their approval gates.
      const gitSetup = await this.execute(userId, `git init -b main && git add -A && git -c user.name=Chusky -c user.email=chusky@localhost commit -m "chore: scaffold ${id}" && git checkout -b ${branch}`, path, 120);
      if (gitSetup.exitCode !== 0) throw new DaytonaInputError(`App scaffold completed but local project branch setup failed: ${gitSetup.output.slice(-800)}`);
      const app: DaytonaAppRecord = {
        id, framework, path, branch, port: framework === "vite-react" ? 5173 : 3000,
        status: "scaffolded", verification: { status: "pending", checks: [] }, release: { status: "not_requested" },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      await saveApps([...apps, app]);
      return result(app, `${run.output}\n${gitSetup.output}`.slice(-DAYTONA_MAX_OUTPUT_CHARS));
    }
    if (!existing) throw new DaytonaInputError(`App '${id}' was not found in this workspace`);

    if (action === "verify") return result(await verify(index, existing));
    if (action === "branch") {
      const branch = boundedText(args.branch, "branch", 120);
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,118}$/.test(branch) || branch.includes("..") || branch.endsWith("/")) throw new DaytonaInputError("branch must be a safe Git branch name");
      await sandbox.git.createBranch(existing.path, branch);
      await sandbox.git.checkoutBranch(existing.path, branch);
      return result(await update(index, { ...existing, branch, verification: { status: "pending", checks: [] }, release: { status: "not_requested" }, updatedAt: Date.now() }));
    }
    if (action === "stop") {
      if (existing.ptySessionId) {
        try { await sandbox.process.killPtySession(existing.ptySessionId); } catch { /* The service may already have exited. */ }
      }
      return result(await update(index, { ...existing, status: "stopped", ptySessionId: undefined, previewUrl: undefined, previewExpiresAt: undefined, updatedAt: Date.now() }));
    }
    const expiry = Math.max(DAYTONA_PREVIEW_MIN_SECONDS, Math.min(DAYTONA_PREVIEW_MAX_SECONDS, boundedInt(args.expiresInSeconds, 3600, DAYTONA_PREVIEW_MAX_SECONDS)));
    if (action === "status") {
      const preview = existing.status === "running" || existing.status === "ready_for_review" || existing.status === "ready_to_publish"
        ? await sandbox.getSignedPreviewUrl(existing.port, expiry) : undefined;
      const app = preview ? await update(index, { ...existing, previewUrl: String(preview.url), previewExpiresAt: Date.now() + expiry * 1000, updatedAt: Date.now() }) : existing;
      return result(app);
    }
    if (action === "logs") {
      if (!existing.ptySessionId) throw new DaytonaInputError("This app has no running server. Start it before reading server logs.");
      const logs = await this.pty(userId, { action: "read", id: existing.ptySessionId });
      const latestOutput = (logs.output || existing.lastOutput || "").slice(-DAYTONA_MAX_PTY_OUTPUT);
      const app = latestOutput && latestOutput !== existing.lastOutput
        ? await update(index, { ...existing, lastOutput: latestOutput, updatedAt: Date.now() })
        : existing;
      return result(app, latestOutput);
    }
    if (action === "review") {
      const visual = existing.verification?.visual;
      if (!visual || visual.status !== "captured" || Date.now() - visual.capturedAt > 10 * 60 * 1000) throw new DaytonaInputError("Capture a fresh visual screenshot with action=visual before recording a review.");
      const summary = boundedText(args.summary, "summary", 2000);
      const passed = args.passed === true;
      const verification: DaytonaAppVerification = {
        ...(existing.verification ?? { status: "pending", checks: [] }),
        visual: { status: passed ? "passed" : "failed", summary, capturedAt: visual.capturedAt, reviewedAt: Date.now() },
      };
      return result(await update(index, { ...existing, status: passed ? "ready_for_review" : "failed", verification, release: { status: "not_requested" }, updatedAt: Date.now() }));
    }
    if (action === "release") {
      const verification = existing.verification;
      if (verification?.status !== "passed" || verification.visual?.status !== "passed") {
        throw new DaytonaInputError("Release handoff requires a passing current verification and an honest passing visual review.");
      }
      const target = args.target ? boundedText(args.target, "target", 200) : "external deployment";
      return result(await update(index, { ...existing, status: "ready_to_publish", release: { status: "awaiting_approval", target, requestedAt: Date.now() }, updatedAt: Date.now() }));
    }
    if (action !== "visual" && action !== "start") throw new DaytonaInputError("Unsupported app action");
    let app = existing;
    if (action === "start") {
      // Re-run on every start so a later edit cannot inherit an old green
      // check. Preview is a verification outcome, never a substitute for it.
      app = await verify(index, existing);
      if (app.verification?.status !== "passed") throw new DaytonaInputError("App verification failed. Fix the recorded check output before starting a preview.");
      // A reviewed or release-ready project can still have its already-checked
      // preview server running. Do not create a duplicate server/port merely
      // because its lifecycle status is more specific than "running".
      const serverAlreadyRunning = app.status === "running" || app.status === "ready_for_review" || app.status === "ready_to_publish";
      if (!serverAlreadyRunning || !app.ptySessionId) {
        const port = args.port === undefined ? app.port : boundedInt(args.port, app.port, 65535);
        const sessionId = `app-${id}-${randomUUID().slice(0, 8)}`;
        const output = collectPtyOutput();
        const handle = await sandbox.process.createPty({ id: sessionId, cwd: app.path, cols: 140, rows: 40, onData: output.onData });
        try {
          await handle.waitForConnection();
          const command = app.framework === "vite-react"
            ? `npm run dev -- --host 0.0.0.0 --port ${port}`
            : `npm run dev -- --hostname 0.0.0.0 --port ${port}`;
          await handle.sendInput(`${command}\n`);
          await brieflyCollect(handle, 1500);
        } finally { await handle.disconnect(); }
        const health = await this.execute(userId, `node -e "fetch('http://127.0.0.1:${port}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`, app.path, 20);
        const checks = [...(app.verification?.checks ?? []), { name: "health" as const, status: health.exitCode === 0 ? "passed" as const : "failed" as const, output: health.output.slice(-2000), completedAt: Date.now() }];
        if (health.exitCode !== 0) {
          try { await sandbox.process.killPtySession(sessionId); } catch { /* best-effort cleanup */ }
          await update(index, { ...app, status: "failed", ptySessionId: undefined, verification: { status: "failed", checks }, updatedAt: Date.now() });
          throw new DaytonaInputError(`App server did not become reachable on port ${port}. Check app logs and fix the app before retrying.`);
        }
        const preview = await sandbox.getSignedPreviewUrl(port, expiry);
        app = await update(index, { ...app, port, status: "running", ptySessionId: sessionId, lastOutput: output.chunks.join("").slice(-DAYTONA_MAX_PTY_OUTPUT), previewUrl: String(preview.url), previewExpiresAt: Date.now() + expiry * 1000, verification: { ...(app.verification as DaytonaAppVerification), checks }, updatedAt: Date.now() });
        const current = await getDaytonaWorkspace(userId);
        if (current) await saveDaytonaWorkspace(userId, { ...current, ptySessions: [...(current.ptySessions ?? []).filter((item) => item.id !== sessionId), { id: sessionId, createdAt: Date.now() }], apps, updatedAt: Date.now() });
      }
      return result(app);
    }
    if (!app.ptySessionId || !app.previewUrl) throw new DaytonaInputError("Start the app before visual verification.");
    const preview = await sandbox.getSignedPreviewUrl(app.port, expiry);
    const url = String(preview.url);
    await this.browser(userId, { action: "open", url });
    const screenshot = await this.computer(userId, { action: "screenshot" }) as DaytonaScreenshotResult & { __daytonaScreenshot: true };
    app = await update(index, { ...app, status: "running", previewUrl: url, previewExpiresAt: Date.now() + expiry * 1000, verification: { ...(app.verification as DaytonaAppVerification), visual: { status: "captured", capturedAt: Date.now() } }, updatedAt: Date.now() });
    return { ...screenshot, app, url, expiresAt: app.previewExpiresAt! };
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
    const computer = sandbox.computerUse;
    if (action === "status") return computer.getStatus();
    if (action === "stop") return computer.stop();
    if (action === "process_status") return computer.getProcessStatus(boundedText(args.processName, "processName", 40));
    if (action === "recording_list") return computer.recording.list();
    if (action === "recording_get") return computer.recording.get(boundedText(args.recordingId, "recordingId", 200));
    if (action === "recording_stop") return computer.recording.stop(boundedText(args.recordingId, "recordingId", 200));
    if (action === "recording_delete") { await computer.recording.delete(boundedText(args.recordingId, "recordingId", 200)); return { deleted: true }; }
    // Daytona's Computer Use transport can occasionally be closed while the
    // sandbox itself remains healthy. Retry only this idempotent startup
    // handshake, before any click/type/invoke action is issued, so a recovery
    // can never duplicate a user-visible browser action.
    try {
      await computer.start();
    } catch (error) {
      if (!isTransientComputerConnection(error)) throw error;
      await sleep(350);
      try {
        await computer.start();
      } catch (retryError) {
        if (isTransientComputerConnection(retryError)) {
          throw new DaytonaInputError("Daytona's browser is temporarily reconnecting. No browser action was performed; retry in a few seconds.");
        }
        throw retryError;
      }
    }
    switch (action) {
      case "start": return { started: true, status: await computer.getStatus() };
      case "display": return computer.display.getInfo();
      case "display_info": return computer.display.getInfo();
      case "windows": return computer.display.getWindows();
      case "process_restart": return computer.restartProcess(boundedText(args.processName, "processName", 40));
      case "process_logs": return computer.getProcessLogs(boundedText(args.processName, "processName", 40));
      case "process_errors": return computer.getProcessErrors(boundedText(args.processName, "processName", 40));
      case "mouse_position": return computer.mouse.getPosition();
      case "recording_start": return computer.recording.start(args.label ? boundedText(args.label, "label", 200) : undefined);
      case "recording_download": {
        const recordingId = boundedText(args.recordingId, "recordingId", 200);
        const path = safeDaytonaPath(args.path ?? `recordings/${recordingId}.mp4`, "path");
        await computer.recording.download(recordingId, path);
        return { recordingId, path, downloaded: true };
      }
      case "screenshot": {
        const result = await computer.screenshot.takeCompressed({ format: "jpeg", quality: 70, scale: 0.75, showCursor: args.showCursor === true });
        if (!result.screenshot) throw new DaytonaInputError("Daytona returned an empty screenshot");
        return { __daytonaScreenshot: true, sandboxId: sandbox.id, mediaType: "image/jpeg", base64: result.screenshot, sizeBytes: result.sizeBytes } satisfies DaytonaScreenshotResult & { __daytonaScreenshot: true };
      }
      case "screenshot_region": {
        const width = boundedInt(args.width, 1, 7680);
        const height = boundedInt(args.height, 1, 4320);
        const result = await computer.screenshot.takeCompressedRegion({ x: coordinate(args.x, "x"), y: coordinate(args.y, "y"), width, height }, { format: "jpeg", quality: 70, scale: 0.75, showCursor: args.showCursor === true });
        if (!result.screenshot) throw new DaytonaInputError("Daytona returned an empty screenshot");
        return { __daytonaScreenshot: true, sandboxId: sandbox.id, mediaType: "image/jpeg", base64: result.screenshot, sizeBytes: result.sizeBytes, region: { x: args.x, y: args.y, width, height } };
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
    await guardVaultBrowserAction(userId, sandbox.id, args);
    if (["start", "stop", "process_status", "process_restart", "process_logs", "process_errors", "recording_start", "recording_stop", "recording_list", "recording_get", "recording_delete", "recording_download", "display_info", "mouse_position", "screenshot_region"].includes(action)) return this.computer(userId, args);
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
      const matches = await this.computer(userId, { action: "accessibility_find", role: args.role, name: args.name, nameMatch: args.nameMatch, limit: boundedNumber(args.limit, 20, 50) });
      await rememberVaultBrowserNodes(userId, sandbox.id, matches);
      return { sandboxId: sandbox.id, matches };
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

  /**
   * Trusted vault-only path. This method is intentionally not reachable from
   * CHUCK_DAYTONA_BROWSER: it receives secrets only from the credential broker
   * and returns no accessibility tree, screenshot, or typed values.
   */
  async vaultLogin(userId: number, input: { origin: string; loginUrl: string; usernameFieldLabel: string; passwordFieldLabel: string; submitButtonLabel: string; username: string; password: string }): Promise<{ workspaceId: string; authenticated: boolean; needsUserInteraction?: boolean }> {
    const login = new URL(input.loginUrl);
    if (login.origin !== input.origin || login.protocol !== "https:") throw new DaytonaInputError("Vault login URL does not match its authorised origin");
    await this.browser(userId, { action: "open", url: login.toString() });
    const node = async (role: string, configuredName: string, fallbacks: string[]): Promise<string | undefined> => {
      const candidates = [...new Set([configuredName, ...fallbacks].map((value) => value.trim()).filter(Boolean))];
      for (const name of candidates) {
        const result = await this.computer(userId, { action: "accessibility_find", role, name, nameMatch: "exact", limit: 2 }) as any;
        const matches = Array.isArray(result) ? result : Array.isArray(result?.matches) ? result.matches : [];
        if (matches.length !== 1) continue;
        const id = matches[0]?.nodeId ?? matches[0]?.id;
        if (typeof id === "string" && id) return id;
      }
      return undefined;
    };
    const usernameNode = await node("textbox", input.usernameFieldLabel, ["Email", "Email address", "Email or username", "Username", "User name", "Phone number", "Mobile number"]);
    const passwordNode = await node("textbox", input.passwordFieldLabel, ["Password", "Your password", "Enter password"]);
    const submitNode = await node("button", input.submitButtonLabel, ["Sign in", "Log in", "Login", "Continue", "Next", "Submit"]);
    const sandbox = await this.getOrCreateWorkspace(userId);
    // Do not guess or type into an ambiguous/unrecognised form. The trusted
    // caller turns this into a direct owner handoff for CAPTCHA, 2FA, or a
    // site-specific sign-in page while preserving the retained browser state.
    if (!usernameNode || !passwordNode || !submitNode) {
      return { workspaceId: sandbox.id, authenticated: false, needsUserInteraction: true };
    }
    await this.computer(userId, { action: "accessibility_set_value", nodeId: usernameNode, value: input.username });
    await this.computer(userId, { action: "accessibility_set_value", nodeId: passwordNode, value: input.password });
    await this.computer(userId, { action: "accessibility_invoke", nodeId: submitNode });
    // Never claim success merely because the form was submitted. A site that
    // still exposes its password field is treated as requiring re-auth.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const after = await this.computer(userId, { action: "accessibility_find", role: "textbox", name: input.passwordFieldLabel, nameMatch: "exact", limit: 1 }) as any;
    const remaining = Array.isArray(after) ? after : Array.isArray(after?.matches) ? after.matches : [];
    return { workspaceId: sandbox.id, authenticated: remaining.length === 0 };
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
    const result = await sandbox.process.executeCommand(`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`, await sandbox.getUserHomeDir(), undefined, 120);
    if (result.exitCode !== 0) {
      throw new DaytonaInputError(`${type.toUpperCase()} validation failed: ${String(result.result ?? "unknown validation error").slice(0, 500)}`);
    }
  }

  private async validateArtifactVisual(sandbox: Sandbox, path: string, type: ArtifactType): Promise<void> {
    if (!STRUCTURED_ARTIFACT_TYPES.has(type)) return;
    const script = artifactVisualQaScript(type, path);
    const encoded = Buffer.from(script, "utf8").toString("base64");
    let result = await sandbox.process.executeCommand(`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`, await sandbox.getUserHomeDir(), undefined, 900);
    if (result.exitCode === 3) result = await this.validateInRenderer(sandbox, path, type);
    if (result.exitCode !== 0) {
      throw new DaytonaInputError(`${type.toUpperCase()} visual QA failed for '${path}': ${String(result.result ?? "unknown rendering error").slice(0, 500)}`);
    }
  }

  private async validateInRenderer(source: Sandbox, path: string, type: ArtifactType) {
    const bytes = Buffer.from(await source.fs.downloadFile(path));
    if (!bytes.length || bytes.length > DAYTONA_MAX_ARTIFACT_BYTES) {
      throw new DaytonaInputError("Artifact is empty or exceeds the rendering size limit");
    }
    let renderer: Sandbox | undefined;
    try {
      const params = {
        name: "chusky-qa-" + randomUUID(),
        language: "python",
        // The on-demand renderer image installs LibreOffice and Poppler while
        // Daytona prepares the image. A blocked sandbox cannot prepare that
        // image reliably. A prebuilt snapshot can remain network-blocked.
        networkBlockAll: Boolean(config.daytonaRendererSnapshot),
        public: false,
        autoStopInterval: 15,
        autoDeleteInterval: 0,
        ttlMinutes: 30,
        labels: { agent: "chusky", purpose: "artifact-qa", source_sandbox: source.id },
      };
      renderer = config.daytonaRendererSnapshot
        ? await this.clientFactory().create({ ...params, snapshot: config.daytonaRendererSnapshot }, { timeout: 120 })
        : await this.clientFactory().create({ ...params, image: artifactRendererImage(), resources: { cpu: 2, memory: 4, disk: 8 } }, { timeout: 900 });
      const renderPath = "document." + ARTIFACT_EXTENSION[type];
      await renderer.fs.uploadFile(bytes, renderPath);
      const encoded = Buffer.from(artifactVisualQaScript(type, renderPath), "utf8").toString("base64");
      const result = await renderer.process.executeCommand(
        'python3 -c "import base64;exec(base64.b64decode(\'' + encoded + '\'))"',
        await renderer.getUserHomeDir(), undefined, 900,
      );
      if (result.exitCode === 3) {
        throw new DaytonaInputError("The rendering snapshot lacks required tools. Rebuild DAYTONA_RENDERER_SNAPSHOT with Python 3, LibreOffice and Poppler.");
      }
      return result;
    } catch (error) {
      // Do not disclose provider responses that might contain credentials.
      const reason = error instanceof DaytonaInputError ? error.message : "Daytona could not prepare or run the isolated renderer. Check provider build logs, quota and snapshot configuration.";
      throw new DaytonaInputError("Rendering infrastructure failed for '" + path + "': " + reason + " The original file is preserved; retry registration, not generation.");
    } finally {
      if (renderer) {
        try { await renderer.delete(); } catch { /* TTL and auto-delete bound orphan lifetime. */ }
      }
    }
  }

  async createDocument(userId: number, args: Record<string, unknown>): Promise<ArtifactRecord & { __chuskyArtifactReady: true; generated: true }> {
    const title = presentationText(args.title, "title", 200, true)!;
    const sections = pdfSections(args.sections);
    const brand = brandInput(args.brand);
    const style = pdfStyle(mergeBrandStyle(args.style, brand));
    const requestedPath = args.path === undefined ? `artifacts/${artifactNameForType(`${title.slice(0, 70).replace(/\s+/g, "_") || "document"}`, "docx")}` : safeDaytonaPath(args.path, "path");
    const path = requestedPath.toLowerCase().endsWith(".docx") ? requestedPath : `${requestedPath}.docx`;
    const sandbox = await this.getOrCreateWorkspace(userId);
    const color = (value: string) => value.replace(/^#/, "");
    const imageFor = async (imagePath: string): Promise<Buffer> => {
      try { return Buffer.from(await sandbox.fs.downloadFile(imagePath)); }
      catch (error) { throw new DaytonaInputError(`Unable to read document image ${imagePath}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    const headerChildren: Paragraph[] = [];
    if (style.logoPath) {
      const bytes = await imageFor(style.logoPath);
      if (!bytes.length) throw new DaytonaInputError(`Document logo is empty: ${style.logoPath}`);
      headerChildren.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: [new ImageRun({ data: bytes, transformation: { width: 105, height: 42 }, type: presentationImageMime(style.logoPath) === "image/jpeg" ? "jpg" : "png" })] }));
    }
    const headerText = style.header ?? brand.companyName;
    if (headerText) headerChildren.push(new Paragraph({ alignment: style.logoPath ? AlignmentType.LEFT : AlignmentType.RIGHT, children: [new TextRun({ text: headerText, bold: true, color: color(style.primary), size: 20, font: style.fontName })] }));
    if (brand.tagline) headerChildren.push(new Paragraph({ children: [new TextRun({ text: brand.tagline, color: color(style.muted), size: 16, italics: true, font: style.fontName })] }));
    const body: Array<Paragraph | Table> = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title, bold: true, color: color(style.primary), font: style.fontBold, size: 34 })], spacing: { after: 260 } })];
    for (const section of sections) {
      if (section.pageBreakBefore) body.push(new Paragraph({ pageBreakBefore: true }));
      if (section.heading) body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: section.heading, bold: true, color: color(style.primary), font: style.fontBold })], spacing: { before: 220, after: 100 } }));
      if (section.body) body.push(new Paragraph({ children: [new TextRun({ text: section.body, font: style.fontName, color: color(style.text), size: Math.round(style.fontSize * 2) })], spacing: { after: 110 } }));
      for (const bullet of section.bullets ?? []) body.push(new Paragraph({ text: bullet, bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: bullet, font: style.fontName, color: color(style.text), size: Math.round(style.fontSize * 2) })] }));
      if (section.table) {
        body.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: section.table.map((row, rowIndex) => new TableRow({ children: row.map((cell) => new TableCell({ shading: rowIndex === 0 ? { type: ShadingType.CLEAR, color: color(style.primary) } : rowIndex % 2 ? { type: ShadingType.CLEAR, color: "F3F7FA" } : undefined, borders: { top: { style: BorderStyle.SINGLE, color: "CBD5E1", size: 2 }, bottom: { style: BorderStyle.SINGLE, color: "CBD5E1", size: 2 }, left: { style: BorderStyle.SINGLE, color: "CBD5E1", size: 2 }, right: { style: BorderStyle.SINGLE, color: "CBD5E1", size: 2 } }, children: [new Paragraph({ children: [new TextRun({ text: cell, bold: rowIndex === 0, color: rowIndex === 0 ? "FFFFFF" : color(style.text), font: style.fontName, size: 18 })] })] })) })) }));
      }
      if (section.imagePath) {
        const bytes = await imageFor(section.imagePath);
        if (!bytes.length) throw new DaytonaInputError(`Document image is empty: ${section.imagePath}`);
        body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, children: [new ImageRun({ data: bytes, transformation: { width: Math.round((section.imageWidth ?? 5.7) * 96), height: Math.round((section.imageWidth ?? 5.7) * 54) }, type: presentationImageMime(section.imagePath) === "image/jpeg" ? "jpg" : "png" })] }));
        if (section.imageAltText) body.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: section.imageAltText, italics: true, color: color(style.muted), size: 16 })] }));
      }
    }
    const doc = new Document({ creator: style.author ?? "Chusky", title, sections: [{ properties: {}, headers: headerChildren.length ? { default: new Header({ children: headerChildren }) } : undefined, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: style.footer ?? "Created by Chusky", color: color(style.muted), size: 16 }), ...(style.includePageNumbers ? [new TextRun({ text: "  •  Page " }), new TextRun({ children: [PageNumber.CURRENT] })] : [])] })] }) }, children: body }] });
    await sandbox.fs.uploadFile(Buffer.from(await Packer.toBuffer(doc)), path);
    const artifact = await this.registerArtifact(userId, sandbox, path, String(args.name ?? path.split("/").pop() ?? "document.docx"), "docx", ARTIFACT_MIME.docx);
    return { ...artifact, generated: true };
  }

  async createSpreadsheet(userId: number, args: Record<string, unknown>): Promise<ArtifactRecord & { __chuskyArtifactReady: true; generated: true }> {
    const title = presentationText(args.title, "title", 200, true)!;
    if (!Array.isArray(args.sheets) || args.sheets.length < 1 || args.sheets.length > 12) throw new DaytonaInputError("sheets must contain 1-12 sheet definitions");
    const brand = brandInput(args.brand);
    const style = presentationStyle(mergeBrandStyle(args.style, brand));
    const sheets: SpreadsheetSheetInput[] = args.sheets.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DaytonaInputError(`sheets[${index}] must be an object`);
      const input = raw as Record<string, unknown>;
      const name = presentationText(input.name, `sheets[${index}].name`, 31, true)!;
      const rows = pdfTable(input.rows ?? input.table, `sheets[${index}].rows`);
      if (!rows?.length) throw new DaytonaInputError(`sheets[${index}].rows must contain a header row and at least one row`);
      return { name, rows, tabColor: input.tabColor === undefined ? undefined : presentationColor(input.tabColor, `sheets[${index}].tabColor`, style.accent) };
    });
    const requestedPath = args.path === undefined ? `artifacts/${artifactNameForType(`${title.slice(0, 70).replace(/\s+/g, "_") || "workbook"}`, "spreadsheet")}` : safeDaytonaPath(args.path, "path");
    const path = requestedPath.toLowerCase().endsWith(".xlsx") ? requestedPath : `${requestedPath}.xlsx`;
    const sandbox = await this.getOrCreateWorkspace(userId);
    const workbook = new ExcelJS.Workbook(); workbook.creator = "Chusky"; workbook.company = brand.companyName ?? "Chusky"; workbook.created = new Date();
    let brandLogoId: number | undefined;
    if (brand.logoPath) {
      const extension = presentationImageMime(brand.logoPath) === "image/jpeg" ? "jpeg" : "png";
      if (extension !== "jpeg" && !brand.logoPath.toLowerCase().endsWith(".png")) throw new DaytonaInputError("Spreadsheet logoPath must be a PNG or JPEG image");
      let bytes: Buffer;
      try { bytes = Buffer.from(await sandbox.fs.downloadFile(brand.logoPath)); }
      catch (error) { throw new DaytonaInputError(`Unable to read spreadsheet logo ${brand.logoPath}: ${error instanceof Error ? error.message : String(error)}`); }
      if (!bytes.length) throw new DaytonaInputError(`Spreadsheet logo is empty: ${brand.logoPath}`);
      brandLogoId = workbook.addImage({ base64: `data:image/${extension};base64,${bytes.toString("base64")}`, extension });
    }
    for (const spec of sheets) {
      const sheet = workbook.addWorksheet(spec.name, { properties: { tabColor: { argb: `FF${spec.tabColor ?? style.accent}` } }, views: [{ state: "frozen", ySplit: 3 }] });
      sheet.mergeCells(1, 1, 1, Math.max(1, spec.rows[0]!.length));
      const brandLine = brand.companyName ? `${brand.companyName}${brand.tagline ? ` — ${brand.tagline}` : ""}` : title;
      const heading = sheet.getCell("A1"); heading.value = brandLine; heading.font = { name: style.headingFontFace, size: 16, bold: true, color: { argb: "FFFFFFFF" } }; heading.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${style.primary}` } }; heading.alignment = { vertical: "middle" }; sheet.getRow(1).height = 28;
      if (brandLogoId !== undefined) sheet.addImage(brandLogoId, { tl: { col: Math.max(0, spec.rows[0]!.length - 1), row: 0 }, ext: { width: 74, height: 27 } });
      sheet.mergeCells(2, 1, 2, Math.max(1, spec.rows[0]!.length)); sheet.getCell("A2").value = title; sheet.getCell("A2").font = { name: style.fontFace, italic: true, color: { argb: `FF${style.muted}` } };
      sheet.addRows(spec.rows);
      const headerRow = sheet.getRow(3); headerRow.height = 22;
      headerRow.eachCell((cell) => { cell.font = { name: style.fontFace, bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${style.accent}` } }; cell.alignment = { vertical: "middle", wrapText: true }; });
      for (let row = 4; row <= spec.rows.length + 2; row++) sheet.getRow(row).eachCell((cell) => { cell.font = { name: style.fontFace, color: { argb: `FF${style.text}` } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: row % 2 ? "FFFFFFFF" : `FF${style.surface}` } }; cell.alignment = { vertical: "top", wrapText: true }; cell.border = { bottom: { style: "hair", color: { argb: "FFD8E1EA" } } }; });
      spec.rows[0]!.forEach((_cell, index) => { sheet.getColumn(index + 1).width = Math.min(42, Math.max(13, ...spec.rows.map((row) => String(row[index] ?? "").length + 2))); });
      sheet.addTable({ name: `ChuskyTable${workbook.worksheets.length}`, ref: `A3:${String.fromCharCode(64 + spec.rows[0]!.length)}${spec.rows.length + 2}`, headerRow: true, style: { theme: "TableStyleMedium2", showRowStripes: true }, columns: spec.rows[0]!.map((name) => ({ name })), rows: spec.rows.slice(1) });
    }
    await sandbox.fs.uploadFile(Buffer.from(await workbook.xlsx.writeBuffer()), path);
    const artifact = await this.registerArtifact(userId, sandbox, path, String(args.name ?? path.split("/").pop() ?? "workbook.xlsx"), "spreadsheet", ARTIFACT_MIME.spreadsheet);
    return { ...artifact, generated: true };
  }

  async createPdf(userId: number, args: Record<string, unknown>): Promise<ArtifactRecord & { __chuskyArtifactReady: true; generated: true; pageCount?: number }> {
    const title = presentationText(args.title, "title", 240, true)!;
    const sections = pdfSections(args.sections);
    const style = pdfStyle(mergeBrandStyle(args.style, brandInput(args.brand)));
    const requestedPath = args.path === undefined
      ? `artifacts/${artifactNameForType(`${title.slice(0, 70).replace(/\s+/g, "_") || "document"}`, "pdf")}`
      : safeDaytonaPath(args.path, "path");
    const path = requestedPath.toLowerCase().endsWith(".pdf") ? requestedPath : `${requestedPath}.pdf`;
    const sandbox = await this.getOrCreateWorkspace(userId);
    const scriptPath = safeDaytonaPath(`artifacts/.chusky/pdf-generator-${randomUUID()}.py`, "generator path");
    const script = pdfGenerationScript(title, sections, style, path);
    await sandbox.fs.uploadFile(Buffer.from(script, "utf8"), scriptPath);
    try {
      const result = await sandbox.process.executeCommand(`python3 ${scriptPath}`, await sandbox.getUserHomeDir(), undefined, 240);
      if (result.exitCode !== 0) {
        const output = String(result.result ?? "");
        if (/ReportLab is unavailable|No module named ['"]?(reportlab|pypdf)/i.test(output)) {
          await this.generatePdfInRenderer(sandbox, script, path);
        } else {
          throw new DaytonaInputError(`PDF generation failed: ${output.slice(0, 800)}`);
        }
      }
    } finally {
      try { await sandbox.fs.deleteFile(scriptPath, false); } catch { /* temporary generator cleanup is best effort */ }
    }
    const artifact = await this.registerArtifact(userId, sandbox, path, String(args.name ?? path.split("/").pop() ?? "document.pdf"), "pdf", ARTIFACT_MIME.pdf);
    return { ...artifact, generated: true };
  }

  private async generatePdfInRenderer(source: Sandbox, script: string, path: string): Promise<void> {
    let renderer: Sandbox | undefined;
    try {
      const params = { name: `chusky-pdf-${randomUUID()}`, language: "python", networkBlockAll: false, public: false, autoStopInterval: 15, autoDeleteInterval: 0, ttlMinutes: 30, labels: { agent: "chusky", purpose: "artifact-pdf-generation", source_sandbox: source.id } };
      renderer = config.daytonaRendererSnapshot
        ? await this.clientFactory().create({ ...params, snapshot: config.daytonaRendererSnapshot }, { timeout: 120 })
        : await this.clientFactory().create({ ...params, image: artifactRendererImage(), resources: { cpu: 2, memory: 4, disk: 8 } }, { timeout: 900 });
      const rendererScriptPath = safeDaytonaPath(`artifacts/.chusky/pdf-generator-${randomUUID()}.py`, "generator path");
      const rendererScript = script.replace(/dependency_dir=os\.path\.abspath\(os\.path\.join\('workspace', '\.chusky', 'python-reportlab'\)\)/, "dependency_dir='/tmp/chusky-reportlab'");
      await renderer.fs.uploadFile(Buffer.from(rendererScript, "utf8"), rendererScriptPath);
      const result = await renderer.process.executeCommand(`python3 ${rendererScriptPath}`, await renderer.getUserHomeDir(), undefined, 900);
      if (result.exitCode !== 0) throw new DaytonaInputError(`PDF generation failed in isolated renderer: ${String(result.result ?? "unknown error").slice(0, 800)}`);
      const generated = Buffer.from(await renderer.fs.downloadFile(path));
      if (!generated.length) throw new DaytonaInputError("PDF renderer produced an empty file");
      await source.fs.uploadFile(generated, path);
    } finally {
      if (renderer) {
        try { await renderer.delete(); } catch { /* bounded by TTL if provider cleanup is unavailable */ }
      }
    }
  }

  async createPresentation(userId: number, args: Record<string, unknown>): Promise<ArtifactRecord & { __chuskyArtifactReady: true; generated: true; slideCount: number }> {
    const title = presentationText(args.title, "title", 200, true)!;
    const slides = presentationSlides(args.slides);
    const style = presentationStyle(mergeBrandStyle(args.style, brandInput(args.brand)));
    const requestedPath = args.path === undefined
      ? `artifacts/${artifactNameForType(`${title.slice(0, 70).replace(/\s+/g, "_") || "presentation"}`, "presentation")}`
      : safeDaytonaPath(args.path, "path");
    const path = requestedPath.toLowerCase().endsWith(".pptx") ? requestedPath : `${requestedPath}.pptx`;
    const sandbox = await this.getOrCreateWorkspace(userId);
    const bytes = await presentationBytes(sandbox, title, slides, style);
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
    let normalizedPath = path.toLowerCase().endsWith(extension) ? path : `${path}${extension}`;
    const normalizedName = artifactNameForType(name, type);
    let details: { size?: number; isDir?: boolean } | undefined;
    // Preserve the historical extension-normalization behavior for files
    // created without an extension, while still allowing a pre-existing
    // correctly suffixed file to pass through without a move.
    if (normalizedPath !== path) {
      try {
        await sandbox.fs.getFileDetails(path);
        await sandbox.fs.moveFiles(path, normalizedPath);
        details = await sandbox.fs.getFileDetails(normalizedPath) as { size?: number; isDir?: boolean };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found|no such file|does not exist/i.test(message)) throw error;
      }
    }
    if (!details) {
      try {
        details = await sandbox.fs.getFileDetails(normalizedPath) as { size?: number; isDir?: boolean };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found|no such file|does not exist/i.test(message)) throw error;
        const recovered = await this.findUniqueArtifactPath(sandbox, normalizedPath, extension);
        if (recovered) {
          normalizedPath = recovered.path;
          details = recovered.details;
        } else {
          throw new DaytonaInputError(`Artifact file was not found at '${normalizedPath}'. Generate the file in Daytona and verify the returned workspace-relative path before registering it.`);
        }
      }
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

  private async findUniqueArtifactPath(sandbox: Sandbox, requestedPath: string, extension: string): Promise<{ path: string; details: { size?: number; isDir?: boolean } } | undefined> {
    const requestedName = requestedPath.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
    const requestedStem = requestedName.endsWith(extension) ? requestedName.slice(0, -extension.length) : requestedName;
    const alternatePath = /^workspace\//i.test(requestedPath) ? requestedPath.slice(10) : `workspace/${requestedPath}`;
    {
      try {
        const details = await sandbox.fs.getFileDetails(alternatePath) as { size?: number; isDir?: boolean };
        return { path: alternatePath, details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found|no such file|does not exist/i.test(message)) return undefined;
      }
    }
    try {
      const files = await sandbox.fs.listFiles(".", { depth: 5 }) as FileInfo[];
      const candidates = files
        .filter((file) => !file.isDir && typeof file.path === "string" && file.path.length > 0)
        .map((file) => ({ path: safeDaytonaPath(file.path!, "artifact candidate"), file }))
        .filter(({ path: candidatePath }) => {
          const candidateName = candidatePath.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
          const candidateStem = candidateName.endsWith(extension) ? candidateName.slice(0, -extension.length) : candidateName;
          return candidateName === requestedName || candidateStem === requestedStem;
        });
      const unique = [...new Map(candidates.map(({ path, file }) => [path, { path, file }])).values()];
      if (unique.length !== 1) {
        if (unique.length > 1) {
          throw new DaytonaInputError(`Artifact path '${requestedPath}' was not found and matched multiple workspace files: ${unique.slice(0, 5).map(({ path }) => path).join(", ")}`);
        }
        return undefined;
      }
      const match = unique[0]!;
      const details = await sandbox.fs.getFileDetails(match.path) as { size?: number; isDir?: boolean };
      return { path: match.path, details };
    } catch (error) {
      if (error instanceof DaytonaInputError) throw error;
      // Listing is a recovery aid, not a reason to mask the original missing
      // path error when the provider temporarily rejects the directory scan.
      return undefined;
    }
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
