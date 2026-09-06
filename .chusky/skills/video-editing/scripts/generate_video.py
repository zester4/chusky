#!/usr/bin/env python3
"""
Submit a single video generation job to OpenRouter, poll it to completion,
and download the result.

For 2+ clips that should end up as one video, use generate_sequence.py
instead -- it validates against live model constraints, submits/polls
concurrently, and merges the output. This script is the single-clip building
block it's built on.

Usage:
    export OPENROUTER_API_KEY=sk-or-...

    python generate_video.py \\
        --model google/veo-3.1 \\
        --prompt "A golden retriever playing fetch on a sunny beach" \\
        --duration 6 --aspect-ratio 16:9 --resolution 720p \\
        --out /mnt/user-data/outputs/retriever.mp4
"""

import argparse
import sys

import openrouter_client as orc


def main():
    parser = argparse.ArgumentParser(description="Generate a video via OpenRouter and download it.")
    parser.add_argument("--model", required=True, help="Model slug, e.g. google/veo-3.1")
    parser.add_argument("--prompt", required=True, help="Text description of the desired video")
    parser.add_argument("--duration", type=int, help="Duration in seconds")
    parser.add_argument("--resolution", help="e.g. 720p, 1080p, 2K")
    parser.add_argument("--aspect-ratio", dest="aspect_ratio", help="e.g. 16:9, 9:16, 1:1")
    parser.add_argument("--size", help="Exact WIDTHxHEIGHT, e.g. 1280x720 (alt. to resolution+aspect_ratio)")
    parser.add_argument("--seed", type=int, help="Seed for more deterministic generation")
    parser.add_argument("--no-audio", action="store_true", help="Disable generated audio")
    parser.add_argument("--first-frame", help="URL or local path for image-to-video first frame")
    parser.add_argument("--last-frame", help="URL or local path for image-to-video last frame")
    parser.add_argument(
        "--reference", action="append",
        help="URL or local path for a reference-to-video style/content image (repeatable)",
    )
    parser.add_argument("--callback-url", dest="callback_url", help="Webhook URL instead of polling")
    parser.add_argument("--api-key", help="OpenRouter API key (defaults to OPENROUTER_API_KEY env var)")
    parser.add_argument("--poll-interval", type=int, default=orc.DEFAULT_POLL_INTERVAL)
    parser.add_argument("--timeout", type=int, default=orc.DEFAULT_TIMEOUT)
    parser.add_argument("--skip-validation", action="store_true",
                         help="Skip checking duration/resolution/aspect_ratio against the live model catalog")
    parser.add_argument("--out", required=True, help="Output .mp4 path")

    args = parser.parse_args()
    api_key = orc.get_api_key(args.api_key)
    headers = orc.auth_headers(api_key)

    duration, resolution, aspect_ratio = args.duration, args.resolution, args.aspect_ratio
    if not args.skip_validation and (duration or resolution or aspect_ratio):
        info = orc.get_model_info(args.model)
        adjusted, warnings = orc.validate_and_clamp(info, duration, resolution, aspect_ratio)
        for w in warnings:
            print(w)
        duration, resolution, aspect_ratio = adjusted["duration"], adjusted["resolution"], adjusted["aspect_ratio"]

    payload = orc.build_payload(
        model=args.model, prompt=args.prompt, duration=duration, resolution=resolution,
        aspect_ratio=aspect_ratio, size=args.size, seed=args.seed,
        generate_audio=(False if args.no_audio else None), callback_url=args.callback_url,
        first_frame=args.first_frame, last_frame=args.last_frame, references=args.reference,
    )

    print(f"Submitting job -> model={args.model}")
    submitted = orc.submit_job(headers, payload)
    if submitted.get("status") == "failed" or "error" in submitted:
        print(f"Submit failed: {submitted.get('error')}", file=sys.stderr)
        sys.exit(1)
    print(f"Job id: {submitted['id']}  status: {submitted['status']}")

    if args.callback_url:
        print("callback_url set -- not polling. The webhook will notify on completion.")
        return

    def on_status(status):
        print(f"status: {status['status']}")

    result = orc.poll_job(headers, submitted["polling_url"], args.poll_interval, args.timeout, on_status)
    if result["status"] != "completed":
        print(f"Job {result['status']}: {result.get('error', 'no error detail')}", file=sys.stderr)
        sys.exit(1)

    orc.download_video(headers, result["unsigned_urls"][0], args.out)
    cost = (result.get("usage") or {}).get("cost")
    print(f"Saved video to {args.out}" + (f"  (cost: ${cost})" if cost is not None else ""))


if __name__ == "__main__":
    main()
