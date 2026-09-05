import type { ArtifactType } from "../../store.js";

// Run in the sandbox user's home, the same base used by the filesystem SDK.
// Count pages with a parser and render each page; PDF markers are not evidence
// that a file can be opened. Dependencies are repaired in the sandbox, not host.
export function artifactVisualQaScript(type: ArtifactType, path: string): string {
  return `path=${JSON.stringify(path)}\nkind=${JSON.stringify(type)}\nrequire_renderer=${["pdf", "docx"].includes(type) ? "True" : "False"}\n` + String.raw`
import os, shutil, subprocess, sys, tempfile

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(2)

def office_binary():
    return shutil.which('libreoffice') or shutil.which('soffice')

def missing_packages():
    packages=[]
    if not shutil.which('pdfinfo') or not shutil.which('pdftoppm'):
        packages.append('poppler-utils')
    if kind != 'pdf' and not office_binary():
        packages.extend(['libreoffice-writer', 'fonts-dejavu-core'])
    return packages

path=os.path.abspath(path)
if not os.path.isfile(path):
    fail('artifact file does not exist: ' + path)
packages=missing_packages()
if packages and require_renderer:
    # Recheck on every registration: failed setup must not poison future retries.
    apt=shutil.which('apt-get')
    prefix=[] if os.geteuid() == 0 else ['sudo', '-n']
    if not apt or (prefix and not shutil.which('sudo')):
        fail('Renderer setup unavailable. Install ' + ' '.join(packages) + ' in the Daytona sandbox and retry registration of the same file; complete-page inspection is required.')
    env=os.environ.copy()
    env['DEBIAN_FRONTEND']='noninteractive'
    try:
        for args in [['update'], ['install', '-y', '--no-install-recommends'] + packages]:
            setup=subprocess.run(prefix + [apt, '-o', 'DPkg::Lock::Timeout=60'] + args, env=env, capture_output=True, timeout=180)
            if setup.returncode != 0:
                fail('Renderer setup failed. Install ' + ' '.join(packages) + ' in the Daytona sandbox and retry registration of the same file.')
    except subprocess.TimeoutExpired:
        fail('Renderer setup timed out. Retry registration of the same file after sandbox package installation finishes.')
    packages=missing_packages()
if packages:
    if require_renderer:
        fail('Renderer setup incomplete: missing ' + ' '.join(packages))
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
        page_count=0
        for line in info.stdout.splitlines():
            if line.startswith('Pages:'):
                page_count=int(line.split(':', 1)[1].strip())
        if page_count < 1:
            fail('PDF has no readable pages according to pdfinfo.')
        # Bound work and memory while still checking every page of accepted files.
        if page_count > 500:
            fail('Document exceeds the 500-page rendering limit; split it before registration.')
        prefix=os.path.join(tmp, 'page')
        for page in range(1, page_count + 1):
            rendered=subprocess.run([shutil.which('pdftoppm'), '-f', str(page), '-l', str(page), '-singlefile', '-scale-to', '1600', '-png', pdf, prefix], capture_output=True, timeout=30)
            preview=prefix + '.png'
            if rendered.returncode != 0 or not os.path.isfile(preview):
                fail('PDF rasterization failed on page ' + str(page) + '; repair the document before registration.')
            with open(preview, 'rb') as image:
                if image.read(8) != b'\x89PNG\r\n\x1a\n' or os.path.getsize(preview) < 100:
                    fail('PDF renderer produced an invalid preview for page ' + str(page))
            os.remove(preview)
        print('visual QA passed: rendered all ' + str(page_count) + ' page(s)')
    except subprocess.TimeoutExpired:
        fail('Document rendering timed out; simplify or split the document and retry registration.')
`;
}
