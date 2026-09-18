#!/usr/bin/env python3
import argparse, os, shutil, subprocess, tempfile
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--outdir", required=True)
    args = ap.parse_args()

    src = Path(args.input).resolve()
    outdir = Path(args.outdir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise SystemExit("LibreOffice/soffice not found")

    profile = tempfile.mkdtemp(prefix="chusky-lo-")
    env = os.environ.copy()
    env["HOME"] = profile
    cmd = [
        soffice, "--headless", "--nologo", "--nodefault", "--nofirststartwizard",
        f"-env:UserInstallation=file://{profile}",
        "--convert-to", "xlsx", "--outdir", str(outdir), str(src)
    ]
    p = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=240)
    candidate = outdir / src.name
    if not candidate.exists():
        print(p.stdout); print(p.stderr)
        raise SystemExit("LibreOffice did not produce a recalculated XLSX")
    print(candidate)

if __name__ == "__main__":
    main()
