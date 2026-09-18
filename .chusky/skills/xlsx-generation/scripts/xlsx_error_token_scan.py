#!/usr/bin/env python3
import argparse, json, zipfile
from xml.etree import ElementTree as ET

NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
ERRORS = {"#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!"}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    args = ap.parse_args()
    results = []
    with zipfile.ZipFile(args.xlsx) as z:
        for name in z.namelist():
            if not (name.startswith("xl/worksheets/") and name.endswith(".xml")):
                continue
            root = ET.fromstring(z.read(name))
            for c in root.findall(".//x:c", NS):
                v = c.find("x:v", NS)
                if v is not None and (v.text or "") in ERRORS:
                    results.append({"part": name, "cell": c.attrib.get("r"), "error": v.text})
    print(json.dumps(results, indent=2))
    raise SystemExit(1 if results else 0)

if __name__ == "__main__":
    main()
