---
name: openrouter-video-editing
description: Generate one or many video clips through OpenRouter's unified video API (text-to-video, image-to-video, reference-to-video) across models like Veo 3.1, Sora 2 Pro, Seedance, Wan, Hailuo, Grok Imagine, and FLUX 3 Video — including generating a *sequence* of N clips (e.g. "make 3 10-second videos") and automatically merging them into one final video with ffmpeg. Use this skill whenever the user wants to create a video from a text prompt, animate a still image, extend/continue a clip, restyle via a reference image, build a multi-scene video/ad/story from several generated clips, or asks about "AI video generation," "OpenRouter video," or wants to compare/pick a video model by cost, resolution, or duration — even if they don't name OpenRouter or a specific model explicitly. Also covers brand videos, ads, UGC-style content, and avatar/talking-head clips — see references/use-cases.md. Requires an OPENROUTER_API_KEY.
---

# OpenRouter Video Editing

Generate short video clips via OpenRouter's video generation API
(`POST /api/v1/videos`), which sits in front of many providers (Google Veo,
OpenAI Sora, ByteDance Seedance, Alibaba Wan, MiniMax Hailuo, Black Forest Labs
FLUX 3 Video, and others) behind one consistent request/response shape — and
turn multiple generated clips into one finished video with ffmpeg.

This is **generation-based editing**: there is no frame-level video editor
here. Three generation modes, and one orchestration layer on top of them:

| Mode | How to trigger it | Typical use |
|---|---|---|
| Text-to-video | `prompt` only | Create a new clip from a description |
| Image-to-video | `prompt` + `frame_images` | Animate a still into motion; set first/last frame |
| Reference-to-video | `prompt` + `input_references` | Restyle/guide generation using a reference image (character, style) |
| **Sequence** | N scenes -> `generate_sequence.py` | Multiple clips generated (in parallel), downloaded, and merged into one video |

If both `frame_images` and `input_references` are given, `frame_images` wins.

Video generation is **asynchronous**: submit -> poll -> download. Never treat
the initial POST response as the final result — it only ever returns a job id
and `status: "pending"`.

## Prerequisites

- An OpenRouter API key. Look for it in the environment as `OPENROUTER_API_KEY`.
  If it isn't set, ask the user for it — never hardcode a key or invent one.
- `requests` (Python): `pip install requests --break-system-packages`.
- `ffmpeg` / `ffprobe` on PATH — required for `generate_sequence.py` and
  `merge_clips.py`. Both are typically already available; check with
  `which ffmpeg` before assuming otherwise.

## Scripts (in `scripts/`, run from that directory so the shared import works)

| Script | Use for |
|---|---|
| `openrouter_client.py` | Shared library — not run directly. Auth, model catalog fetch/validation, submit/poll/download. |
| `list_models.py` | Discover video models and their real supported durations/resolutions/aspect ratios/pricing. |
| `generate_video.py` | **One** clip: submit, poll, download. |
| `generate_sequence.py` | **N clips -> one merged video.** The main entry point for "make me 3 videos and combine them" requests. |
| `merge_clips.py` | Merge existing clips you already have (no generation) — normalizes resolution/fps/audio then concatenates, hard-cut or crossfade. |

## Workflow: a single clip

1. Clarify scope if underspecified (what it shows, duration, aspect ratio) but
   don't block on it — assume sensible defaults (5s, 16:9, 720p) and say so.
2. `python list_models.py` to see live model capabilities before picking one.
3. `python generate_video.py --model ... --prompt ... --out /mnt/user-data/outputs/clip.mp4`
4. Present the file with `present_files` (or this environment's equivalent).

## Workflow: a sequence of clips (e.g. "3 x 10-second videos, merged")

**This is the case this skill is built to do properly — don't reimplement it
as a loop calling `generate_video.py` three times by hand.**
`generate_sequence.py` submits every clip's job up front, polls all of them
concurrently, downloads each one, and merges them in order — so 3 independent
10s clips take roughly as long as the slowest single one, not 3x as long.

1. **Turn the ask into a storyboard.** For each of the N clips, write a
   distinct, concrete prompt (what's on screen, camera move, mood) — three
   clips with the same vague prompt just produce three near-duplicate clips.
   If continuity matters (same character/product across clips), reuse the same
   `first_frame` or `references` image across scenes and keep the visual
   description worded consistently.
2. **Check the target duration against a real model first.** Not every model
   supports every duration — e.g. Veo 3.1 only does 4/6/8s clips; Wan-family
   and some others support 10s. Run
   `python list_models.py` (or `--id <model>`) and pick a model whose
   `supported_durations` actually includes what the user asked for, rather
   than assuming a request for "10 seconds" will just work on any model.
   `generate_sequence.py` also auto-clamps to the nearest supported value
   and prints a warning if you don't catch it first — but picking correctly
   up front avoids surprising the user with fewer seconds than they asked for.
3. **Run it**, either the simple form (same model/duration/aspect for every
   scene, just different prompts):
   ```bash
   python generate_sequence.py \
     --prompts \
       "A barista steams milk in close-up, warm cafe lighting, steam curling upward" \
       "Wide shot of the finished latte being placed on a wooden table by a window" \
       "Slow pan across a cozy cafe interior as morning light streams in" \
     --model alibaba/wan-3.0 --duration 10 --aspect-ratio 16:9 --resolution 1080p \
     --out-dir /mnt/user-data/outputs/cafe_ad --merged-name final.mp4
   ```
   or the advanced form (`--scenes-file storyboard.json`) when scenes need
   different models, durations, or a `first_frame`/`references` per scene —
   see the docstring in `generate_sequence.py` for the JSON shape.
4. **Deliver every file, not just the merged one.** The script downloads
   `clip_01.mp4`, `clip_02.mp4`, ... `clip_0N.mp4` plus `merged.mp4` (or
   whatever `--merged-name` was) into `--out-dir`. Present **all of them** with
   `present_files` — the user asked for the individual clips *plus* the merged
   video, and losing the individual clips because "the merged one has
   everything" is not what was asked for.
5. **Report partial failures honestly.** If one scene's generation fails, the
   script still merges the ones that succeeded (in original order) and says so
   — surface that to the user rather than presenting a merged video as if
   nothing went wrong, and offer to retry just the failed scene.
6. **Report total cost** — the script sums `usage.cost` across all clips.

### Transitions

`--transition none` (default) is a hard cut between clips. `--transition
crossfade --transition-duration 0.5` blends adjacent clips with a fade — use
this when the user wants something less choppy than back-to-back cuts; hard
cuts are usually right for distinct scenes/beats (e.g. separate ad shots).

### Merging clips you already have (no generation)

If the user already has video files and just wants them combined:
```bash
python merge_clips.py clip1.mp4 clip2.mp4 clip3.mp4 --out /mnt/user-data/outputs/final.mp4
```
This still normalizes resolution/fps/audio first — don't skip straight to a
raw `ffmpeg concat` yourself; clips from different sources/models rarely match
exactly, and a raw concat on mismatched streams silently produces broken or
desynced output rather than erroring.

## Key gotchas (read before writing custom code)

- **Async — always poll, never trust the submit response as final.**
- **Validate `duration`/`resolution`/`aspect_ratio` against the specific
  model** before submitting — `openrouter_client.validate_and_clamp()` does
  this and is used by every script here; don't assume one model's supported
  values apply to another (Veo 3.1: 4/6/8s; Wan-family: often includes 10s).
- **Never concatenate raw generated clips without normalizing first** —
  different jobs can return different resolutions, frame rates, or audio
  presence even from the same model/prompt family; `merge_clips.py` handles
  this, a bare `ffmpeg -f concat` does not.
- **`generate_audio` defaults to `true`** on models that support it — pass
  `--no-audio` if the user wants silent clips.
- **Not ZDR-eligible.** If the workspace enforces Zero Data Retention,
  OpenRouter refuses video requests outright — mention this if a submit fails
  for that reason instead of retrying blindly.
- **Cost is per video-second** — check `pricing_skus` before generating many
  clips at high resolution/duration, and report actual `usage.cost` back.
- Full field reference, provider passthrough params, and webhooks are in
  `references/api-reference.md`. Use-case prompting patterns (brand videos,
  UGC ads, avatars) and their honest limits are in `references/use-cases.md`.

## Test prompts

- "Make me 3 ten-second video clips of a sunrise over mountains, a river flowing through a forest, and a sunset over the ocean, then merge them into one video."
- "Generate a 3-scene product ad for a coffee brand — 10 seconds each — and combine them with a crossfade."
- "Animate this photo of my dog into a short video where he starts running." (with an attached image)
- "What OpenRouter video models support 1080p and 10-second clips?"
- "I have three video files, can you merge them into one?"
- "I need a UGC-style ad for my skincare brand — someone talking to camera about how much they love it."
- "Make a talking-avatar clip of a person saying 'Welcome to our store, everything's 20% off today.'"
