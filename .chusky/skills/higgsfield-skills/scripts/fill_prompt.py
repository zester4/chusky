#!/usr/bin/env python3
"""Fill [SLOT] placeholders in a prompt template and report anything left unfilled.

Usage:
  python fill_prompt.py --template t.txt KEY="value" OTHER="value"
  python fill_prompt.py --list t.txt
Slots are matched case-insensitively by name, e.g. BRAND_NAME fills [BRAND_NAME].
Lowercase/default slots like [8] are reported as tunable, not required.
"""
import argparse, re, sys

SLOT = re.compile(r"\[([^\[\]\n]{1,80})\]")

def is_required(name):
    letters = [c for c in name if c.isalpha()]
    return bool(letters) and sum(c.isupper() for c in letters) / len(letters) > 0.6 and not name.startswith("VFX:")

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--template"); p.add_argument("--list")
    p.add_argument("pairs", nargs="*")
    a = p.parse_args()
    path = a.template or a.list
    if not path:
        p.error("give --template or --list")
    text = open(path, encoding="utf-8").read()
    if a.list:
        seen = []
        for s in SLOT.findall(text):
            if is_required(s) and s not in seen:
                seen.append(s)
        print("\n".join(seen)); return
    values = {}
    for pair in a.pairs:
        k, _, v = pair.partition("=")
        values[k.strip().upper()] = v
    def sub(m):
        name = m.group(1); key = name.split(",")[0].split(":")[0].strip().upper()
        return values.get(key, m.group(0))
    out = SLOT.sub(sub, text)
    print(out)
    left = [s for s in SLOT.findall(out) if is_required(s)]
    if left:
        print("\n# UNFILLED:", "; ".join(dict.fromkeys(left)), file=sys.stderr)

if __name__ == "__main__":
    main()
