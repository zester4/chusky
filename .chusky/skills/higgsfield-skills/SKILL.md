---
name: higgsfield-skills
description: "Write Higgsfield-style AI image and video prompts from proven templates: fashion and lookbooks, product shots and brand mockups, UGC and video ads, cinematic multi-shot video, cartoon/anime, and camera moves. Use when the user wants a prompt for Higgsfield, Soul, Nano Banana, GPT Image, Seedance, Kling or Sora. Not for generating the media itself."
metadata:
  author: joan-ackerman
  version: "1.0"
  source: "Prompts collected from public pages on higgsfield.ai (prompt guides, Academy, Prompt Bank, blog) in October 2026"
---

# Higgsfield Prompt Skills

Turn a short user request ("I need a UGC ad for my shea butter", "fashion lookbook for my brand") into a finished, high-control prompt, built from real templates published by Higgsfield.

## How the templates work

Every template in `references/` uses fill-in slots in square brackets, e.g. `[BRAND_NAME]`, `[PRODUCT_DESCRIPTION]`, `[HEX_COLOR]`.

- UPPERCASE slots like `[PRODUCT]` are required user info. Fill every one of them.
- Slots with a default value inside, like `[8]` meters or `[the lower third]` (common in camera moves), are tunable. Keep the default unless the user wants something else.
- `@image_1`, `@image_2`, `@video1` are reference-upload handles. Keep them and tell the user which file goes in which slot.
- Delete any line whose slot does not apply instead of leaving brackets in the final prompt.

## Workflow

1. Classify the request and open the matching reference file:
   | Request | Read |
   |---|---|
   | Fashion photos, lookbook, editorial, outfit swap, Soul presets, lifestyle "iPhone" photos | `references/fashion-and-lifestyle.md` |
   | Product photos, apparel or sneaker mockups, logo, brand identity, posters, infographics, packaging sheets | `references/product-and-brand.md` |
   | UGC videos, talking-head reviews, unboxing, try-on, app ads, TV spots, Hyper Motion, Wild Card | `references/ugc-and-ads.md` |
   | Cinematic video, multi-shot scenes, fights, transformations, POV, VFX, logo animation, character continuity | `references/cinematic-video.md` |
   | Cartoon, 2D anime, 3D animated, stylized or plushie looks | `references/cartoon-and-animation.md` |
   | Any video where camera motion matters (dolly, orbit, crane, whip pan, etc.) | `references/camera-moves.md` |
   Always also skim `references/prompt-rules.md` once per session: it carries the universal formula, model picks, and the do/don't rules.
2. Collect missing info. Ask only for required slots you cannot infer (brand name, product, colors, audience, platform/aspect ratio, duration, avatar/look). Infer sensible defaults for the rest and state them.
3. Pick the closest template, fill every slot, and adapt it with the "How to tweak" notes under that template. Keep the template's structure (shot blocks, timecodes, Style/Camera/Lighting/Audio blocks); that structure is what gives control.
4. Optionally run `python scripts/fill_prompt.py` (see below) to fill a template and confirm no `[SLOT]` is left.
5. Deliver in this shape:
   - Recommended model / Higgsfield tool and settings (aspect ratio, duration, quality)
   - Reference uploads needed, mapped to `@image_N`
   - The final prompt in a code block, no brackets remaining
   - 1–3 variant ideas (change one variable each: hook, lighting, setting)

## Script

`scripts/fill_prompt.py` fills a template from key=value pairs and lists any unfilled slots.

```bash
python scripts/fill_prompt.py --template template.txt BRAND_NAME="Adinkra Co" PRODUCT="shea butter jar"
python scripts/fill_prompt.py --list template.txt   # show required slots only
```

Use it when filling long templates with many slots; for short prompts fill by hand.

## Example

User: "UGC ad for my brand KENTE GLOW, a cocoa body oil, for TikTok."
Output: model = Marketing Studio, UGC preset (Seedance 2.0), 9:16, 15 s; uploads = product photo as `@image_1`; prompt = the "UGC product review (talking head)" template from `references/ugc-and-ads.md` with brand, product, creator look, setting and a 2-second hook filled in; variants = same ad with a different opening line, a GRWM version, an unboxing version.
