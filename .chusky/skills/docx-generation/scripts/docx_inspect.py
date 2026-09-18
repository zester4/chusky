#!/usr/bin/env python3
import argparse, json, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx")
    args = ap.parse_args()
    path = Path(args.docx)
    if not zipfile.is_zipfile(path):
        raise SystemExit("Not a valid DOCX/ZIP package.")
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        required = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
        missing = sorted(required - names)
        if missing:
            raise SystemExit("Missing required parts: " + ", ".join(missing))
        root = ET.fromstring(z.read("word/document.xml"))
        paras = root.findall(".//w:p", NS)
        tables = root.findall(".//w:tbl", NS)
        sections = root.findall(".//w:sectPr", NS)
        result = {
            "path": str(path),
            "bytes": path.stat().st_size,
            "parts": len(names),
            "paragraphs": len(paras),
            "tables": len(tables),
            "sections": len(sections),
            "comments": "word/comments.xml" in names,
            "footnotes": "word/footnotes.xml" in names,
            "endnotes": "word/endnotes.xml" in names,
            "custom_properties": "docProps/custom.xml" in names,
            "media_files": len([n for n in names if n.startswith("word/media/")]),
        }
        print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
