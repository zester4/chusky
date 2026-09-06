#!/usr/bin/env python3
"""
List video generation models available on OpenRouter.

Fetches the live catalog from GET /api/v1/videos/models so capabilities
(supported durations/resolutions/aspect ratios) and pricing are always
current -- don't hardcode a model list, providers change often.

Usage:
    python list_models.py                        # table of all video models
    python list_models.py --id google/veo-3.1     # full details for one model
    python list_models.py --json                  # raw JSON dump
"""

import argparse
import json
import sys

import openrouter_client as orc


def print_table(models):
    if not models:
        print("No video models returned.")
        return
    rows = []
    for m in models:
        durations = ",".join(str(d) for d in m.get("supported_durations", [])) or "-"
        resolutions = ",".join(m.get("supported_resolutions", [])) or "-"
        ratios = ",".join(m.get("supported_aspect_ratios", [])) or "-"
        price = m.get("pricing_skus", {}) or {}
        price_str = price.get("per-video-second", next(iter(price.values()), "-"))
        rows.append((m.get("id", "-"), durations, resolutions, ratios, str(price_str)))

    headers = ("model id", "durations(s)", "resolutions", "aspect ratios", "$/video-sec")
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    print(fmt.format(*headers))
    print(fmt.format(*("-" * w for w in widths)))
    for r in rows:
        print(fmt.format(*r))


def print_detail(models, model_id):
    match = orc.get_model_info(model_id, models)
    if not match:
        print(f"Model '{model_id}' not found in the video models catalog.", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(match, indent=2))


def main():
    parser = argparse.ArgumentParser(description="List OpenRouter video generation models.")
    parser.add_argument("--id", help="Show full details for a single model id (e.g. google/veo-3.1)")
    parser.add_argument("--json", action="store_true", help="Dump raw JSON for all models")
    args = parser.parse_args()

    models = orc.fetch_models()

    if args.json:
        print(json.dumps(models, indent=2))
    elif args.id:
        print_detail(models, args.id)
    else:
        print_table(models)


if __name__ == "__main__":
    main()
