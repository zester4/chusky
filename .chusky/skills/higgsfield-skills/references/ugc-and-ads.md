# UGC & Video Ad Prompts

Sources: "How to Make AI UGC Videos for Marketing in 2026", "Build a Full Marketing Stack for Your App — Full Prompts", Sora 2 Prompt Guide, Academy "Social Video Content", Cinema Studio Prompt Guide, "10 AI Formats" product video blog, AI ad agency blog (higgsfield.ai).

Tool: Marketing Studio (Seedance 2.0 engine, native audio + lip sync, up to 15 s, up to 4 generations per run). Presets: UGC (styles: Shopping, At home, Delivery, Review, Try-on, Unboxing, Tutorial, Before/after), Pro Virtual Try-On, Hyper Motion (CGI), TV Spot (16:9 commercial), Wild Card (free creative). Also Ads image styles: Social proof, Comparison, Problem → Solution.

## UGC rules
- Hook in the first 2 seconds: unexpected object, bold claim, question, or "before" state.
- Micro-creator look: phone camera, imperfect framing, natural light, conversational delivery.
- Test hooks properly: same product, creator, preset and setting; change only the opening line. Test formats in a separate batch.
- For longer than 15 s: write two prompts (part 1, part 2) and cut together.
- Disclose AI content per TikTok/Meta rules.

UGC genre picker (hook examples from Higgsfield):
| Genre | Hook example |
|---|---|
| GRWM | "I replaced my entire morning routine with one product" |
| Tutorial | "You always used it wrong" |
| Before / after | "Day 1 vs day 30" |
| Testimonial | "I was skeptical until week two" |
| Unboxing | "The packaging alone sold me" |
| POV demo | "POV: your desk setup finally makes sense" |

---

## 1. UGC product review — talking head, multi-shot (Marketing Studio UGC)
Original (smart glasses): "A young man in his early twenties, short brown hair, clean face, green-and-white raglan tee with two purple stars, silver chain necklace, presents a pair of light grey matte smart glasses in a bright designer apartment… Shot 1, medium handheld eye-level… Shot 2, extreme macro close-up with slow orbit… Shot 3, low angle slow rise… Shot 4, wide static… Editorial vlog style… Dialogue (direct to camera, English, casual, 13 to 15 sec): "These just arrived this morning…" Audio: clear direct-to-camera voice, quiet room tone, soft ambient bed, no music."

Template:
```
[CREATOR: age, hair, face, outfit, one accessory] presents [PRODUCT from @image_1] in [SETTING: room, light, decor, materials].
The product is [EXACT PRODUCT DESCRIPTION: color, finish, shape, key feature, logo position].
Shot 1, medium handheld eye-level: [creator holds product up toward camera], natural drift, shallow depth of field.
Shot 2, extreme macro close-up with slow orbit: [product detail rotating in fingers, highlight sliding across KEY FEATURE].
Shot 3, low angle slow rise: [creator uses/applies/wears the product], [light detail].
Shot 4, wide static: full body in the room, [closing action, e.g. glances back at camera].
Editorial vlog style, natural handheld motion, shallow depth of field, clean soft daylight, realistic skin texture, 4K.
Dialogue (direct to camera, [LANGUAGE/ACCENT], casual, 13 to 15 sec): "[HOOK LINE]. [2–3 benefit lines in plain speech]. [CTA / next step]."
Audio: clear direct-to-camera voice, quiet room tone, soft ambient bed, no music.
```
How to tweak: write the script the way a person talks (short sentences, "look closer"). For local markets set accent, e.g. "English, Ghanaian accent", and a familiar setting.

## 2. UGC reaction selfie (Sora 2 guide long format)
Short version: "UGC reaction video. In a quiet kitchen, a person lifts a small bottle of water, and expressively talks about how good this water is"
Long template (from the original water-bottle prompt):
```
Format & Style: UGC reaction video – authentic, handheld, shot on front iPhone camera. Unfiltered realism, slight overexposure, raw and honest. Feels like someone impulsively filming a discovery they're excited about.
Camera: iPhone front camera in selfie mode, handheld one-hand, slightly shaky with autofocus micro-pulses. No stabilization or post edits.
Lens: native wide (~26mm), deep focus, edge distortion preserved.
Main Subject: [PERSON: age, energy], talking fast, gesturing with [PRODUCT], exaggerated expressions — [WHAT THEY DO / DON'T DO with it].
Wardrobe & Props: [CASUAL AT-HOME OUTFIT]. Props: [PRODUCT with realistic detail], [OTHER].
Location: [ROOM] with daylight through [WINDOW]. Foreground: product and hands. Midground: face. Background: out-of-focus [CLUTTER].
Lighting & Palette: natural side window light, unbalanced exposure, no grade.
Actions & Camera Beats (0–12s):
 0–4s — lifts product close to camera, eyes wide: "[HOOK LINE]"
 4–8s — leans closer, excited whisper: "[BENEFIT LINE]"
 8–12s — laughs, [PLAYFUL ACTION], gestures to lens: "[PAYOFF LINE]"
Montage Plan: single unbroken selfie take, no cuts.
Sound & Foley: raw phone audio, room echo, [PRODUCT SOUND], breathy laugh, no music.
Finish: ungraded iPhone video, minor flicker, exposure shifts.
```

## 3. Unboxing (UGC Unboxing)
Original (headphones, abridged): "Handheld vertical 9:16 UGC video, 14 seconds, a young man… sitting cross-legged on grey carpet in a small bedroom. The shot opens over his shoulder from a high angle, looking down at a clean matte warm-grey cardboard box… minimal geometric monogram stamped in brushed copper foil… then cuts to an extreme macro insert… the lid lifts and slides off with a smooth vacuum-like release, revealing burnt-orange over-ear headphones… then cuts to a low wide angle… then cuts to a tight product close-up… and ends on a front medium close-up as he puts them on…"
```
Handheld vertical 9:16 UGC video, [DURATION] seconds, [CREATOR + OUTFIT], [POSITION] in [ROOM].
The shot opens over [his/her] shoulder from a high angle, looking down at [PACKAGING: material, color, finish, logo treatment] on [his/her] lap;
then cuts to an extreme macro insert where [LOGO DETAIL] flares under raking light before [OPENING ACTION], revealing [PRODUCT] set in [INSERT/TRAY];
then cuts to a low wide angle as [he/she] lifts the product into the light, revealing the room: [5–8 SPECIFIC ROOM DETAILS];
then cuts to a tight product close-up as [he/she] [TOUCHES KEY FEATURE];
and ends on a front medium close-up as [he/she] [USES PRODUCT] and looks into the lens with a small satisfied smile.
[He/She] talks to camera throughout, casual and enthusiastic: "[OPTIONAL SCRIPT]". Soft natural window daylight, warm grade, shallow depth of field, realistic textures, slight handheld drift, 4K, candid but cinematic.
```

## 4. Problem → app/product → result story (UGC, app or product)
Original (CUE "Exhausted Home Cook", abridged): "@image_1 is the CUE app scan screen — display it statically on the phone screen… Do not animate any app interface. A woman stands in a bright modern kitchen… She says out loud in English: "What should I cook?" … one finger raises straight up… She grabs her smartphone… Fast cuts… Final shot: She picks up the plate… Says "Use CUE""
```
@image_1 is [SCREEN/PRODUCT REFERENCE] — display it statically on the phone screen when [MOMENT]. @image_2 is [RESULT SCREEN/PRODUCT] — [WHEN]. Do not animate any app interface.
[CHARACTER] [PROBLEM SITUATION in a specific place]. [He/She] says out loud in [LANGUAGE]: "[PROBLEM LINE]"
A beat of silence. Then [IDEA MOMENT gesture].
[He/She] [USES THE PRODUCT/APP] — [what the screen/product shows]. [Reaction].
Fast cuts: [3–5 ACTION BEATS showing the solution working].
Final shot: [HERO RESULT], turns to camera, says "[BRAND CTA, 2–3 words]".
Camera: mix of medium shots, close-ups of hands, over-the-shoulder during [KEY MOMENT], fast cuts during [MONTAGE], slow final hold.
Lighting: [..]. Sound design: [list of diegetic sounds].
```
Persona variant (original "gym bro"): change the character archetype and add an on-screen caption: `A bold white caption text overlay centered in the lower third reading "POV: [RELATABLE SITUATION]..." in a clean sans-serif font, white text with subtle drop shadow.` Tip: demand "plain [garment], no logos, no text" on wardrobe so only your brand shows.

## 5. Cinematic UGC with 360° orbit (Pro Virtual Try-On preset)
Pattern from the original: timecoded beats while "slow 360-degree orbital camera" runs the whole time, timelapse middle section, real-time ending line to camera.
```
[CHARACTER] stands in [SETTING].
0–3s: Slow 360-degree orbital camera begins — smooth, continuous. [ACTION 1].
3–6s: Orbit continues. [ACTION 2, product clearly visible].
6–8s: Over-the-shoulder — [PRODUCT MOMENT].
8–12s: Timelapse — orbit keeps rotating while [PROCESS] happens in accelerated time.
12–14s: Back to real time. [RESULT].
14–15s: Turns to camera, holds [RESULT] up, says: "[CTA]."
Camera: continuous slow 360-degree orbit throughout until the final hold.
Sound design: original [GENRE] instrumental beat; SFX [..]. No existing artists' songs.
IMPORTANT: [HARD CONSTRAINTS, e.g. product is only shown on the phone screen].
Style: super realistic, cinematic lifestyle commercial, warm tones, 4K.
```

## 6. Skate-through virtual try-on (Pro Virtual Try-On) — fashion brands
Original (abridged): "The character — dark hair, grey tank top… rides a skateboard continuously from left to right across the frame… Camera stays strictly side-on… As he skates, individual clothing items from the HIGGS collection levitate in the air ahead of him… He skates straight through each one… it is instantly on his body… Item 1 — … Item 5 — … Style: photorealistic cinematic, 2.39:1 Cinemascope…"
```
The character — [BASE LOOK] — [MOVES: skates / walks / runs] continuously from left to right across the frame. Camera stays strictly side-on, drifting alongside at constant speed and height. One continuous uncut shot.
As [he/she] moves, individual items from the [BRAND_NAME] collection levitate ahead — floating still at body height, exactly where they would sit on a person. [He/She] passes straight through each one without slowing; the moment [he/she] passes through, it is instantly on [his/her] body, perfectly fitted. No animation, no flash.
Item 1 — [ITEM]: floating at [HEIGHT], on.
Item 2 — [ITEM] ... Item [N] — [ITEM] ...
After the last item [he/she] is fully dressed in the complete [BRAND_NAME] collection, keeps moving, disappears into the distance. Frame holds on the empty space.
Background: one continuous [ENVIRONMENT] scrolling, [LIGHT]. [BRAND COLOR] appears on [wall markings/signage].
Sound: [movement sound], no music, city ambience.
Style: photorealistic cinematic, 2.39:1, desaturated warm daylight, [BRAND COLOR] as the only saturated color, streetwear editorial, one unbroken take.
```
Wild Card variants (originals): levitating in the clouds wearing the full outfit (handheld "camera operator on wire rig"), or running through hard-edged rectangular "cuts" into 6 different locations.

## 7. Hyper Motion CGI product reveal (Marketing Studio Hyper Motion)
Original (abridged): "Vertical 9:16 cinematic shot. A modern smartphone floats in pitch-black void… A finger taps the screen and camera crash-zooms forward THROUGH the phone display into deep space. A translucent ice cube emerges… Sudden hyper-speed shatter… Mid-air transformation in slow motion… Smooth pull-back reveals the smartphone again… deep blacks, hyperrealistic detail, fast-paced ad editing energy…"
```
Vertical 9:16 cinematic shot. [PRODUCT] floats in [VOID/ENVIRONMENT] with subtle [BRAND COLOR] gradient, [showing LABEL/SCREEN text "[TEXT]"]. [TRIGGER ACTION] and the camera crash-zooms forward [INTO/THROUGH the product].
[CONTAINER/OBJECT] emerges, [BRAND COLOR] rim light pulsing — trapped inside: [INGREDIENTS / FEATURES]. Sudden hyper-speed shatter in extreme slow motion, shards flying past the camera with light streaks.
Mid-air transformation in slow motion: [INGREDIENTS → FINISHED RESULT], spiraling with motion-blur trails. Camera orbits as they converge into [HERO RESULT].
Smooth pull-back reveals [PRODUCT] again, now showing [END CARD TEXT "[TAGLINE]"]. Cinematic premium aesthetic, deep blacks, hyperrealistic detail, fast-paced ad editing, multiple dynamic camera moves, 9:16.
```
Great for cosmetics (ingredients → cream), drinks, food, apps.

## 8. TV Spot lifestyle commercial, 16:9 (TV Spot preset)
Pattern from the original CUE wrap ad: list references first (@image_1 product/screen, @image_2 final result, @image_3 location), then a natural story with two short witty lines to camera.
```
@image_1 — [PRODUCT/SCREEN reference with exact details]. @image_2 — [FINAL RESULT reference]. @image_3 — [LOCATION reference].
[CHARACTER] [ACTION carrying the story start]. [Product visible as in @image_1].
[He/She] glances at [product], turns to camera with an easy playful look: "[WITTY LINE 1]." [Small comic beat].
Quick intimate cuts of [PROCESS steps]. The result exactly as in @image_2.
Small satisfied pause. [He/She] says with a light grin: "[PROMISE-KEPT LINE]." [Final action].
Handheld, warm light, product slightly visible in background. Cinematic TV commercial, 16:9, realistic.
Sound: [process sounds], warm music easing into a clean resolve on the final line.
```

## 9. Sportswear / multi-cut brand ad (Sora 2 / Seedance)
Short: `Make me a cinematic ad for sportswear brand named "[BRAND_NAME]"`
Long template (original HIGGS 12-second ad):
```
A [12]-second cinematic [CATEGORY] ad for [BRAND_NAME] – high-energy montage in [6] dynamic cuts.
[0–2s] CUT 1 / OPEN. [SCENE]: [CLOSE ACTION]. Camera [MOVE]. (Audio): [SFX].
[2–5s] CUT 2. [SCENE]: [SHOT]. (Audio): [..].
[5–7s] CUT 3. [..]   [8–10s] CUT 4. [..] — light flashing across [BRAND] logo on [GARMENT].
[10–12s] CUT 5 / IMPACT. [HERO WIDE SHOT at golden hour], [BRAND garment] glowing. Camera pulls back into sweeping drone arc. (Audio): music crescendo.
Voiceover (clean, aspirational): "[BRAND] — [TAGLINE]."
End tag: [BRAND] logo center-screen, [TEXTURE] ripple → [CTA button "SHOP NOW"].
VISUAL CUES: [PALETTE], mix of handheld and stabilized shots. Tone: [..].
```

## 10. Problem/solution/packshot 15 s ad (Cinema Studio — original pizza ad)
```
0–4 seconds: [CHARACTER from @image_1] [PROBLEM in a relatable setting]. [He/She] pulls out [PHONE/PRODUCT]. Close-up: [SCREEN/PRODUCT with a large button/label "[TEXT]"]. Thumb taps it. No other interactions.
4–9 seconds: Cut to [SOLUTION ARRIVING, e.g. delivery rider pulls up / product being made]. [Camera style].
9–15 seconds: Packshot. [CHARACTER] on the left third of the frame [ENJOYING RESULT]. Right third intentionally clean and empty, neutral background, no objects — space for logo. Warm soft lighting, static camera.
```
Tip: always reserve empty frame space for the logo/end card in the packshot.

## 11. Ten quick short-form formats (preset → tip)
Unboxing Surprise (Unpacking; add tearing-paper audio) · Before & After (Luxury Ad / Minimalist Corporate; 2–3 s transition) · Day in the Life (Dynamic Sport Ad; name the light: "morning glow through window") · POV Walkthrough (First-Person POV with Product; write where the subject walks and how the frame ends) · Reaction Cut (Reaction; end on a second angle) · Trend Remix (Gen-Z TikTok Edit; copy rhythm, not the story) · ASMR Product Focus (ASMR; near-silence) · Streamer/Vlog Highlight (add captions) · Epic Fail to Hero Product (short fail, fast payoff) · Minimal Product Loop (Minimalist Corporate; under 7 s, gentle rotation).

## 12. Multi-style ad batch brief (for an LLM / Supercomputer)
Original: "Make me video ads for a roofing business — each in a completely different style: cinematic before/after, funny, customer-testimonial, problem-focused, and premium brand vibe… Every ad needs a strong hook in the first 3 seconds and a clear call to action at the end."
```
Make me video ads for [BUSINESS TYPE / BRAND_NAME] — each in a completely different style: cinematic before/after, funny, customer-testimonial, problem-focused, and premium brand vibe. Audience: [AUDIENCE]. Offer: [OFFER]. Every ad needs a strong hook in the first 3 seconds and a clear call to action at the end: "[CTA]". Format: [9:16 / 16:9], [DURATION]s.
```
