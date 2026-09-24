import type { ArtifactType } from "../../store.js";

// Run in the sandbox user's home, the same base used by the filesystem SDK.
// Count pages with a parser and render each page; PDF markers are not evidence
// that a file can be opened. Never install packages during registration.
// Exit 3 requests an isolated renderer; exit 2 means the document failed QA.
function artifactVisualQaScriptBody(type: ArtifactType, path: string): string {
  return `path=${JSON.stringify(path)}\nkind=${JSON.stringify(type)}\n# Every structured artifact must be rendered before delivery. A package can be\n# structurally valid while still clipping text or producing a blank Office page.\nrequire_renderer=True\n` + String.raw`
import json, math, os, shutil, subprocess, sys, tempfile, zipfile, xml.etree.ElementTree as ET

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(2)

def office_binary():
    return shutil.which('libreoffice') or shutil.which('soffice')

def missing_packages():
    packages=[]
    if not shutil.which('pdfinfo') or not shutil.which('pdftoppm') or not shutil.which('pdftotext') or not shutil.which('pdffonts'):
        packages.append('poppler-utils')
    if not shutil.which('qpdf'):
        packages.append('qpdf')
    if kind != 'pdf' and not office_binary():
        packages.extend(['libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress', 'fonts-dejavu-core'])
    return packages

path=os.path.abspath(path)
if not os.path.isfile(path):
    fail('artifact file does not exist: ' + path)
packages=missing_packages()
if packages:
    if require_renderer:
        print('CHUSKY_RENDERER_UNAVAILABLE: ' + ' '.join(packages), file=sys.stderr)
        raise SystemExit(3)
    print('visual QA skipped: renderer dependencies unavailable')
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix='chusky-artifact-qa-') as tmp:
    try:
        pdf=path
        if kind != 'pdf':
            profile=os.path.join(tmp, 'libreoffice-profile')
            from pathlib import Path
            converted=subprocess.run([office_binary(), '--headless', '--norestore', '--nofirststartwizard', '-env:UserInstallation=' + Path(profile).as_uri(), '--convert-to', 'pdf', '--outdir', tmp, path], capture_output=True, timeout=120)
            pdf=os.path.join(tmp, os.path.splitext(os.path.basename(path))[0] + '.pdf')
            if converted.returncode != 0 or not os.path.isfile(pdf):
                fail('Office-to-PDF conversion failed; verify the source document and retry registration.')
        formula_count=0
        formula_value_count=0
        formula_error_count=0
        expected_formula_values=globals().get('expected_formula_values', {})
        formula_expectations_checked=0
        if kind == 'spreadsheet':
            # Re-save through LibreOffice Calc so the inspected caches come
            # from an independent calculation engine, not ExcelJS/the source.
            recalc_dir=os.path.join(tmp, 'recalculated')
            os.makedirs(recalc_dir)
            recalc_profile=os.path.join(tmp, 'calc-profile')
            recalc=subprocess.run([office_binary(), '--headless', '--norestore', '--nofirststartwizard', '-env:UserInstallation=' + __import__('pathlib').Path(recalc_profile).as_uri(), '--convert-to', 'xlsx', '--outdir', recalc_dir, path], capture_output=True, timeout=120)
            recalculated=os.path.join(recalc_dir, os.path.basename(path))
            if recalc.returncode != 0 or not os.path.isfile(recalculated):
                fail('Spreadsheet formula recalculation failed; repair the workbook or simplify its formulas before registration.')
            try:
                with zipfile.ZipFile(recalculated) as book:
                    for part in book.namelist():
                        if not part.startswith('xl/worksheets/') or not part.endswith('.xml'):
                            continue
                        sheet=ET.fromstring(book.read(part))
                        for cell in sheet.iter():
                            if not cell.tag.endswith('}c'):
                                continue
                            formula=next((node for node in cell if node.tag.endswith('}f')), None)
                            value=next((node for node in cell if node.tag.endswith('}v')), None)
                            if formula is None:
                                continue
                            formula_count += 1
                            if cell.attrib.get('t') == 'e':
                                formula_error_count += 1
                            elif value is not None and value.text is not None:
                                formula_value_count += 1
                                formula_key=part.split('/')[-1] + '!' + cell.attrib.get('r', '')
                                if formula_key in expected_formula_values:
                                    expected=expected_formula_values[formula_key]
                                    actual=value.text
                                    if isinstance(expected, bool):
                                        matched=(actual == ('1' if expected else '0'))
                                    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
                                        try: matched=math.isclose(float(actual), float(expected), rel_tol=1e-9, abs_tol=1e-9)
                                        except ValueError: matched=False
                                    else:
                                        matched=(actual == str(expected))
                                    if not matched:
                                        fail('Spreadsheet calculated value did not match the expected value at ' + formula_key + '.')
                                    formula_expectations_checked += 1
                if formula_error_count:
                    fail('Spreadsheet recalculation produced ' + str(formula_error_count) + ' formula error(s).')
                if formula_value_count != formula_count:
                    fail('Spreadsheet recalculation did not produce a cached value for every formula (' + str(formula_value_count) + '/' + str(formula_count) + ').')
                if formula_expectations_checked != len(expected_formula_values):
                    fail('Spreadsheet recalculation did not independently verify every declared expected formula value.')
            except (OSError, zipfile.BadZipFile, ET.ParseError, KeyError) as error:
                fail('Recalculated spreadsheet could not be independently inspected: ' + str(error))
        info=subprocess.run([shutil.which('pdfinfo'), pdf], env={**os.environ, 'LC_ALL': 'C'}, text=True, capture_output=True, timeout=30)
        if info.returncode != 0:
            fail('PDF parser could not open the document; regenerate or repair the PDF before registration.')
        syntax=subprocess.run([shutil.which('qpdf'), '--check', pdf], env={**os.environ, 'LC_ALL': 'C'}, text=True, capture_output=True, timeout=30)
        if syntax.returncode != 0:
            fail('PDF syntax validation failed; repair the document before registration.')
        page_count=0
        encrypted=False
        tagged='unknown'
        for line in info.stdout.splitlines():
            if line.startswith('Pages:'):
                page_count=int(line.split(':', 1)[1].strip())
            if line.startswith('Encrypted:'):
                encrypted=line.split(':', 1)[1].strip().lower() == 'yes'
            if line.startswith('Tagged:'):
                tagged=line.split(':', 1)[1].strip().lower()
        if encrypted:
            fail('Encrypted PDFs cannot be safely inspected for delivery; provide an unencrypted copy.')
        if page_count < 1:
            fail('PDF has no readable pages according to pdfinfo.')
        # Bound work and memory while still checking every page of accepted files.
        if page_count > 500:
            fail('Document exceeds the 500-page rendering limit; split it before registration.')
        fonts=subprocess.run([shutil.which('pdffonts'), pdf], env={**os.environ, 'LC_ALL': 'C'}, text=True, capture_output=True, timeout=30)
        if fonts.returncode != 0:
            fail('PDF font inspection failed; repair the document before registration.')
        font_rows=[line for line in (fonts.stdout or '').splitlines() if line.strip() and not line.startswith('name') and not line.startswith('-')]
        embedded_fonts=sum(1 for line in font_rows if len(line.split()) > 2 and line.split()[2].lower() == 'yes')
        print('pdf semantic checks passed: syntax=qpdf, encrypted=no, tagged=' + str(tagged) + ', embedded_fonts=' + str(embedded_fonts))
        prefix=os.path.join(tmp, 'page')
        blank_spreadsheet_pages=0
        extracted_chars=0
        extracted_document_text=''
        for page in range(1, page_count + 1):
            rendered=subprocess.run([shutil.which('pdftoppm'), '-f', str(page), '-l', str(page), '-singlefile', '-scale-to', '1600', '-png', pdf, prefix], capture_output=True, timeout=30)
            preview=prefix + '.png'
            if rendered.returncode != 0 or not os.path.isfile(preview):
                fail('PDF rasterization failed on page ' + str(page) + '; repair the document before registration.')
            with open(preview, 'rb') as image:
                if image.read(8) != b'\x89PNG\r\n\x1a\n' or os.path.getsize(preview) < 100:
                    fail('PDF renderer produced an invalid preview for page ' + str(page))
            # Text extraction is a semantic signal, not a requirement: image-
            # only PDFs are valid. The monochrome render catches a page whose
            # content stream renders to a blank canvas.
            extracted=subprocess.run([shutil.which('pdftotext'), '-f', str(page), '-l', str(page), '-layout', pdf, '-'], capture_output=True, timeout=30)
            if extracted.returncode != 0:
                fail('PDF text inspection failed on page ' + str(page))
            page_text=(extracted.stdout or b'').decode('utf-8', 'replace') if isinstance(extracted.stdout, bytes) else (extracted.stdout or '')
            extracted_document_text += '\n' + page_text
            extracted_chars += len(page_text.strip())
            mono_prefix=prefix + '-mono'
            # -mono already selects PBM output. pdftoppm has no -pbm
            # flag, so passing it makes otherwise valid Office exports fail
            # the semantic-render stage after successful conversion.
            monochrome=subprocess.run([shutil.which('pdftoppm'), '-f', str(page), '-l', str(page), '-singlefile', '-scale-to', '800', '-mono', pdf, mono_prefix], capture_output=True, timeout=30)
            mono=mono_prefix + '.pbm'
            if monochrome.returncode != 0 or not os.path.isfile(mono):
                fail('PDF semantic render failed on page ' + str(page))
            with open(mono, 'rb') as image:
                data=image.read()
            first=data.find(b'\n')
            second=data.find(b'\n', first + 1)
            pixels=data[second + 1:] if second >= 0 else b''
            if not pixels or len(set(pixels)) < 2:
                if kind == 'spreadsheet' and not (extracted.stdout or b'').strip():
                    # LibreOffice may emit empty print pages for intentionally
                    # blank worksheets or unused print regions. The workbook
                    # itself remains valid; all pages are still converted,
                    # parsed, rasterized, and checked before this exception.
                    blank_spreadsheet_pages += 1
                else:
                    fail('PDF page ' + str(page) + ' renders blank; repair the document before registration.')
            os.remove(preview)
            os.remove(mono)
        expected_text=globals().get('expected_text', '')
        expected_title_matched=not bool(expected_text)
        if expected_text:
            normalize=lambda value: ' '.join(value.casefold().split())
            expected_title_matched=normalize(expected_text) in normalize(extracted_document_text)
            if not expected_title_matched:
                fail('Rendered content does not include the expected document title; correct the artifact before registration.')
        evidence={'type':kind,'pagesRendered':page_count,'extractedCharacters':extracted_chars,'expectedTitleChecked':bool(expected_text),'expectedTitleMatched':expected_title_matched,'formulaCellsRecalculated':formula_count,'formulaValuesInspected':formula_value_count,'formulaExpectationsChecked':formula_expectations_checked,'formulaErrors':formula_error_count}
        print('CHUSKY_VERIFICATION_JSON=' + json.dumps(evidence, separators=(',', ':')))
        print('visual QA passed: rendered all ' + str(page_count) + ' page(s)' + ('; blank spreadsheet print pages=' + str(blank_spreadsheet_pages) if blank_spreadsheet_pages else ''))
    except subprocess.TimeoutExpired:
        fail('Document rendering timed out; simplify or split the document and retry registration.')
`;
}

export function artifactVisualQaScript(type: ArtifactType, path: string, expectedText?: string, expectedFormulaValues: Record<string, string | number | boolean> = {}): string {
  const script = artifactVisualQaScriptBody(type, path);
  return script.replace(`kind=${JSON.stringify(type)}\n`, `kind=${JSON.stringify(type)}\nexpected_text=${JSON.stringify(expectedText ?? "")}\nexpected_formula_values=__import__('json').loads(${JSON.stringify(JSON.stringify(expectedFormulaValues))})\n`);
}
