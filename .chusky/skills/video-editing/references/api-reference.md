# OpenRouter Video Generation API Reference

Full detail behind the scripts in `../scripts/`. Read this when a task needs
something the scripts don't already handle: webhooks, provider-specific
passthrough parameters, or reasoning about which model to pick.

## Endpoints

| Step | Method & path |
|---|---|
| Submit | `POST /api/v1/videos` |
| Poll | `GET /api/v1/videos/{jobId}` |
| Download | `GET /api/v1/videos/{jobId}/content?index=0` |
| Discover models | `GET /api/v1/videos/models` |
| Discover via general models API | `GET /api/v1/models?output_modalities=video` |

Auth: `Authorization: Bearer $OPENROUTER_API_KEY` on every request.

## Request body (`POST /api/v1/videos`)

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `model` | string | yes | e.g. `google/veo-3.1` |
| `prompt` | string | yes for text-to-video | describes motion, camera, lighting, scene |
| `duration` | integer | no | seconds; must be in the model's `supported_durations` |
| `resolution` | string | no | one of `480p, 720p, 768p, 1080p, 1K, 2K, 4K`; must be supported by the model |
| `aspect_ratio` | string | no | one of `16:9, 9:16, 1:1, 4:3, 3:4, 3:2, 2:3, 21:9, 9:21` |
| `size` | string | no | exact `WIDTHxHEIGHT` (e.g. `1280x720`); alternative to `resolution`+`aspect_ratio` |
| `frame_images` | array | no | image-to-video; each item: `{type: "image_url", image_url: {url}, frame_type: "first_frame"|"last_frame"}` |
| `input_references` | array | no | reference-to-video; each item: `{type: "image_url", image_url: {url}}` |
| `generate_audio` | boolean | no | defaults to `true` on models that support audio |
| `seed` | integer | no | not guaranteed deterministic across all providers |
| `callback_url` | string | no | HTTPS webhook, overrides workspace default |
| `provider` | object | no | provider-specific passthrough, see below |

`frame_images` takes precedence over `input_references` if both are present.

## Submit response (202)

```json
{ "id": "abc123", "polling_url": "https://openrouter.ai/api/v1/videos/abc123", "status": "pending" }
```

## Poll response

```json
{
  "id": "abc123",
  "generation_id": "gen-1234567890-abcdef",
  "polling_url": "https://openrouter.ai/api/v1/videos/abc123",
  "status": "completed",
  "unsigned_urls": ["https://openrouter.ai/api/v1/videos/abc123/content?index=0"],
  "usage": { "cost": 0.25, "is_byok": false }
}
```

Statuses: `pending` -> `in_progress` -> `completed` | `failed` | `cancelled` | `expired`.
On non-`completed` terminal states, check the `error` field.

## Video models catalog entry shape

```json
{
  "id": "google/veo-3.1",
  "canonical_slug": "google/veo-3.1",
  "name": "Google: Veo 3.1",
  "supported_durations": [4, 6, 8],
  "supported_resolutions": ["720p", "1080p"],
  "supported_aspect_ratios": ["16:9", "9:16", "1:1"],
  "supported_sizes": ["1280x720", "1920x1080"],
  "pricing_skus": { "per-video-second": "0.50", "per-video-second-1080p": "0.75" },
  "allowed_passthrough_parameters": ["output_config"]
}
```

Always fetch this live (`scripts/list_models.py`) rather than trusting a
hardcoded list — new models and capability changes ship frequently.

## Known model families (as of this writing — verify against the live catalog)

- **Google Veo 3.1 / Veo 3.1 Lite** — native synchronized audio, `personGeneration`
  passthrough param, strong general quality; Lite is the cheaper/faster tier.
- **OpenAI Sora 2 Pro** — high-end text/image-to-video.
- **ByteDance Seedance 2.0 / 1.5** — text-to-video, image-to-video with first/last
  frame control, multimodal reference-to-video; strong character/style
  consistency. Seedance 2.0 Fast trades quality for speed/cost.
- **Alibaba Wan 2.7 / 2.6** — supports long-form storytelling, up to 50 reference
  assets (image/video/audio), first/last frame control, video extension.
- **MiniMax Hailuo 3** — good cost/quality balance, supports 2K with audio.
- **Black Forest Labs FLUX 3 Video** — unified multimodal family (video, audio,
  image, action-prediction); supports text-to-video, image-to-video with
  multiple key frames, video continuation, native audio with lipsync.

Pick by: cost per video-second (`pricing_skus`), whether the user needs audio,
whether they need image/reference conditioning, and whether their target
duration/resolution/aspect ratio is in the model's supported lists.

## Provider-specific passthrough (`provider` field)

Keyed by provider slug; only options matching the routed provider are forwarded.
Check `allowed_passthrough_parameters` on the model entry before using this.

```json
{
  "model": "google/veo-3.1",
  "prompt": "A time-lapse of a flower blooming",
  "provider": {
    "options": {
      "google-vertex": {
        "parameters": { "personGeneration": "allow", "negativePrompt": "blurry, low quality" }
      }
    }
  }
}
```

## Webhooks (alternative to polling)

Set `callback_url` per-request (HTTPS only) or a workspace-level default. On a
terminal job state OpenRouter POSTs an event envelope with
`type` in `video.generation.completed | .failed | .cancelled | .expired`, plus
an `X-OpenRouter-Idempotency-Key: <job_id>-<status>` header for dedup.

Verify authenticity via `X-OpenRouter-Signature: t=<timestamp>,v1=<hmac>` when a
signing secret is configured in workspace settings:

1. Extract `t` and `v1`.
2. Reject if `now - t > 300` seconds (replay protection).
3. Compute `HMAC-SHA256(secret, "{t},{raw_body}")` and hex-compare to `v1`
   using a constant-time comparison — always verify against the **raw** request
   body, not a re-serialized JSON object (key order/number formatting can
   change and break the signature).

## Zero Data Retention

Video generation is **not ZDR-eligible** — the provider must briefly retain
output so it can be downloaded after async completion. If the workspace has
ZDR enforcement on (account settings or per-request `zdr` param), OpenRouter
refuses video requests outright. Surface this to the user rather than retrying.

## Sequence generation and merging (`generate_sequence.py`, `merge_clips.py`)

These aren't OpenRouter API features — they're this skill's orchestration
layer on top of it, since the base API only generates one clip per job with
no concept of multi-scene video. `generate_sequence.py`:

1. Resolves each scene's model/duration/resolution/aspect_ratio (falling back
   to shared CLI defaults for anything a scene doesn't override).
2. Validates each against that model's live `supported_durations` /
   `supported_resolutions` / `supported_aspect_ratios` and clamps to the
   nearest supported value if needed (see `validate_and_clamp` in
   `openrouter_client.py`) — this is what stops "give me a 10s clip" from
   silently 400ing against a model that only supports 4/6/8s.
3. Submits every scene's job immediately, then polls all outstanding jobs in
   a round-robin loop (one GET per pending job per interval) rather than
   waiting on each job's full duration sequentially — this is the difference
   between wall-clock time roughly equal to the slowest single clip vs. the
   sum of all of them.
4. Downloads each completed clip as `clip_NN.mp4`.
5. Hands the ordered list of successful clips to `merge_clips.merge_videos()`.

`merge_clips.py` exists because clips from independent generation jobs are
not guaranteed to share resolution, frame rate, or even the presence of an
audio track — the ffmpeg concat demuxer requires matching stream parameters,
so naively concatenating raw generated clips can silently produce corrupted
or desynced output instead of erroring loudly. The merge step:

1. `ffprobe`s every clip for width/height/duration/audio presence.
2. Picks a common target resolution (largest by area among the inputs, unless
   overridden) and a common fps (default 30).
3. Re-encodes each clip to that resolution (scale + pad to preserve aspect
   ratio, not a stretch), that fps, `yuv420p`, and adds a silent AAC track to
   any clip that has none — so every normalized clip has an identical stream
   layout.
4. Concatenates with the ffmpeg concat demuxer (`-c copy`, fast, no
   re-encoding at this stage since streams already match) for hard cuts, or
   chains `xfade` (video) + `acrossfade` (audio) pairwise across all clips for
   a crossfade transition.

If you need something these two scripts don't cover (e.g. per-clip volume
normalization, subtitles, a Ken Burns pan on a still image before merging),
extend `merge_clips.py` rather than hand-rolling a separate ffmpeg pipeline —
keep the normalization step, since skipping it is the most common source of
broken merged output.

## Common failure modes

- **400 on submit**: `duration`/`resolution`/`aspect_ratio` not in the model's
  supported lists — the error body lists valid values; re-check via
  `list_models.py --id <model>` and retry with a valid value instead of guessing.
- **`failed` status after `in_progress`**: check `error` field — often a content
  policy violation or an unreachable reference image URL.
- **Stuck in `pending`**: normal under load; keep polling, don't resubmit.
