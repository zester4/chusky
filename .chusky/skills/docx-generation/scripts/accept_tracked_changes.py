#!/usr/bin/env python3
import argparse, zipfile, tempfile
from pathlib import Path
from lxml import etree

WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = "{%s}" % WNS

def transform(tree, mode):
    root = tree.getroot()
    for el in list(root.iter()):
        for child in list(el):
            if child.tag == W+"ins":
                if mode == "accept":
                    idx = el.index(child)
                    for sub in list(child):
                        el.insert(idx, sub); idx += 1
                el.remove(child)
            elif child.tag == W+"del":
                if mode == "reject":
                    idx = el.index(child)
                    for sub in list(child):
                        for t in sub.iter(W+"delText"):
                            t.tag = W+"t"
                        el.insert(idx, sub); idx += 1
                el.remove(child)
    return tree

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--mode", choices=["accept","reject"], default="accept")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    src, out = Path(args.input), Path(args.out)
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        with zipfile.ZipFile(src) as z:
            z.extractall(td)
        for p in (td/"word").glob("**/*.xml"):
            try:
                tree = etree.parse(str(p))
            except Exception:
                continue
            if tree.getroot().xpath(".//w:ins | .//w:del", namespaces={"w":WNS}):
                transform(tree, args.mode).write(str(p), xml_declaration=True, encoding="UTF-8", standalone="yes")
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for p in td.rglob("*"):
                if p.is_file():
                    z.write(p, p.relative_to(td))
    print(out)

if __name__ == "__main__":
    main()
