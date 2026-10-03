---
name: image
description: Create, edit, and refine professional images with Chusky's capability-aware OpenRouter image studio; use for image generation, image editing, visual concepts, product assets, brand graphics, posters, thumbnails, and controlled variations.
---

# Image Generation

Use this skill whenever the user asks to create, edit, redesign, refine, vary,
or visually develop an image.

## Core workflow

1. Understand the visual objective, audience, destination, aspect ratio, and
   whether the request is generation, editing, or controlled variation.
2. If the task depends on a particular capability—text rendering, branding,
   4K, many references, product consistency, speed, or budget—call
   `CHUCK_LIST_IMAGE_MODELS` first.
3. Select the best model or leave `model` unset so the capability-aware router
   chooses automatically.
4. Use `CHUCK_GENERATE_IMAGE` with a complete visual brief. Use `mode=edit`
   for an existing image and `mode=reference_variations` for controlled
   alternatives.
5. Use references deliberately: `current:0` for the current inbound image,
   `generated:0` for an image created earlier in this run, or the exact saved
   image asset ID/name for a durable asset.
6. Inspect the returned image result before describing it or using it in a
   connected-app action.
7. If the user explicitly asks to keep the image for later, use
   `CHUCK_SAVE_IMAGE_ASSET`. Do not save images merely because they appeared in
   conversation.

## Prompt reference library

Read the matching reference file when the request is specialized. Do not load
the entire library for a simple image request.

These references are a design-learning library, not copy-and-paste recipes.
Learn from their visual principles—art direction, composition, hierarchy,
lighting, materials, typography, pacing, and production constraints—then
create a materially original result. Never reproduce a reference's exact
prompt, person, pose, garment, product, brand, logo, wording, dates,
percentage, distinctive layout, or signature graphic treatment. Replace those
elements with the user's real brief and invent fresh details. If the user
provides a reference image or campaign, preserve only the broad requested
creative direction and make the identity, copy, composition, and assets
distinct unless the user explicitly owns and requests an edit of that asset.

- [Prompt principles and sources](references/README.md)
- [Fashion and fashion-brand campaigns](references/fashion.md)
- [Logos and brand identity](references/logos.md)
- [Flyers, posters, and event graphics](references/flyers-posters.md)
- [Advertising and product campaigns](references/advertising.md)
- [Social, editorial, and content graphics](references/social-editorial.md)

## Model selection

Use `CHUCK_LIST_IMAGE_MODELS` for live limits. The curated routing roles are:

- `qwen/qwen-image-3`: precise text, labels, posters, diagrams, and small
  details.
- `recraft/recraft-v4.1-flash`: fast logos, icons, brand graphics, and social
  assets. It produces raster images; do not promise SVG unless a vector model
  is explicitly selected and supported.
- `bytedance-seed/seedream-4.5`: portraits, products, and consistent edits
  across many references.
- `black-forest-labs/flux-3-image`: premium photorealism, multi-reference
  editing, and high-resolution work.
- `openai/gpt-image-2`: high-fidelity production assets, precise edits, strong
  instruction following, up to 16 references, and up to 10 outputs.
- `meta/muse-image`: complex composition and agentic image editing.
- `krea/krea-2-medium`: economical illustration and style exploration.
- `x-ai/grok-imagine-image-2.0`: fast general-purpose generation and editing.

Do not assume every model accepts the same controls. The runtime filters
unsupported parameters, enforces reference limits, and batches outputs when a
model cannot return the requested count in one request.

## Prompt construction

Write prompts as production briefs, not short keyword piles. Include:

- Subject: what must be shown.
- Action or pose: what is happening.
- Environment: location, background, time, and atmosphere.
- Composition: camera/viewpoint, framing, subject placement, and negative
  space.
- Lighting and color: light direction, contrast, palette, and mood.
- Material/style: photography, editorial illustration, 3D, watercolor, etc.
- Typography: exact text, hierarchy, placement, and spelling requirements.
- Output constraints: aspect ratio, intended platform, and safe margins.

Put critical requirements first. State what must not change when editing, such
as a person's identity, product shape, logo geometry, or packaging text.

### Prompt template

```text
Create [asset type] for [audience/use].

Subject: [main subject and important details].
Action/pose: [what is happening].
Composition: [shot type, viewpoint, framing, placement, and negative space].
Environment: [setting, background, time, atmosphere].
Style/material: [visual style, lens/rendering/material].
Lighting/color: [light, palette, contrast, mood].
Typography: [exact text and placement, if any].
Constraints: preserve [items]; avoid [failure modes]; keep important content
inside safe margins for [destination].
```

## Strong prompt examples

### Product campaign

```text
Create a premium 4:5 ecommerce hero image for a sustainable black stainless
steel water bottle. Place one bottle upright on a warm limestone pedestal with
subtle condensation, centered slightly right with clean negative space on the
left for headline text. Soft morning window light from the upper left, muted
olive and sand palette, realistic studio photography, crisp material detail,
natural shadows, no people, no extra bottles, no readable text, no warped logo.
Keep the bottle silhouette and cap geometry accurate.
```

### Text-heavy poster

```text
Create a clean 4:5 event poster for “NORTHSTAR PRODUCT SUMMIT” with the exact
subtitle “Build what matters” and date “October 18, 2026”. Use a dark navy
background, one bright cobalt geometric star, bold white sans-serif typography,
clear hierarchy, generous margins, and high contrast. Spell every word exactly,
use no additional text, no logos, no decorative watermark, and keep all text
inside the safe area.
```

### Brand mark concept

```text
Create six distinct modern brand-mark concepts for a workforce-management
company named “HARBOR”. Use simple geometric forms suggesting coordination and
trust, restrained navy and teal palette, strong silhouette at small sizes, and
clean negative space. Present each concept separately on a plain light
background. No mockup, no gradients, no tiny illegible text, and no invented
tagline. This is exploration, not a final trademark claim.
```

### Reference edit

```text
Edit the referenced product photo into a polished LinkedIn announcement image.
Preserve the exact product proportions, buttons, logo placement, and brand
colors. Replace the background with a bright modern office, add soft rim light,
leave the left third empty for copy, and make the result look like an authentic
commercial photograph. Do not add people, extra products, fake text, or change
the product design.
```

### Editorial illustration

```text
Create a wide 16:9 editorial illustration about a small business team planning
its next quarter. Show four diverse adults around a table with printed charts,
sticky notes, and a whiteboard, viewed from a slightly elevated angle. Use a
confident flat-vector style, navy, coral, cream, and sage palette, clear shapes,
warm daylight, balanced composition, and generous outer margins. No readable
brand names, no distorted hands, no extra limbs, and no visual clutter.
```

## Editing and variation rules

- For edits, name the exact elements to preserve before the requested change.
- Use `reference_variations` when the user wants options that maintain the same
  subject, product, or composition.
- Use multiple references only when each reference has a clear role; describe
  which reference supplies identity, style, layout, or color.
- Do not silently combine unrelated current and saved images. Ask which image
  is intended when more than one could match.
- Request a deliberate count. More variants increase provider cost and can
  reduce consistency.
- For exact wording, prefer the text-capable model and keep copy short. Always
  inspect the output because image models can still misspell text.

## Delivery and privacy

- Standalone images should use the normal active-channel delivery.
- Use Daytona only when the image is explicitly needed as a workspace file or
  artifact input.
- Never expose private R2 URLs, image bytes, asset internals, or credentials.
- Do not claim an image was saved, uploaded, posted, or published without the
  returned tool result confirming that exact action.
- Connected-app publishing must use the owner-scoped media bridge and the
  exact provider action schema.

## Gotchas

- Do not send unsupported controls just because another model supports them.
- Do not promise transparent backgrounds, SVG, 4K, multiple outputs, or a
  specific reference count without checking the selected model's capabilities.
- Do not describe an image as factual evidence. Image generation is creative;
  factual claims should come from verified text sources or user-provided facts.
- Do not use a generated image as a durable memory unless the user explicitly
  asks to save it and provides a useful name and purpose.

## Evaluation cases

1. “Make a poster with the exact words X, Y, and Z.” → inspect model
   capabilities, choose text-capable routing, preserve exact copy, and report
   if the rendered text needs revision.
2. “Make five versions of this product image.” → use the reference image,
   preserve product identity, request five variants, and avoid unrelated
   composition changes.
3. “Create a logo as an SVG.” → check for a vector-capable model; never claim
   raster output is SVG.
4. “Use my saved logo in a LinkedIn post.” → retrieve the exact saved asset and
   use the owner-scoped media bridge; never expose its private URL.
