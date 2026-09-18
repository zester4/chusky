#!/usr/bin/env python3
import argparse, os
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--out", default=None)
    ap.add_argument("--dpi", type=int, default=144)
    args = ap.parse_args()
    try:
        import fitz
    except ImportError:
        raise SystemExit("PyMuPDF is required: pip install pymupdf")
    src = Path(args.pdf)
    out = Path(args.out or (src.with_suffix("").as_posix() + "_rendered"))
    out.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(src)
    zoom = args.dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    for i, page in enumerate(doc):
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        dest = out / f"page-{i+1:03d}.png"
        pix.save(dest)
        print(dest)
    if len(doc) == 0:
        raise SystemExit("PDF has zero pages")

if __name__ == "__main__":
    main()
