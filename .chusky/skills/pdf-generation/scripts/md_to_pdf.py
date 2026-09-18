#!/usr/bin/env python3
import argparse, shutil, subprocess, tempfile
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("markdown")
    ap.add_argument("output")
    args = ap.parse_args()
    src, out = Path(args.markdown), Path(args.output)
    if shutil.which("pandoc"):
        p = subprocess.run(["pandoc", str(src), "-o", str(out)], text=True, capture_output=True)
        if p.returncode:
            print(p.stderr)
            raise SystemExit(p.returncode)
        print(out)
        return
    try:
        import markdown
        from weasyprint import HTML
    except ImportError:
        raise SystemExit("Need pandoc, or: pip install markdown weasyprint")
    body = markdown.markdown(src.read_text(encoding="utf-8"), extensions=["tables", "fenced_code"])
    HTML(string=f"<html><body>{body}</body></html>", base_url=str(src.parent.resolve())).write_pdf(str(out))
    print(out)

if __name__ == "__main__":
    main()
