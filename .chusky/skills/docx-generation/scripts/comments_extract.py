#!/usr/bin/env python3
import argparse, json, zipfile
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx")
    args = ap.parse_args()
    with zipfile.ZipFile(args.docx) as z:
        if "word/comments.xml" not in z.namelist():
            print("[]")
            return
        root = ET.fromstring(z.read("word/comments.xml"))
        comments = []
        for c in root.findall(W + "comment"):
            text = "".join(t.text or "" for t in c.iter(W + "t"))
            comments.append({
                "id": c.get(W + "id"),
                "author": c.get(W + "author"),
                "date": c.get(W + "date"),
                "text": text
            })
        print(json.dumps(comments, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
