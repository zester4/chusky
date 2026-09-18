#!/usr/bin/env python3
import argparse, zipfile, tempfile
from pathlib import Path
from xml.etree import ElementTree as ET

CP = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
DC = "http://purl.org/dc/elements/1.1/"
DCTERMS = "http://purl.org/dc/terms/"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    src, out = Path(args.input), Path(args.out)

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        with zipfile.ZipFile(src) as z:
            z.extractall(td)

        core = td / "docProps" / "core.xml"
        if core.exists():
            tree = ET.parse(core)
            root = tree.getroot()
            for child in list(root):
                local = child.tag.split("}")[-1]
                if local in {"creator", "lastModifiedBy"}:
                    child.text = ""
            tree.write(core, encoding="utf-8", xml_declaration=True)

        custom = td / "docProps" / "custom.xml"
        if custom.exists():
            custom.unlink()

        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for p in td.rglob("*"):
                if p.is_file():
                    z.write(p, p.relative_to(td))
    print(out)

if __name__ == "__main__":
    main()
