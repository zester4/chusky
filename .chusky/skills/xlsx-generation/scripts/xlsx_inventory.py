#!/usr/bin/env python3
import argparse, json, zipfile
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    args = ap.parse_args()
    p = Path(args.xlsx)
    with zipfile.ZipFile(p) as z:
        names = z.namelist()
    groups = {
        "worksheets": [x for x in names if x.startswith("xl/worksheets/") and x.endswith(".xml")],
        "tables": [x for x in names if x.startswith("xl/tables/")],
        "charts": [x for x in names if x.startswith("xl/charts/")],
        "drawings": [x for x in names if x.startswith("xl/drawings/")],
        "comments": [x for x in names if "comments" in x],
        "pivot": [x for x in names if "pivot" in x.lower()],
        "external_links": [x for x in names if x.startswith("xl/externalLinks/")],
        "connections": [x for x in names if "connections" in x.lower()],
    }
    print(json.dumps(groups, indent=2))

if __name__ == "__main__":
    main()
