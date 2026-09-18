#!/usr/bin/env python3
import argparse, zipfile, shutil, tempfile
from pathlib import Path
from lxml import etree

NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = "{%s}" % NS

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
        for xml_path in list((td/"word").glob("*.xml")) + list((td/"word").glob("**/*.xml")):
            try:
                tree = etree.parse(str(xml_path))
            except Exception:
                continue
            changed = False
            for tag in ("commentRangeStart", "commentRangeEnd", "commentReference"):
                for el in tree.findall(".//" + W + tag):
                    parent = el.getparent()
                    if parent is not None:
                        parent.remove(el); changed = True
            if changed:
                tree.write(str(xml_path), xml_declaration=True, encoding="UTF-8", standalone="yes")
        comments = td/"word"/"comments.xml"
        if comments.exists():
            comments.unlink()
        rels = td/"word"/"_rels"/"document.xml.rels"
        if rels.exists():
            tree = etree.parse(str(rels))
            root = tree.getroot()
            for el in list(root):
                if "comments" in (el.get("Type") or ""):
                    root.remove(el)
            tree.write(str(rels), xml_declaration=True, encoding="UTF-8", standalone="yes")
        ctype = td/"[Content_Types].xml"
        tree = etree.parse(str(ctype))
        root = tree.getroot()
        for el in list(root):
            if el.get("PartName") == "/word/comments.xml":
                root.remove(el)
        tree.write(str(ctype), xml_declaration=True, encoding="UTF-8", standalone="yes")
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for p in td.rglob("*"):
                if p.is_file():
                    z.write(p, p.relative_to(td))
    print(out)

if __name__ == "__main__":
    main()
