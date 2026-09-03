---
name: chusky-media
description: >
  Route image and video requests through Chusky's native CHUCK_GENERATE_IMAGE
  and CHUCK_GENERATE_VIDEO tools, and use Daytona for deterministic media
  processing. Do not create provider-specific integrations or request API keys.
metadata:
  short-description: "Chusky-native image/video generation and Daytona processing"
user-invocable: false
---

# Chusky media routing

Read [the media tool boundary](../../references/media-tools.md) before media
work. This compatibility skill replaces the old provider-specific API guide.

## Tool selection

| User request | Use | Important limitation |
|---|---|---|
| New image for chat | `CHUCK_GENERATE_IMAGE` with `destination: "telegram"` | Immediate normal-channel delivery. |
| New image for workspace work | `CHUCK_GENERATE_IMAGE` with `destination: "daytona"` or `"both"` | Returns a verified Daytona path. |
| New video for chat | `CHUCK_GENERATE_VIDEO` with `destination: "telegram"` | Asynchronous normal-channel delivery. |
| New video for workspace work | `CHUCK_GENERATE_VIDEO` with `destination: "daytona"` or `"both"` | Path is usable after workflow completion. |
| Resize, crop, composite, convert, inspect, or package a real file | Daytona | Start from a verified upload or Daytona path. |
| Deliver a finished multi-file or binary artifact | `CHUCK_ARTIFACT` | Register only after validation and preview/QC. |

## Routing rules

1. For a new image, call `CHUCK_GENERATE_IMAGE` with a concise, complete
   prompt. Use `destination: "daytona"` when the image must be opened,
   postprocessed, composed into a site, or used by another workspace command;
   use `both` when the user should also receive it in chat. Do not use `fetch`,
   an SDK, or an environment variable for a media provider.
2. For a new video, call `CHUCK_GENERATE_VIDEO` and use `destination:
   "daytona"` or `"both"` when the finished clip is part of a workspace
   pipeline. It is asynchronous: wait for the completion/path notification
   before issuing Daytona commands that consume it.
3. If the user asks to edit a supplied image or animate a particular still,
   first check whether a source-aware native tool is actually exposed. The
   current Chusky surface is not source-aware, so use Daytona for deterministic
   edits where possible, or state that the requested generative transformation
   is unavailable.
4. If a generated result must be fed into a Daytona pipeline, request the
   Daytona destination and use the returned verified path. For video, this is a
   later workflow step; do not consume the path before completion.
5. Keep exact text, data, layouts, and document structure in code-generated
   assets; use generative media for visual material where precision is not the
   requirement.

## Never do this

- Do not read or configure any provider API key.
- Do not call a provider endpoint directly.
- Do not use undocumented generation, rendering, or asset-id helpers.
- Do not claim a video, image, or artifact exists before the native tool or
  Daytona operation has completed and returned a verifiable result.
