#!/usr/bin/env python3
import argparse, os, shutil, subprocess, tempfile
from pathlib import Path

def main():
    ap = argparse.ArgumentParser(description="Render an XLSX to PDF for visual QA.")
    ap.add_argument("xlsx")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--png", action="store_true", help="Also rasterize PDF pages to PNG")
    ap.add_argument("--dpi", type=int, default=144)
    args = ap.parse_args()

    src = Path(args.xlsx).resolve()
    outdir = Path(args.outdir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise SystemExit("LibreOffice/soffice not found")

    profile = tempfile.mkdtemp(prefix="chusky-lo-")
    env = os.environ.copy()
    env["HOME"] = profile
    cmd = [
        soffice, "--headless", "--nologo", "--nodefault", "--nofirststartwizard",
        f"-env:UserInstallation=file://{profile}",
        "--convert-to", "pdf", "--outdir", str(outdir), str(src)
    ]
    p = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=240)
    pdf = outdir / f"{src.stem}.pdf"
    if not pdf.exists() or pdf.stat().st_size == 0:
        print(p.stdout); print(p.stderr)
        raise SystemExit("Spreadsheet PDF render failed")
    print(pdf)

    if args.png:
        ppm = shutil.which("pdftoppm")
        if ppm:
            q = subprocess.run(
                [ppm, "-png", "-r", str(args.dpi), str(pdf), str(outdir / "page")],
                text=True, capture_output=True, timeout=240
            )
            if q.returncode:
                print(q.stderr)
                raise SystemExit(q.returncode)
        else:
            try:
                import fitz
            except ImportError:
                raise SystemExit("Need pdftoppm or PyMuPDF for PNG rendering")
            doc = fitz.open(pdf)
            scale = args.dpi / 72.0
            for i, page in enumerate(doc, 1):
                pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                pix.save(outdir / f"page-{i}.png")

if __name__ == "__main__":
    main()
