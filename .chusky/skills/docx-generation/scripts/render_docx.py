#!/usr/bin/env python3
import argparse, os, shutil, subprocess, tempfile
from pathlib import Path

def main():
    ap = argparse.ArgumentParser(description="Render DOCX to PDF and PNG pages for visual QA.")
    ap.add_argument("docx")
    ap.add_argument("--output_dir", required=True)
    ap.add_argument("--emit_pdf", action="store_true")
    ap.add_argument("--dpi", type=int, default=144)
    args = ap.parse_args()

    src = Path(args.docx).resolve()
    out = Path(args.output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)

    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise SystemExit("LibreOffice/soffice not found.")

    profile = tempfile.mkdtemp(prefix="chusky-lo-")
    env = os.environ.copy()
    env["HOME"] = profile
    cmd = [
        soffice, "--headless", "--nologo", "--nodefault", "--nofirststartwizard",
        f"-env:UserInstallation=file://{profile}",
        "--convert-to", "pdf", "--outdir", str(out), str(src)
    ]
    p = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=180)
    pdf = out / f"{src.stem}.pdf"
    if not pdf.exists() or pdf.stat().st_size == 0:
        print(p.stdout)
        print(p.stderr)
        raise SystemExit("DOCX render failed: PDF was not produced.")

    pdftoppm = shutil.which("pdftoppm")
    if pdftoppm:
        prefix = out / "page"
        q = subprocess.run(
            [pdftoppm, "-png", "-r", str(args.dpi), str(pdf), str(prefix)],
            text=True, capture_output=True, timeout=180
        )
        if q.returncode:
            print(q.stderr)
            raise SystemExit(q.returncode)
    else:
        try:
            import fitz
        except ImportError:
            raise SystemExit("Need pdftoppm or PyMuPDF to rasterize PDF pages.")
        doc = fitz.open(pdf)
        scale = args.dpi / 72.0
        for i, page in enumerate(doc, 1):
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            pix.save(out / f"page-{i}.png")

    pages = sorted(out.glob("page-*.png"))
    if not pages:
        raise SystemExit("No rendered page PNGs were created.")
    for pth in pages:
        print(pth)
    if not args.emit_pdf:
        pdf.unlink(missing_ok=True)

if __name__ == "__main__":
    main()
