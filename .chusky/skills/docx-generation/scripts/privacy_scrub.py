#!/usr/bin/env python3
import argparse, zipfile, tempfile
from pathlib import Path
from lxml import etree

WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

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
        core = td/"docProps"/"core.xml"
        if core.exists():
            tree = etree.parse(str(core))
            for el in tree.getroot():
                local = etree.QName(el).localname
                if local in {"creator","lastModifiedBy"}:
                    el.text = ""
            tree.write(str(core), xml_declaration=True, encoding="UTF-8", standalone="yes")
        custom = td/"docProps"/"custom.xml"
        if custom.exists():
            custom.unlink()
        for p in (td/"word").glob("**/*.xml"):
            try:
                tree = etree.parse(str(p))
            except Exception:
                continue
            changed = False
            for el in tree.getroot().iter():
                for key in list(el.attrib):
                    if etree.QName(key).namespace == WNS and etree.QName(key).localname.startswith("rsid"):
                        del el.attrib[key]; changed = True
            if changed:
                tree.write(str(p), xml_declaration=True, encoding="UTF-8", standalone="yes")
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for p in td.rglob("*"):
                if p.is_file():
                    z.write(p, p.relative_to(td))
    print(out)

if __name__ == "__main__":
    main()
