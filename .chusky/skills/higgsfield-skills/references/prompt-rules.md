# Prompt Rules, Formula and Model Picks

Source: Higgsfield Help Center "How do I write a good prompt?", Nano Banana Pro Prompt Guide, Sora 2 Prompt Guide, Seedance 2.0 Prompting Guide, AI video camera-control blog (higgsfield.ai).

## Universal layers

Image prompt = Subject + Details (appearance, clothing, expression) + Composition/Camera + Action + Location/Environment + Style/Medium + Lighting + Aspect ratio.
Video prompt = add Camera movement, Mood, Audio, and a shot list with timecodes.

Fill-in skeleton (image):
```
[SHOT TYPE, e.g. medium close-up / full-body / flat lay] of [SPECIFIC SUBJECT], [APPEARANCE + WARDROBE DETAILS], [ACTION / POSE], in [LOCATION + ATMOSPHERE]. [LIGHTING: source, direction, quality]. [CAMERA: lens mm, aperture, angle, e.g. "shot on 85mm, f/1.8, low angle"]. [STYLE / MEDIUM, e.g. candid iPhone photo, 35mm film, editorial, flat vector]. [COLOR PALETTE / HEX]. [ASPECT RATIO]. No [THINGS TO AVOID].
```

Fill-in skeleton (video, structured blocks, the Higgsfield "shot list" format):
```
Format & Style: [FORMAT, e.g. UGC reaction video / cinematic ad / fashion editorial reel], [DURATION]s, [ASPECT RATIO].
Camera: [CAMERA + MOVEMENT].  Lens: [FOCAL LENGTH, DOF].
Main Subject: [WHO, AGE, ENERGY].  Wardrobe & Props: [DETAILS].
Location: [FOREGROUND / MIDGROUND / BACKGROUND].
Lighting & Palette: [KEY LIGHT, COLOR ANCHORS].
Actions & Camera Beats:
  0–[X]s — [ONE CAMERA MOVE + ONE SUBJECT ACTION].
  [X]–[Y]s — [...].
Dialogue: "[EXACT LINES]"
Sound & Foley: [AMBIENCE, SFX, MUSIC OR "NO MUSIC"].
Finish: [GRADE, GRAIN, POSTER FRAME].
```

## Rules that change results

- Be specific: "A Shiba Inu with metallic plating", not "dog".
- State shot structure up front for video: number of shots, total duration, aspect ratio (Seedance rule).
- One camera move + one subject action per shot, with a strong specific verb.
- Put dialogue in its own Dialogue block, ideally with timestamps, for clean lip-sync.
- Put on-image text in double quotes and name the font style ("bold condensed sans").
- Use HEX codes for brand colors (#D1FE17).
- Name camera gear for realism: "shot on full-frame cinema camera", "ARRI ALEXA aesthetic", "iPhone 15 Pro front camera".
- Remove filler ("please", "could you"). Command-style syntax works better.
- Say what you want first; add a short list of exclusions only where needed ("no readable text, no plastic skin, no watermarks").
- Tell the camera what it is NOT doing: "no cuts, no zoom, natural head movement". A dolly and a zoom must be named explicitly with the other ruled out.
- For realism on monsters/VFX: add "no 3D, no cartoon, no VFX look".
- For comedy: "add a visual gag in the background".
- Inline VFX in brackets: `[VFX: branching electric circuits pulsing with white-blue current]`.
- Keep identity across edits with: "Keep the exact same [person], same face, same pose, same background and lighting. Change only [X]."
- Prompt and reference image must agree (don't ask for "still, calm" on a motion-blurred frame).
- Iterate one variable at a time (lighting, then lens, then wardrobe).
- Write in English (Seedance/Kling sometimes respond better to Chinese for nuanced motion).
- Long sequences: generate ≤15 s clips, use the last frame of one as the start of the next.

## Model / tool picks (as described on higgsfield.ai)

| Need | Use |
|---|---|
| Fashion, aesthetic, culture-native photos; presets; consistent face (Soul ID, 20+ photos) | Soul 2.0 |
| Film-still keyframes, characters, locations, cheap batches of 4 | Soul Cinema |
| Structured layouts, text, infographics, edits with references (up to 14), identity swaps | Nano Banana Pro / Nano Banana 2 |
| Photoreal product imagery, packaging, UI screens, near-perfect text, 4K | GPT Image 2 |
| JSON-structured prompts, HEX colors | FLUX.2 |
| Product shots, UGC, ads, marketplace, posters, motion from a product link | Marketing Studio (presets: UGC, Pro Virtual Try-On, Hyper Motion, TV Spot, Wild Card) |
| Multi-shot cinematic video up to 15 s (2.5: up to 30 s, 50 refs, region edits) | Seedance 2.0 / 2.5 |
| 4K, multi-shot up to 6 cuts, talking heads, voice binding | Kling 3.0 |
| Cast character sheets, camera/lens/lighting locked as settings | Cinema Studio |
| Restyle a video / swap outfit, product or location keeping motion | Genjutsu / AI Influencer |

## Aspect ratio defaults

9:16 TikTok/Reels/Shorts, 3:4 Instagram post, 2:3 or 3:4 editorial, 1:1 marketplace, 16:9 YouTube/TV spot/website hero, 2.39:1 or 2.35:1 cinematic.
