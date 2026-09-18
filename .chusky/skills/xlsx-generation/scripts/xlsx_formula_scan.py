#!/usr/bin/env python3
import argparse, json, zipfile
from xml.etree import ElementTree as ET

NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--contains", default=None, help="Optional substring filter for formulas")
    args = ap.parse_args()
    found = []
    with zipfile.ZipFile(args.xlsx) as z:
        for name in z.namelist():
            if not (name.startswith("xl/worksheets/") and name.endswith(".xml")):
                continue
            root = ET.fromstring(z.read(name))
            for c in root.findall(".//x:c", NS):
                f = c.find("x:f", NS)
                if f is None:
                    continue
                formula = f.text or ""
                if args.contains and args.contains.lower() not in formula.lower():
                    continue
                found.append({"part": name, "cell": c.attrib.get("r"), "formula": formula})
    print(json.dumps(found, indent=2))

if __name__ == "__main__":
    main()
