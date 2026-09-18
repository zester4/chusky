#!/usr/bin/env python3
import argparse, shutil, subprocess
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        raise SystemExit("LibreOffice/soffice not found")
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    cmd = [exe, "--headless", "--convert-to", "pdf", "--outdir", str(outdir), str(Path(args.input))]
    p = subprocess.run(cmd, text=True, capture_output=True)
    print(p.stdout)
    if p.returncode:
        print(p.stderr)
        raise SystemExit(p.returncode)

if __name__ == "__main__":
    main()
