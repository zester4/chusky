#!/usr/bin/env python3
"""
Merge multiple video clips into one file with ffmpeg.

Clips from different generation jobs can differ in resolution, fps, and
whether they have an audio track at all -- concatenating them directly with
the ffmpeg concat demuxer will produce broken or desynced output if they
don't match exactly. This script normalizes every clip first (same
resolution via letterbox/pad, same fps, same pixel format, guaranteed audio
track) and only then joins them, either as hard cuts or with a crossfade.

Usable standalone:
    python merge_clips.py clip1.mp4 clip2.mp4 clip3.mp4 --out final.mp4
    python merge_clips.py --dir clips/ --out final.mp4 --transition crossfade

Or import merge_videos() directly (this is what generate_sequence.py does).
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

DEFAULT_FPS = 30
DEFAULT_TRANSITION_DURATION = 0.5


def _run(cmd):
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{result.stderr}")
    return result.stdout


def probe(path):
    """Return {width, height, duration, has_audio} for a clip via ffprobe."""
    out = _run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ])
    data = json.loads(out)
    streams = data.get("streams", [])
    video = next((s for s in streams if s["codec_type"] == "video"), None)
    has_audio = any(s["codec_type"] == "audio" for s in streams)
    duration = float(data.get("format", {}).get("duration", 0) or 0)
    if video is None:
        raise RuntimeError(f"No video stream found in {path}")
    return {
        "width": int(video["width"]),
        "height": int(video["height"]),
        "duration": duration,
        "has_audio": has_audio,
    }


def pick_target_resolution(clip_infos):
    """Use the largest width seen across clips (by area) as the common target."""
    best = max(clip_infos, key=lambda c: c["width"] * c["height"])
    return best["width"], best["height"]


def normalize_clip(src, dst, width, height, fps):
    """Scale+pad to a common resolution/fps, force yuv420p, and guarantee an
    audio track (silent stereo track added if the source has none) so every
    normalized clip has identical stream layout for concatenation."""
    info = probe(src)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps},format=yuv420p"
    )
    cmd = ["ffmpeg", "-y", "-i", src]
    if not info["has_audio"]:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    cmd += ["-vf", vf]
    if not info["has_audio"]:
        cmd += ["-shortest", "-map", "0:v:0", "-map", "1:a:0"]
    else:
        cmd += ["-map", "0:v:0", "-map", "0:a:0"]
    cmd += ["-c:v", "libx264", "-c:a", "aac", "-ar", "44100", dst]
    _run(cmd)
    return probe(dst)


def concat_hard_cut(normalized_paths, out_path, workdir):
    list_path = os.path.join(workdir, "concat_list.txt")
    with open(list_path, "w") as f:
        for p in normalized_paths:
            f.write(f"file '{os.path.abspath(p)}'\n")
    _run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path,
        "-c", "copy", out_path,
    ])


def concat_crossfade(normalized_paths, out_path, transition_duration):
    """Chain pairwise xfade (video) + acrossfade (audio) across all clips."""
    n = len(normalized_paths)
    if n == 1:
        shutil.copy(normalized_paths[0], out_path)
        return

    durations = [probe(p)["duration"] for p in normalized_paths]

    inputs = []
    for p in normalized_paths:
        inputs += ["-i", p]

    filter_parts = []
    v_prev = "0:v"
    a_prev = "0:a"
    cumulative = durations[0]

    for i in range(1, n):
        offset = max(cumulative - transition_duration, 0)
        v_out = f"v{i}"
        a_out = f"a{i}"
        filter_parts.append(
            f"[{v_prev}][{i}:v]xfade=transition=fade:duration={transition_duration}:"
            f"offset={offset}[{v_out}]"
        )
        filter_parts.append(
            f"[{a_prev}][{i}:a]acrossfade=d={transition_duration}[{a_out}]"
        )
        v_prev, a_prev = v_out, a_out
        cumulative = cumulative - transition_duration + durations[i]

    filter_complex = ";".join(filter_parts)
    cmd = (
        ["ffmpeg", "-y"] + inputs +
        ["-filter_complex", filter_complex, "-map", f"[{v_prev}]", "-map", f"[{a_prev}]",
         "-c:v", "libx264", "-c:a", "aac", out_path]
    )
    _run(cmd)


def merge_videos(paths, out_path, transition="none", transition_duration=DEFAULT_TRANSITION_DURATION,
                  fps=DEFAULT_FPS, target_resolution=None):
    """
    Normalize and merge a list of video file paths, in order, into out_path.
    transition: "none" (hard cuts) or "crossfade".
    Returns a dict with the resolved output path and per-clip source durations.
    """
    if not paths:
        raise ValueError("No clips provided to merge.")
    for p in paths:
        if not os.path.isfile(p):
            raise FileNotFoundError(f"Clip not found: {p}")

    clip_infos = [probe(p) for p in paths]
    width, height = target_resolution or pick_target_resolution(clip_infos)

    with tempfile.TemporaryDirectory() as workdir:
        normalized = []
        for i, p in enumerate(paths):
            dst = os.path.join(workdir, f"norm_{i:02d}.mp4")
            normalize_clip(p, dst, width, height, fps)
            normalized.append(dst)

        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        if transition == "crossfade":
            concat_crossfade(normalized, out_path, transition_duration)
        else:
            concat_hard_cut(normalized, out_path, workdir)

    return {
        "out_path": out_path,
        "resolution": f"{width}x{height}",
        "clip_count": len(paths),
        "clip_durations": [c["duration"] for c in clip_infos],
    }


def main():
    parser = argparse.ArgumentParser(description="Merge video clips into one file.")
    parser.add_argument("clips", nargs="*", help="Clip paths, in order")
    parser.add_argument("--dir", help="Instead of listing clips, glob *.mp4 in this dir (sorted)")
    parser.add_argument("--out", required=True, help="Output merged video path")
    parser.add_argument("--transition", choices=["none", "crossfade"], default="none")
    parser.add_argument("--transition-duration", type=float, default=DEFAULT_TRANSITION_DURATION)
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS)
    args = parser.parse_args()

    if args.dir:
        paths = sorted(glob.glob(os.path.join(args.dir, "*.mp4")))
    else:
        paths = args.clips
    if not paths:
        print("No clips found to merge (pass paths or --dir).", file=sys.stderr)
        sys.exit(1)

    print(f"Merging {len(paths)} clip(s) -> {args.out} (transition={args.transition})")
    result = merge_videos(
        paths, args.out, transition=args.transition,
        transition_duration=args.transition_duration, fps=args.fps,
    )
    print(f"Done: {result['out_path']}  ({result['resolution']}, {result['clip_count']} clips)")


if __name__ == "__main__":
    main()
