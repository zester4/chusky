#!/usr/bin/env python3
import argparse, subprocess, tempfile
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

def render(script, docx, out):
    p = subprocess.run(["python", script, docx, "--output_dir", out], text=True, capture_output=True)
    if p.returncode:
        print(p.stdout); print(p.stderr); raise SystemExit(p.returncode)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("left")
    ap.add_argument("right")
    ap.add_argument("--renderer", default=str(Path(__file__).with_name("render_docx.py")))
    ap.add_argument("--threshold", type=float, default=0.002)
    args = ap.parse_args()
    with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
        render(args.renderer, args.left, a)
        render(args.renderer, args.right, b)
        la, lb = sorted(Path(a).glob("page-*.png")), sorted(Path(b).glob("page-*.png"))
        if len(la) != len(lb):
            print(f"page count mismatch: {len(la)} vs {len(lb)}")
            raise SystemExit(1)
        failed = 0
        for x,y in zip(la,lb):
            ix, iy = Image.open(x).convert("RGB"), Image.open(y).convert("RGB")
            if ix.size != iy.size:
                print(x.name, "SIZE_MISMATCH")
                failed += 1
                continue
            stat = ImageStat.Stat(ImageChops.difference(ix,iy))
            ratio = sum(stat.mean)/(3*255)
            print(x.name, f"{ratio:.6f}")
            if ratio > args.threshold:
                failed += 1
        raise SystemExit(1 if failed else 0)

if __name__ == "__main__":
    main()
