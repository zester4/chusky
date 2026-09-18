#!/usr/bin/env python3
import argparse, json
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    try:
        from pypdf import PdfReader
    except ImportError:
        raise SystemExit("pypdf is required: pip install pypdf")
    r = PdfReader(args.pdf)
    if r.is_encrypted:
        raise SystemExit("Encrypted PDF")
    pages = []
    for i,p in enumerate(r.pages, 1):
        pages.append({"page": i, "text": p.extract_text() or ""})
    if args.json:
        print(json.dumps(pages, ensure_ascii=False, indent=2))
    else:
        for page in pages:
            print(f"\n--- PAGE {page['page']} ---\n")
            print(page["text"])

if __name__ == "__main__":
    main()
