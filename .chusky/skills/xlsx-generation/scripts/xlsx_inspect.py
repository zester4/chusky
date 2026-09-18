#!/usr/bin/env python3
import argparse, json, re, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"x": MAIN, "r": REL}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    args = ap.parse_args()
    path = Path(args.xlsx)
    if not zipfile.is_zipfile(path):
        raise SystemExit("Not a valid XLSX/ZIP package")
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        required = {"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"}
        missing = sorted(required - names)
        if missing:
            raise SystemExit("Missing required parts: " + ", ".join(missing))

        wb = ET.fromstring(z.read("xl/workbook.xml"))
        sheets = []
        for s in wb.findall(".//x:sheets/x:sheet", NS):
            sheets.append({
                "name": s.attrib.get("name"),
                "sheetId": s.attrib.get("sheetId"),
                "relationship": s.attrib.get(f"{{{REL}}}id"),
                "state": s.attrib.get("state", "visible")
            })

        result = {
            "path": str(path),
            "bytes": path.stat().st_size,
            "parts": len(names),
            "sheets": sheets,
            "tables": len([n for n in names if n.startswith("xl/tables/") and n.endswith(".xml")]),
            "charts": len([n for n in names if n.startswith("xl/charts/") and n.endswith(".xml")]),
            "drawings": len([n for n in names if n.startswith("xl/drawings/") and n.endswith(".xml")]),
            "comments_parts": len([n for n in names if "comments" in n and n.endswith(".xml")]),
            "external_links": len([n for n in names if n.startswith("xl/externalLinks/")]),
            "has_calc_chain": "xl/calcChain.xml" in names,
            "has_shared_strings": "xl/sharedStrings.xml" in names,
        }
        print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
