#!/usr/bin/env python3
import argparse, json, zipfile
from xml.etree import ElementTree as ET

NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    args = ap.parse_args()
    with zipfile.ZipFile(args.xlsx) as z:
        root = ET.fromstring(z.read("xl/workbook.xml"))
        out = []
        for d in root.findall(".//x:definedNames/x:definedName", NS):
            out.append({
                "name": d.attrib.get("name"),
                "localSheetId": d.attrib.get("localSheetId"),
                "hidden": d.attrib.get("hidden"),
                "formula": d.text or ""
            })
        print(json.dumps(out, indent=2))
if __name__ == "__main__":
    main()
