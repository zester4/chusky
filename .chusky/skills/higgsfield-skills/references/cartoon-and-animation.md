# Cartoon, Anime & Animation Prompts

Sources: Academy "Cartoon & 2D Animation" (Seedance 2.0 4K), Academy "AI Animated Short — Scene 1", Seedance 2.0 Complete Prompting Guide, Cinema Studio Prompt Guide, OpenAI Image Styles x Higgsfield blog, Plushies app page (higgsfield.ai).

Workflow Higgsfield uses for animated shorts:
1. Keyframe: Soul Cinema with the enhancer on and a plain prompt, e.g. "Cartoon, highly stylized, a man waking up in the bedroom" (batch of 4; let it surprise you, e.g. paper-cutout style). Fix small issues in Nano Banana Pro instead of re-rolling.
2. Prop sheet for any recurring object, in the same style (multiple angles), so the video model keeps it consistent.
3. Video: Seedance 2.0, one scene per ≤15 s generation, timed segments, style reference image as `@image`/`<<<image_1>>>`.
Rules: say the animation aesthetic in the first line; repeat "maintain consistent [style] throughout all frames"; describe physics/particles as precisely as the actions; add "no design drift, no morphing".
Stylized presets also exist (Ghibli-, LEGO-, Simpsons-, Pixar-like looks via image styles) — keep prompts free of real franchise/character names; describe the look instead.

---

## 1. Prop / product design sheet in a stylized look (Nano Banana Pro)
Original: "Prop sheet of a wristwatch, multiple orthographic views (front, side, back, top), exploded view showing internal components, detailed material breakdown, cinematic lighting, soft warm light and subtle shadows, slightly stylized realistic rendering, painterly textures, imperfect handcrafted feel, clean neutral background, studio setup, high detail, design sheet layout, annotations and callouts, 3D concept art style, consistent proportions, product design presentation, warm color grading, subtle grain"
```
Prop sheet of [OBJECT / PRODUCT], multiple orthographic views (front, side, back, top), exploded view showing internal components, detailed material breakdown, [LIGHTING], [RENDER STYLE matching the keyframe, e.g. painterly textures, imperfect handcrafted feel], clean neutral background, design sheet layout, annotations and callouts, 3D concept art style, consistent proportions, [GRADE], subtle grain
```
Use for: a brand mascot's accessory, a product that must appear in every scene.

## 2. 2D anime scene with timed beats (Seedance 2.0)
Original (abridged): "<<<image_1>>> is the character reference AND visual style reference — a young man drawn in a bold anime/illustration style: clean flat cel-shading, thick confident outlines, with watch on his left hand <<<image_2>>>… Maintain consistent 2D anime illustration style throughout all frames. Opening frame (0–4s): The young man jolts awake… classic anime shock expression: wide eyes, sweat drop… Rushed preparation (4–10s)… anime speed lines… Map selection + discovery (10–14s)… Teleportation (14–15s)… Style: bold 2D anime illustration, cel-shaded flat coloring, thick confident outlines… 2.35:1 widescreen, 24fps."
```
<<<image_1>>> is the character reference AND visual style reference — [CHARACTER] drawn in [STYLE: e.g. bold anime illustration, clean flat cel-shading, thick confident outlines], [KEY PROP from <<<image_2>>>]. Limited palette of [COLORS]. The entire video must match this exact [STYLE] aesthetic. Maintain consistent [STYLE] throughout all frames.
[BEAT NAME] (0–[X]s): [ACTION with anime expression cues: wide eyes, sweat drop, speed lines]. [Camera: handheld-style pan / fast cuts / Dutch angle].
[BEAT NAME] ([X]–[Y]s): [..]. [On-screen UI text in quotes, e.g. "[MESSAGE]"].
[BEAT NAME] ([Y]–[Z]s): [discovery / twist].
[CLIMAX] ([Z]–15s): [impact frames, shockwave rings, smash cut].
Style: [STYLE], cel-shaded flat coloring, thick outlines, [PALETTE] with [ACCENT] highlights, anime speed lines and impact frames, [ASPECT, e.g. 2.35:1 or 9:16], 24fps.
```
How to tweak: for ads, make the twist the product ("a third option glows: [⚡ BRAND — NEW]").

## 3. 2D hand-drawn anime action, no references (Cinema Studio)
Original opening: "2D hand-drawn anime style with top-tier cinematic production quality. A surreal urban transformation action scene set in a modern city at night, with neon lights reflecting on rain-soaked streets…"
```
2D hand-drawn anime style with top-tier cinematic production quality. [SCENE CONCEPT] set in [LOCATION + TIME], [ATMOSPHERE].
[WORLD EVENT, e.g. the city reorganizes / gravity shifts].
[CHARACTERS] [ACTION, choreography in 2–3 sentences].
[AESTHETIC MOTIF]. The camera [FAST CAMERA LANGUAGE: rotates, rolls, switches overhead → low angle → side].
[PARTICLES / DEBRIS details]. [Cloth and hair physics].
Cel-shaded coloring, hand-drawn line texture, strong depth-of-field, cinematic widescreen composition.
```

## 4. Stylized 3D animated action with keyframe (Seedance 2.0)
Original (abridged): "@image is the first keyframe and style reference. Cinematic stylized 3D animation — photorealistic desert environment, stylized characters. Hero: young woman, white braided hair… Monster: colossal cosmic entity… 0–3s: WIDE SHOT from @image… 3–6s… 6–9s… 9–12s… 12–15s… Cinematic stylized 3D animation matching @image, photorealistic desert particle simulation, volumetric dust storm… 2.35:1, 24fps."
```
@image is the first keyframe and style reference. Cinematic stylized 3D animation — [ENVIRONMENT LOOK], stylized characters.
Hero: [LOOK + ABILITY]. [Antagonist/Mascot]: [LOOK]. Setting: [..]. High FPS, realistic particle physics.
0–3s: WIDE SHOT from @image. [CONFRONTATION].
3–6s: [DISCOVERY / NEW TACTIC]. Half-second slo-mo on [MOMENT] — SMASH full speed.
6–9s: [CLIMAX ATTACK].
9–12s: [ESCALATION / ESCAPE].
12–15s: [RESOLUTION, emotional beat].
Cinematic stylized 3D animation matching @image, [PARTICLE + VFX LIST], fast dynamic cuts. [ASPECT], 24fps.
```

## 5. Painterly fantasy flight, 15 s (Seedance 2.0 4K)
Original (abridged): "SURREAL FANTASY — GIRL FLIES HER COLORFUL WORLD ON A CUTE CREATURE (CINEMATIC, 15s). Lush cinematic fantasy, hyperreal yet painterly — like a living classic matte-painting… THE WORLD… THE COLOR… THE GIRL… THE CREATURE… Same design in every frame, no drift. KEY LOCKS… SHOTS — ONE CONTINUOUS FLIGHT… FORBIDDEN — no franchise or IP references… 15s. 16:9. 24fps. SFX only…"
```
[TITLE IN CAPS] ([DURATION]s)
[LOOK: e.g. lush cinematic fantasy, hyperreal yet painterly, saturated color, soft volumetric light, fine film grain, anamorphic].
[ONE-LINE STORY]. [ASPECT], [DURATION]s.
THE WORLD: [..]. THE COLOR: [palette]. THE [HERO]: [..]. THE [CREATURE / MASCOT]: [design]. Same design in every frame, no drift.
KEY LOCKS: [scale rule], [physics rule], consistent design — no morphing, camera flies WITH [subject], solid architecture, no warping.
SHOTS — ONE CONTINUOUS [MOVE]:
 0–4s — [..]   4–9s — [..]   9–15s — [..]
FORBIDDEN — no franchise or IP references, no recognizable characters, no readable text or logos, no warping geometry, no design drift, no plastic CGI gloss.
[DURATION]s. [ASPECT]. 24fps. SFX only: [..]. No dialogue.
```
How to tweak: replace the creature with the brand mascot for a kids' or snack brand.

## 6. Cartoon spectacle FPV oner (Seedance 2.0)
Original opening: "A colossal wind-up clown golem — bright, cartoonish and goofy, not scary… crashes through a floating carnival park in a brilliant blue sky… The camera is an FPV presence flying with the golem… brief slow-motion macro beat… at the three-second mark and a frozen bullet-time macro orbit… at the seven-second mark…"
Pattern: [giant character, tone "cartoonish and goofy, not scary"] + [setting in acid-bright colors] + FPV camera + timed slow-mo at 3 s and bullet-time at 7 s + "never stopping". Closing tags: `single continuous shot, one take no cuts, cinematic FPV oner, 4K ultra-detailed, playful whimsical tone, professional color grading, fluid drone flight`.

## 7. Quick experiments
- "Fight of a 3D person with 2D" (Seedance, exactly as written).
- "Fast paced anime opening featuring a knight, a female mage, a dwarf and a schoolboy in medieval new york." (Sora guide short prompt) → template: `Fast paced anime opening featuring [CHARACTER LIST] in [UNEXPECTED SETTING].`

## 8. Plushie / knitted toy look (Plushies app or image prompt)
Use a well-lit, centered waist-up photo. Prompt idea built on the app's description:
```
Reimagine the person in @image_1 as a handcrafted [soft stuffed plush toy / knitted wool doll] with realistic [fabric fuzz / wool fibers and stitching], same hairstyle, outfit colors and accessories, sitting on [SURFACE], soft studio light, shallow depth of field. [Video: animate in jerky handmade stop-motion style like classic puppet films.]
```
