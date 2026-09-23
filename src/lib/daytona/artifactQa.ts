import type { ArtifactType } from "../../store.js";

// Run in the sandbox user's home, the same base used by the filesystem SDK.
// Count pages with a parser and render each page; PDF markers are not evidence
// that a file can be opened. Never install packages during registration.
// Exit 3 requests an isolated renderer; exit 2 means the document failed QA.
export function artifactVisualQaScript(type: ArtifactType, path: string): string {
  return `path=${JSON.stringify(path)}\nkind=${JSON.stringify(type)}\n# Every structured artifact must be rendered before delivery. A package can be\n# structurally valid while still clipping text or producing a blank Office page.\nrequire_renderer=True\n` + String.raw`
import os, shutil, subprocess, sys, tempfile

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
                fail('PDF page ' + str(page) + ' renders blank; repair the document before registration.')
            os.remove(preview)
            os.remove(mono)
        print('visual QA passed: rendered all ' + str(page_count) + ' page(s)')
    except subprocess.TimeoutExpired:
        fail('Document rendering timed out; simplify or split the document and retry registration.')
`;
}
