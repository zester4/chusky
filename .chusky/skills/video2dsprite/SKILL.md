---
name: video2dsprite
description: >
  Turn a real 2D character video into dense animation sprites with ffmpeg and
  Pillow. Chusky's native video generator is asynchronous and prompt-only;
  request its Daytona destination when the completed clip must be used by this
  processor.
metadata:
  short-description: "Video-to-sprite postprocessing for verified local videos"
user-invocable: false
---

# Video2dsprite

Read [the media tool boundary](../../references/media-tools.md) before starting.
This skill owns deterministic postprocessing, not generative video-provider
access.

## Runtime boundary

- For a standalone generated video, call `CHUCK_GENERATE_VIDEO` with a prompt.
  Use `destination: "daytona"` or `"both"` when the completed clip is needed
  here. It queues an asynchronous job; wait for the completion notification and
  verify the returned workspace path before processing it.
- For sprite extraction, require a real video path from a user upload or a
  verified Daytona filesystem result.
- Do not pretend that a newly generated channel attachment is available inside
  Daytona during the same turn. If a future native download/import tool is
  added, update this boundary and verify its returned path before use.

## Pipeline

```text
verified video path → extract frames → chroma key → normalize → sample → strip/grid/GIF
```

Use this for a side-view run or walk loop when the user already has a video.
For a new character still, use `CHUCK_GENERATE_IMAGE` with
`destination: "daytona"` or `"both"` when a real source file is needed. Do not
start processing until the tool returns and the file is verified.

## Planning inputs

Infer these when the user does not specify them:

- `duration`: 6 seconds for a compact loop; 10 seconds only when more motion
  coverage is useful
- `frame_counts`: `8,16,24,48`, with 16 or 24 usually preferred for runtime
- `cell_size`: 128 pixels unless the project specifies another atlas size
- `anchor`: `feet` for side locomotion, otherwise `center`
- `bg`: solid `#FF00FF` only when chroma processing is intended

The source prompt should describe one subject, one in-place action, locked
camera, stable identity, and enough empty margin for cropping. These are
generation-quality constraints, not a reason to invoke an unavailable
source-aware generation operation.

## Agent rules

1. Never request or use a provider API key.
2. Never invent a file path or claim that asynchronous generation returned one.
3. Never use a text-only generated video as an input to this pipeline unless it
   has been explicitly downloaded to Daytona and verified there.
4. Do not create raw sprite art with PIL, Canvas, SVG, or placeholder geometry;
   scripts may only postprocess a real source video.
5. Do not modify game code unless the user asks for integration.

## Processing

Create:

```text
<out_dir>/
  frames-raw/
  frames-clean/
  sprite/
  prompt-used.txt
  pipeline-meta.json
  README.txt
```

Run the processor:

```bash
python3 .chusky/skills/video2dsprite/scripts/video2dsprite.py process \
  --video <verified-video-path> \
  --out-dir <out_dir> \
  --name <name> \
  --frame-counts 8,16,24,48 \
  --cell-size 128 \
  --body-height 100 \
  --foot-y 118 \
  --fps 0
```

Use `sample` to create additional densities from the already cleaned frames:

```bash
python3 .chusky/skills/video2dsprite/scripts/video2dsprite.py sample \
  --clean-dir <out_dir>/frames-clean \
  --out-dir <out_dir> \
  --frame-counts 16,24,48 \
  --cell-size 128
```

## QC and delivery

Check that the preview loops cleanly, magenta is removed, feet share a stable
baseline, identity does not drift badly, and the motion stays in frame. Report
the verified absolute paths for the source video, cleaned frames, strips,
grids, and preview GIFs. Register a final bundle with `CHUCK_ARTIFACT` only
after the files exist and validation succeeds.

If the source clip has identity drift, camera movement, a changing background,
or a broken loop, keep it as a motion reference and fall back to the primary
still-image sprite workflow for production assets. Do not silently ship a weak
generated animation.

## Defaults

- 6-second source when the user supplies a generated clip
- 8, 16, 24, and 48 output samples
- 128×128 cells
- feet anchor at approximately y=118
- magenta background only when it is present in the real source footage

## Relationship to other skills

- `$generate2dsprite` is the primary still-image sprite-sheet workflow.
- `$generate2dmap` owns maps and map-linked assets.
- `CHUCK_GENERATE_VIDEO` is the standalone native video generation path; this
  skill begins only after a verifiable local video exists.
