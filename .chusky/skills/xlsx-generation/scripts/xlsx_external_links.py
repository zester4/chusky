#!/usr/bin/env python3
import argparse, json, zipfile
from xml.etree import ElementTree as ET

PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    args = ap.parse_args()
    results = []
    with zipfile.ZipFile(args.xlsx) as z:
        for name in z.namelist():
            if not name.endswith(".rels"):
                continue
            try:
                root = ET.fromstring(z.read(name))
            except Exception:
                continue
            for rel in root:
                target = rel.attrib.get("Target", "")
                mode = rel.attrib.get("TargetMode")
                typ = rel.attrib.get("Type", "")
                if mode == "External" or "externalLink" in typ or target.startswith(("http://","https://","file:")):
                    results.append({"rels": name, "target": target, "type": typ, "mode": mode})
    print(json.dumps(results, indent=2))

if __name__ == "__main__":
    main()
