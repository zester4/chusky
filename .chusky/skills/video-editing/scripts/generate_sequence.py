#!/usr/bin/env python3
"""
Generate a sequence of video clips and merge them into one final video.

This is the entry point for "make me N clips and merge them" requests --
it does not just call generate_video.py N times in a loop. It:

  1. Loads a storyboard (list of per-clip prompts/params) from a JSON file,
     or builds one from --prompts + shared flags.
  2. Validates each clip's requested duration/resolution/aspect_ratio against
     that model's *actual* supported values from the live catalog, and clamps
     to the nearest supported value instead of firing off a request that will
     just 400.
  3. Submits every clip's job up front, then polls all of them concurrently
     (round-robin) instead of waiting on each one sequentially -- for 3
     independent 10s clips this is the difference between ~1x and ~3x wait time.
  4. Downloads every completed clip.
  5. Merges the clips, in order, into one output video (normalizing
     resolution/fps/audio first -- see merge_clips.py) unless --no-merge is set.
  6. Prints a summary: every clip's status, cost, and the final file paths --
     the caller (the SKILL.md workflow) is expected to present ALL of these
     files to the user, not just the merged one.

Storyboard JSON format (--scenes-file):
    [
      {"prompt": "...", "model": "google/veo-3.1", "duration": 10,
       "aspect_ratio": "16:9", "resolution": "1080p"},
      {"prompt": "...", "first_frame": "path/or/url.png"},
      ...
    ]
Any field omitted on a scene falls back to the shared --model/--duration/
--aspect-ratio/--resolution/--generate-audio CLI flags.

Simple form (no JSON file needed):
    python generate_sequence.py \\
        --prompts "scene one" "scene two" "scene three" \\
        --model google/veo-3.1 --duration 10 --aspect-ratio 16:9 \\
        --out-dir /mnt/user-data/outputs/my_video --merged-name final.mp4
"""

import argparse
import json
import os
import sys

import openrouter_client as orc
from merge_clips import merge_videos


def load_scenes(args):
    if args.scenes_file:
        with open(args.scenes_file) as f:
            scenes = json.load(f)
        if not isinstance(scenes, list) or not scenes:
            print("--scenes-file must contain a non-empty JSON array.", file=sys.stderr)
            sys.exit(1)
        return scenes

    if not args.prompts:
        print("Provide either --scenes-file or --prompts.", file=sys.stderr)
        sys.exit(1)
    return [{"prompt": p} for p in args.prompts]


def resolve_scene(scene, args):
    """Fill in shared defaults for anything the scene didn't specify itself."""
    return {
        "prompt": scene["prompt"],
        "model": scene.get("model", args.model),
        "duration": scene.get("duration", args.duration),
        "resolution": scene.get("resolution", args.resolution),
        "aspect_ratio": scene.get("aspect_ratio", args.aspect_ratio),
        "size": scene.get("size", args.size),
        "seed": scene.get("seed"),
        "generate_audio": scene.get("generate_audio", args.generate_audio),
        "first_frame": scene.get("first_frame"),
        "last_frame": scene.get("last_frame"),
        "references": scene.get("references"),
    }


def main():
    parser = argparse.ArgumentParser(description="Generate and merge a sequence of video clips.")
    parser.add_argument("--scenes-file", help="JSON file with a list of per-clip scene dicts")
    parser.add_argument("--prompts", nargs="+", help="Simple form: one prompt per clip, shared settings")

    parser.add_argument("--model", default="google/veo-3.1", help="Default model for scenes that don't override it")
    parser.add_argument("--duration", type=int, default=10, help="Default duration in seconds per clip")
    parser.add_argument("--resolution", help="Default resolution, e.g. 1080p")
    parser.add_argument("--aspect-ratio", dest="aspect_ratio", default="16:9", help="Default aspect ratio")
    parser.add_argument("--size", help="Default exact WIDTHxHEIGHT (alt. to resolution+aspect_ratio)")
    parser.add_argument("--generate-audio", dest="generate_audio", action="store_true", default=None)
    parser.add_argument("--no-audio", dest="generate_audio", action="store_false")

    parser.add_argument("--out-dir", required=True, help="Directory to write clip_NN.mp4 files and the merged video")
    parser.add_argument("--merged-name", default="merged.mp4", help="Filename for the merged output, inside --out-dir")
    parser.add_argument("--no-merge", action="store_true", help="Only generate + download clips, skip merging")
    parser.add_argument("--transition", choices=["none", "crossfade"], default="none")
    parser.add_argument("--transition-duration", type=float, default=0.5)

    parser.add_argument("--api-key", help="OpenRouter API key (defaults to OPENROUTER_API_KEY env var)")
    parser.add_argument("--poll-interval", type=int, default=orc.DEFAULT_POLL_INTERVAL)
    parser.add_argument("--timeout", type=int, default=orc.DEFAULT_TIMEOUT)

    args = parser.parse_args()
    api_key = orc.get_api_key(args.api_key)
    headers = orc.auth_headers(api_key)

    raw_scenes = load_scenes(args)
    resolved = [resolve_scene(s, args) for s in raw_scenes]

    print(f"Fetching live model catalog to validate {len(resolved)} scene(s)...")
    models = orc.fetch_models()

    # --- Build + validate payloads, clamping to each model's real constraints ---
    payloads = []
    for i, scene in enumerate(resolved):
        info = orc.get_model_info(scene["model"], models)
        adjusted, warnings = orc.validate_and_clamp(
            info, duration=scene["duration"], resolution=scene["resolution"],
            aspect_ratio=scene["aspect_ratio"],
        )
        for w in warnings:
            print(f"[scene {i + 1}] {w}")

        payload = orc.build_payload(
            model=scene["model"], prompt=scene["prompt"],
            duration=adjusted["duration"], resolution=adjusted["resolution"],
            aspect_ratio=adjusted["aspect_ratio"], size=scene["size"],
            seed=scene["seed"], generate_audio=scene["generate_audio"],
            first_frame=scene["first_frame"], last_frame=scene["last_frame"],
            references=scene["references"],
        )
        payloads.append(payload)

    # --- Submit every job up front ---
    submitted = {}
    failed_at_submit = {}
    for i, payload in enumerate(payloads):
        print(f"Submitting scene {i + 1}/{len(payloads)} -> model={payload['model']}")
        result = orc.submit_job(headers, payload)
        if result.get("status") == "failed" or "error" in result:
            failed_at_submit[i] = result
            print(f"  submit failed: {result.get('error')}")
        else:
            submitted[i] = result["polling_url"]
            print(f"  job id: {result['id']}")

    # --- Poll all in-flight jobs concurrently ---
    def on_update(key, status):
        print(f"[scene {key + 1}] status: {status['status']}")

    poll_results = {}
    if submitted:
        poll_results = orc.poll_jobs_round_robin(
            headers, submitted, poll_interval=args.poll_interval, timeout=args.timeout,
            on_update=on_update,
        )

    # --- Download completed clips ---
    os.makedirs(args.out_dir, exist_ok=True)
    clip_paths = {}
    total_cost = 0.0
    for i in range(len(payloads)):
        if i in failed_at_submit:
            continue
        result = poll_results.get(i, {})
        if result.get("status") != "completed":
            print(f"[scene {i + 1}] did not complete: {result.get('error', result.get('status'))}")
            continue
        content_url = result["unsigned_urls"][0]
        out_path = os.path.join(args.out_dir, f"clip_{i + 1:02d}.mp4")
        orc.download_video(headers, content_url, out_path)
        clip_paths[i] = out_path
        cost = (result.get("usage") or {}).get("cost")
        if cost:
            total_cost += cost
        print(f"[scene {i + 1}] saved -> {out_path}" + (f" (${cost})" if cost else ""))

    # --- Summary ---
    n_ok = len(clip_paths)
    n_total = len(payloads)
    print(f"\n{n_ok}/{n_total} clips generated successfully. Total cost: ${total_cost:.4f}")

    if n_ok == 0:
        print("No clips succeeded -- nothing to merge.", file=sys.stderr)
        sys.exit(1)

    if args.no_merge:
        return

    ordered_clips = [clip_paths[i] for i in sorted(clip_paths.keys())]
    if n_ok < n_total:
        print(f"Merging only the {n_ok} successful clip(s), in original order -- "
              f"the failed scene(s) are skipped, not silently replaced.")

    merged_path = os.path.join(args.out_dir, args.merged_name)
    print(f"Merging {n_ok} clip(s) -> {merged_path} (transition={args.transition})")
    merge_result = merge_videos(
        ordered_clips, merged_path, transition=args.transition,
        transition_duration=args.transition_duration,
    )
    print(f"Merged video: {merge_result['out_path']} ({merge_result['resolution']})")


if __name__ == "__main__":
    main()
