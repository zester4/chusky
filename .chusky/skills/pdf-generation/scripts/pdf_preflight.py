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
    path = Path(args.pdf)
    reader = PdfReader(str(path))
    result = {
        "path": str(path),
        "bytes": path.stat().st_size,
        "encrypted": bool(reader.is_encrypted),
        "pages": len(reader.pages),
        "metadata": {str(k): str(v) for k, v in (reader.metadata or {}).items()},
        "page_sizes": [],
        "has_form": bool(reader.get_fields()),
        "annotations": 0,
    }
    if reader.is_encrypted:
        print(json.dumps(result, indent=2))
        raise SystemExit(2)
    for p in reader.pages:
        box = p.mediabox
        result["page_sizes"].append([float(box.width), float(box.height)])
        result["annotations"] += len(p.get("/Annots", []))
    print(json.dumps(result, indent=2))
    if result["pages"] < 1 or result["bytes"] < 100:
        raise SystemExit(3)

if __name__ == "__main__":
    main()
