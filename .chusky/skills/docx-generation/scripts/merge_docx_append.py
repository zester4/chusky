#!/usr/bin/env python3
import argparse, copy
from docx import Document

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    target = Document(args.inputs[0])
    for src_path in args.inputs[1:]:
        target.add_page_break()
        src = Document(src_path)
        body = src.element.body
        for child in list(body):
            if child.tag.endswith("sectPr"):
                continue
            target.element.body.insert(-1, copy.deepcopy(child))
    target.save(args.out)
    print(args.out)

if __name__ == "__main__":
    main()
