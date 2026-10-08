# Cinematic Video Prompts

Sources: Seedance 2.0 Complete Prompting Guide, Cinema Studio Prompt Guide, Help Center prompt guide (cowboy example), Cinematic Ad Academy stage 1, Seedance 2.5 and Cinema Studio product pages (higgsfield.ai).

Models: Seedance 2.0 (≤15 s, multi-shot, references), Seedance 2.5 (≤30 s, 50 refs, region edits), Kling 3.0 (4K, up to 6 cuts), Cinema Studio (Cast character sheets, camera/lens/lighting as settings; camera MoveSet styles: Auto, Classic Static, Silent Machine, One Take, Epic Scale, Intimate Observer, Impossible Camera, Documentary Snap, Raw Chaos, Dreamy Flow).
For precise camera motion, paste a move from `camera-moves.md` into the shot description.

## Asset-first production (do this before any big video)
Lock every recurring element as an image first: character sheet (front/side/back), product sheet (front/back/top), location still (most important: video inherits its texture and lighting), props. Test character + location together with a quick clip before writing the full scenes.

Character sheet template (from the mech/hero sheet prompts):
```
[CHARACTER] character reference sheet, [N] views side by side on a seamless neutral gray studio background: [FRONT / SIDE / REAR], labeled in small uppercase beneath the feet, identical scale. [BUILD, STANCE]. [COLOR SPLIT, e.g. 60% white / 30% red / 10% cyan]. [KEY DETAILS per view]. Lighting: three-point studio — key top-left, fill right, strong rim from behind. [RENDER STYLE].
```
Location still: `Modern empty [LOCATION] on a [WEATHER/TIME], clear sky, anamorphic lens wide cinematic feel, film grain, no people.` (Soul Cinema)

---

## 1. Multi-shot Hollywood montage header (Seedance)
Original opener used on every transformation prompt:
"Montage, multi-shot action Hollywood movie, don't use one camera angle or single cut, cinematic lighting, photorealistic, 35mm film quality, professional color grading, sharp focus, high detail texture, film grain, depth of field mastery, ARRI ALEXA aesthetic"
Then: one paragraph of setup (characters, location, full arc) + numbered shots.

## 2. Transformation (highest-performing Seedance format)
Arc: calm → threat → transformation → aftermath. 6 shots / 15 s. Inputs: images of character, vehicle/prop, location, enemy.
Original (abridged "Burger"): "A pink-haired girl with glasses… sits on the hood of a white pickup truck under a concrete overpass at dusk, casually eating a burger… A pale zombie… sprints toward her… The girl calmly sets down the burger, her body erupts into a massive pale tusked creature… devours the zombie whole, then shrinks back to human form and picks up the burger. Handheld shake throughout, dark comedy pacing with horror undertones. Shot 1: … Shot 6: …"
```
[MONTAGE HEADER from #1]
[CHARACTER LOOK] [CALM ACTIVITY] in [LOCATION + TIME]. [THREAT] approaches. [CHARACTER] calmly [PAUSE ACTION], transforms into [FORM], [DEFEATS THREAT], then returns to normal and [RESUMES ACTIVITY]. Handheld shake throughout, [TONE] pacing.
Shot 1: Medium shot, [CALM BEAT], camera sways gently.
Shot 2: Wide shot, [THREAT APPEARS], camera shakes tracking it.
Shot 3: Close-up, [CHARACTER NOTICES — reaction: annoyance rather than fear].
Shot 4: Medium shot, [TRANSFORMATION with body detail], camera jolts with each beat.
Shot 5: Wide low-angle, [DEFEAT], camera shudders on impact.
Shot 6: Medium shot, [RETURN TO NORMAL + resume activity as if nothing happened].
```
Brand twist: the product triggers the transformation (energy drink, sneakers, phone).
Tips: "no 3D, no cartoon, no VFX" for realism; "add a visual gag in the background" for comedy.

## 3. First-person POV power shot ("Orbs")
Original camera block (reuse verbatim):
"Single continuous shot, first-person POV perspective, the camera IS her eyes, hyper-chaotic handheld motion, completely unstabilized, violent raw human movement, constant micro-jitters, aggressive head swings, abrupt jerks, frequent over-rotation and harsh correction, moments of near motion blur loss, no smoothness at all, no stabilization, wide-angle lens (strong distortion), subtle chromatic aberration near frame edges, 15 seconds, her hands always visible in frame, no music only raw SFX, cinematic lighting, photorealistic, grounded realism, strong 35mm film look, heavy film grain, sharp but imperfect focus, noticeable focus breathing, motion blur on fast actions, halation on highlights, soft highlight rolloff, slightly desaturated tones, ARRI ALEXA aesthetic, practical VFX feel, minimal CGI look, natural imperfections"
Then:
```
Location: [DETAILED ENVIRONMENT].
Action: [HAND ACTION gaining POWER] [VFX: (what the power looks like on the body)]. Enemies emerge — [ENEMY DESIGN]. First strike, [..]. Second attack, [..]. [BOSS] rises — [..]. [CLIMB/REACH CORE] — RAMPS TO SLOW MOTION as [..] — SNAPS BACK — [AFTERMATH, hands visible at frame edges].
SFX: [comma list of 10–15 sounds in order].
```
Simpler POV (original Colosseum): "One continuous shot, POV [ROLE] perspective in [PLACE], no cuts, no zoom, natural head movement, [ENEMY] sprints straight toward the camera… immediate chaos erupts all around… camera shaking from impacts, breath sounds, dust in the air…" Key rule: say what the camera is NOT doing.

## 4. Choreographed fight (single shot or multi-shot)
Need: clear location, clear power mismatch, beat-by-beat choreography.
Multi-shot template (from the Cinema Studio hotel corridor fight):
```
Use Image 1 as a reference for the character's appearance, and Image 2 as reference for the location.
Multi-shot editing, [LOCATION] fight sequence.
[LENS, e.g. Telephoto]. [ESTABLISHING: hero look + opponents + set details].
[CAMERA, e.g. Handheld tracking]. [BEAT 1 with a set-piece consequence, e.g. a frame shatters].
[CAMERA]. [BEAT 2].  [CAMERA]. [BEAT 3].  [CAMERA]. [BEAT 4].  [CAMERA]. [FINAL OPPONENT BEAT].
Throughout the fight, [WARDROBE CONTINUITY: mostly intact, tie slightly crooked, faint sweat].
Static camera. [CALM EXIT BEAT]. Freeze frame the moment before [NEXT STORY BEAT].
```
Continuation without new keyframe: `Multi-shot cinematic scene, continuing @video1. [NEW LOCATION]. [Shot-by-shot with dialogue lines "Man: …" "Woman: …"].`
Speed-ramp style tag: "harsh single-source overhead light, warm amber on skin with cool steel-blue environment, anamorphic 35mm, shallow depth of field, Guy Ritchie speed-ramping with Snyder impact slow-motion".

## 5. Full structured cinematic scene with dialogue (Help Center cowboy format)
Block order to copy: Style · Cinematography · Lighting · Color (60/30/10 split) · Camera (body, lenses, T-stop, rig, fps) · Skin (anti-plastic) · Acting · Physics · Composition (full-bleed, no letterbox) · Continuity · Editing (N shots in X s, hard cuts) · Technical · Audio (original score, diegetic bed) · Dialogue with timestamps · Character description · Location · Hero prop · Mood and tempo.
Dialogue format (original): `COWBOY, around 2.4 to 4.0 seconds: "Somebody took my horse."`
```
Style: Live-action photographic realism, [GENRE + TONE], [ONE-SENTENCE STORY]. NOT CGI-looking, NOT plastic, NOT a commercial.
Cinematography: [coverage], LENS DISCIPLINE: spherical rectilinear, [35mm room, 75mm faces], NO fisheye.
Lighting: [motivated sources]. NOT bright, NOT flat.
Color: [60% X, 30% Y, 10% accent]. Filmic grade, fine grain. NOT teal-orange.
Camera: cinema-grade digital, [lenses, T2.0–2.8], [dolly/Steadicam/sticks], 24fps.
Skin: anti-plastic, pore-level realism, NOT waxy.
Acting: [beat-by-beat performance].
Physics: [honest physical details].
Composition: full-frame [16:9], NO letterbox.
Continuity: one [location], wardrobe consistent, clean hard cuts only.
Editing: [N] shots in [X] seconds, cut to [score feel].
Audio: original instrumental score, NOT mimicking any artist. Diegetic: [..].
[CHARACTER], around [t1] to [t2] seconds: "[LINE]"
Character description: [..]. Location: [..]. Hero prop: [..]. Mood and tempo: [..].
```

## 6. Text-to-video spectacle, no references (Cinema Studio)
Original: "A demolition crew detonates a skyscraper in a dense city at dawn. The building folds inward floor by floor in a cascade of glass and concrete dust, debris clouds billow outward in slow motion, pigeons scatter across the orange sky. Shot from street level on a handheld camera behind a safety barrier, crowd reactions visible in foreground. Realistic shockwave dust rolling toward camera."
```
[EVENT] in [PLACE] at [TIME]. [HOW IT UNFOLDS, physical detail]. [SECONDARY LIFE DETAIL]. Shot from [CAMERA POSITION] on a [CAMERA TYPE] [behind/near X], [FOREGROUND HUMAN ELEMENT]. Realistic [PHYSICS DETAIL] rolling toward camera.
```

## 7. Multi-character dialogue scene (elements only)
Original: "3 men sitting in foldable chairs against a sun-scorched concrete wall @image_1… Sweat on his @image_3 forehead… he says casually: "Man, it's burnin' up out here, huh?". Then close up of a @image_2 as he says: "I know, right?"…"
```
[N] people [ACTIVITY] in [PLACE] @image_[LOC]. [ATMOSPHERE]. [DETAIL on @image_A], says: "[LINE]". Then close up of @image_B as [he/she] says: "[LINE]". Then a wide shot, @image_C says: "[LINE]" and then [CUTAWAY GAG].
```

## 8. Motion transfer / background swap
Original: "In @video change location to @image_1. Horror film, man running from something scary."
Template: `In @video change location to @image_1. [GENRE], [WHAT THE PERSON IS DOING].` (Genjutsu / AI Influencer: swap outfit, product or location; motion and camera stay.)

## 9. Logo animation (Cinema Studio / Seedance)
Version 1 (original): "Design a logo animation for @Image1. Specific requirements: The logo's appearance from nothing must be creative and well-designed, employing techniques such as particle aggregation, brushstrokes, light sweeping, and geometric decomposition and recombination. The logo's appearance should feature smooth, undulating curves and elastic animation effects, with a strong overall rhythm and professional commercial advertising standards. Light effects sweeping across the logo's surface should create highlights and a metallic texture. The background should be clean and simple, highlighting the logo itself. The color scheme should be completely consistent with the original logo in @Image1. At the end of the animation, the logo should remain stable in the center of the screen with a slight breathing-like looping motion effect."
Version 2 Liquid Glass (key lines): "highly transparent liquid glass texture, featuring realistic refraction, transmission, and reflection… flowing liquid light and subtle air bubbles… edges display glass dispersion… emerge from nothing… liquid glass floats and flows in midair, then gradually solidifies into the final logo shape… camera switches angles… 360-degree orbital rotations… caustic effects… background clean and dark… subtle breathing-like liquid motion loop."
Tweak: swap the material (gold, kente-woven threads, chocolate, smoke) and keep "color scheme consistent with @Image1" and the stable end hold.

## 10. Short cinematic prompts that work (Seedance 2.5 page)
- "Handheld medium close-up at golden hour. A young woman with long pastel-pink hair and thin rectangular glasses glances back over her shoulder at the camera, soft smile. Old Shanghai street corner behind her: red brick facades, Chinese signage, zebra crossings, warm backlight, shallow depth of field, filmic vlog look."
  Template: `Handheld [SHOT SIZE] at [TIME]. [SUBJECT LOOK] [SMALL ACTION] at the camera, [EXPRESSION]. [CITY] street corner behind [him/her]: [3–4 LOCAL DETAILS], [LIGHT], shallow depth of field, filmic vlog look.`
- "Wide symmetrical shot. A dancer with bleach-blond hair and futuristic sunglasses stands center frame, arms spread wide, mouth open mid-shout… Behind him a trapezoid portal of horizontal white light panels, everything else pitch black. Pale blue reflective floor, high contrast, clean studio look." (music video / campaign key art)
- Seedance tip: "Write the prompt like a shot list: subject, camera, lighting, mood, sound. Add references for anything that must stay consistent, and fix mistakes with region edits instead of re-rolling."

## 11. Opening shot with audio block (Cinematic ad stage)
Original pattern: `[VISUAL] …` paragraph then `[AUDIO] NO MUSIC. SFX ONLY — …`. Use `<<<image_1>>>` for character, `<<<image_2>>>` for location.
```
[VISUAL] [CAMERA STYLE + HEIGHT] on [LOCATION <<<image_2>>>]. [ANGLE, e.g. Dutch 15° right]. [LIGHT + ATMOSPHERE]. [CHARACTER <<<image_1>>> in OUTFIT] [ACTION toward camera]. Camera [MOVEMENT DETAILS], then [TILT/REVEAL] to [CLOSE-UP + micro-acting]. [LENS], [FLARE].
[AUDIO] [NO MUSIC / MUSIC STYLE]. SFX ONLY — [ambient list].
```
