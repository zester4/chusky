#!/usr/bin/env python3
import argparse, shutil, subprocess
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tex")
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()
    tex = Path(args.tex).resolve()
    outdir = Path(args.outdir).resolve() if args.outdir else tex.parent
    outdir.mkdir(parents=True, exist_ok=True)
    if shutil.which("tectonic"):
        cmd = ["tectonic", str(tex), "--outdir", str(outdir)]
    elif shutil.which("pdflatex"):
        cmd = ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", f"-output-directory={outdir}", str(tex)]
    else:
        raise SystemExit("Need tectonic or pdflatex")
    p = subprocess.run(cmd, cwd=str(tex.parent), text=True, capture_output=True)
    print(p.stdout)
    if p.returncode:
        print(p.stderr)
        raise SystemExit(p.returncode)

if __name__ == "__main__":
    main()
