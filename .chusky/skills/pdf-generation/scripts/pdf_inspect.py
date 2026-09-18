#!/usr/bin/env python3
import argparse, json
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    args = ap.parse_args()
    try:
        from pypdf import PdfReader
    except ImportError:
        raise SystemExit("pypdf is required: pip install pypdf")
    r = PdfReader(args.pdf)
    data = {"pages": len(r.pages), "encrypted": bool(r.is_encrypted), "metadata": {}}
    if not r.is_encrypted:
        data["metadata"] = {str(k): str(v) for k,v in (r.metadata or {}).items()}
        data["pages_detail"] = []
        for i,p in enumerate(r.pages, 1):
            data["pages_detail"].append({
                "page": i,
                "width": float(p.mediabox.width),
                "height": float(p.mediabox.height),
                "rotation": int(p.get("/Rotate", 0) or 0),
                "annotations": len(p.get("/Annots", [])),
            })
    print(json.dumps(data, indent=2))

if __name__ == "__main__":
    main()
