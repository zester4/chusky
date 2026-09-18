#!/usr/bin/env python3
import argparse, json, zipfile
from xml.etree import ElementTree as ET

NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

def signature(path):
    with zipfile.ZipFile(path) as z:
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        sheets = [
            (s.attrib.get("name"), s.attrib.get("state", "visible"))
            for s in wb.findall(".//x:sheets/x:sheet", NS)
        ]
        return {
            "sheets": sheets,
            "tables": sorted(n for n in z.namelist() if n.startswith("xl/tables/") and n.endswith(".xml")),
            "charts": sorted(n for n in z.namelist() if n.startswith("xl/charts/") and n.endswith(".xml")),
            "external_links": sorted(n for n in z.namelist() if n.startswith("xl/externalLinks/")),
        }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("left")
    ap.add_argument("right")
    args = ap.parse_args()
    a, b = signature(args.left), signature(args.right)
    out = {"left": a, "right": b, "equal": a == b}
    print(json.dumps(out, indent=2))
    raise SystemExit(0 if out["equal"] else 1)

if __name__ == "__main__":
    main()
