#!/usr/bin/env python3
import argparse, shutil, subprocess
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("output")
    args = ap.parse_args()
    html = Path(args.html).resolve()
    out = Path(args.output).resolve()
    if shutil.which("weasyprint"):
        p = subprocess.run(["weasyprint", str(html), str(out)], text=True, capture_output=True)
    else:
        chrome = next((shutil.which(x) for x in ["chromium", "chromium-browser", "google-chrome"] if shutil.which(x)), None)
        if not chrome:
            raise SystemExit("Need WeasyPrint or Chromium")
        p = subprocess.run([chrome, "--headless", "--disable-gpu", f"--print-to-pdf={out}", html.as_uri()], text=True, capture_output=True)
    if p.returncode:
        print(p.stderr)
        raise SystemExit(p.returncode)
    print(out)

if __name__ == "__main__":
    main()
