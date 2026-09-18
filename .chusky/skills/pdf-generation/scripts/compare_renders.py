#!/usr/bin/env python3
import argparse
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("left")
    ap.add_argument("right")
    ap.add_argument("--threshold", type=float, default=0.002)
    args = ap.parse_args()
    try:
        from PIL import Image, ImageChops, ImageStat
    except ImportError:
        raise SystemExit("Pillow is required: pip install pillow")
    left = sorted(Path(args.left).glob("*.png"))
    right = sorted(Path(args.right).glob("*.png"))
    if len(left) != len(right):
        raise SystemExit(f"page count mismatch: {len(left)} vs {len(right)}")
    failed = 0
    for a, b in zip(left, right):
        ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
        if ia.size != ib.size:
            print(a.name, "SIZE_MISMATCH", ia.size, ib.size)
            failed += 1
            continue
        diff = ImageChops.difference(ia, ib)
        stat = ImageStat.Stat(diff)
        ratio = sum(stat.mean) / (3 * 255)
        print(a.name, f"{ratio:.6f}")
        if ratio > args.threshold:
            failed += 1
    raise SystemExit(1 if failed else 0)

if __name__ == "__main__":
    main()
