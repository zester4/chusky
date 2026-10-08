# Fashion & Lifestyle Prompts

Sources: Soul page examples, "How to Generate Fashion and Aesthetic AI Photos That Stay On-Brand" blog, Sora 2 Prompt Guide, Help Center prompt guide, Academy "Brand Visuals" course (higgsfield.ai).

Best models: Soul 2.0 (fashion-aware, presets), Soul Cinema (film-still look), Nano Banana Pro (outfit/identity swaps with references), Seedance/Sora for fashion reels.

## Brand lock: do this before a fashion campaign

Higgsfield's "four anchors" for on-brand fashion:
1. Style anchor — Moodboard: 20+ photos in one cohesive style, no faces.
2. Color anchor — Soul HEX: palette from a brand reference (built-ins: Film Colors, Lime Jam, Candy Pink, Nostalgic Blue, Soft Palette, Black Gloss). Color Transfer copies the hero image grade to the rest of the set.
3. Identity anchor — Soul ID: 20+ photos of the model, multiple angles.
4. Look anchor — one preset per series. Soul 2.0 presets: Warm Ambient, Retro BW, Y2K Street, Subtle Flash, Y2K Studio, Street Photography, Theatrical Light, Asian Nostalgia, Editorial Street Style, Surreal Solarization, Flash Editorial, Digital Camera, Siren, Swag Era, Mystique City, Balletcore, Candy Pop, 2000s Band, Frutiger Aero, Drain, Old Smartphone.

Campaign flow: hero shot at 2k (3:4 or 2:3 editorial, 9:16 social) → approve → variations at 1.5k, 4 at a time, change ONE element per pass (lighting, then composition, then styling) → Color Transfer → QC same face, grade, register.
Rule: text directs the image (era, mood, simple clothing, location type); references lock what must not drift (exact garment, logo, face, color).

---

## 1. Candid iPhone street-style shot (Soul)
Use for: brand Instagram, "real" lifestyle feel, streetwear.
Original (Soul example): "A spontaneously captured iPhone-styled candid photo of a young woman with platinum hair casually lounging against a textured, slightly weathered Parisian stone wall… ivory silk blouse from COS… sleek black leather pants by Our Legacy… white Converse sneakers gently scuffed…"

Template:
```
A spontaneously captured iPhone-styled candid photo of [MODEL: age, skin tone, hair] casually [POSE, e.g. lounging against] a [TEXTURED BACKGROUND, e.g. weathered stone wall] on a [LOCATION, e.g. busy Accra sidewalk]. [He/She] wears [TOP: fabric + color + fit, e.g. an ivory silk blouse with soft draping and subtle fabric wrinkles] paired with [BOTTOM] by [BRAND_NAME], complemented by [SHOES, with realistic wear]. [ACCESSORY, e.g. minimal black headphones]. In one hand [PROP, e.g. a translucent iced coffee with realistic condensation]. Hair [STYLE], strands catching soft natural daylight that illuminates neutral makeup and natural skin texture, faint freckles and fine pores. Surrounding [him/her] are authentic urban details [DETAILS]. Casual slightly tilted framing, authentic iPhone photography, [ASPECT RATIO, e.g. 3:4].
```
How to tweak: naming the real fabric, wear marks and skin texture is what removes the "AI sheen". Swap the city and props for the user's market. Put the user's brand on one garment only.

## 2. Y2K / early-2000s flash snapshot (Soul, preset Y2K Studio or Subtle Flash)
Original: "Caught in the cracked reflection of an old bedroom mirror, the freckled redhead girl leans in close, carefully applying a glossy lip gloss that gleams under the soft direct flash. Her velour pink tracksuit top is sprinkled with subtle rhinestone details… The photo quality suggests a slightly grainy or low-resolution digital look… signature soft CCD camera grain… —casual candid early-2000s Y2K snapshot, grainy low-res softness"

Template:
```
Caught in [FRAMING DEVICE, e.g. the cracked reflection of an old bedroom mirror], [MODEL] leans in close, [ACTION, e.g. applying glossy lip gloss] under soft direct flash. [GARMENT 1 with texture details], [GARMENT 2], [JEWELRY], [HAIR ACCESSORIES]. [BOTTOMS + BELT visible at the edge of the frame]. Slightly grainy low-resolution digital look, candid moment, flash bounce with warm tungsten glow and soft CCD camera grain. Cropped frame, slightly tilted angle, authentic early-2000s snapshot. —casual candid early-2000s Y2K snapshot, grainy low-res softness
```
How to tweak: keep the closing "—style tag"; Soul reads it as the aesthetic register. Change era by swapping the camera language (e.g. "harsh direct flash of early-2000s digital camera, digital noise, slight over-sharpening").

## 3. Resort / luxury summer menswear (Soul)
Original: "Wide shot taken from about 10 meters away showing a stylish Latina man sitting on sun-warmed, smooth whitewashed stones at the edge of the crystalline Mediterranean sea. He wears tailored swim shorts in a striking dusty lavender with a subtle abstract wavy stripe motif… —hyper-real texture fidelity, natural skin"

Template:
```
Wide shot taken from about [DISTANCE, e.g. 10 meters] away showing a stylish [MODEL] sitting on [SURFACE] at the edge of [LOCATION]. [He/She] wears [HERO GARMENT: cut + color + pattern + fabric] and a [LAYER, e.g. loosely draped unbuttoned linen shirt, sleeves rolled]. [HEADWEAR], [EYEWEAR]. [POSE]. One hand resting on [BRAND PRODUCT, e.g. a handwoven tote with terracotta and sky-blue embroidery]. Nearby, [SET PROP]. Soft clear daylight, [ENVIRONMENT REFLECTIONS]. Candid three-quarter iPhone angle capturing tactile textures — [TEXTURE LIST]. Serene, quietly stylish atmosphere of [MOOD]. —hyper-real texture fidelity, natural skin
```

## 4. Technical outdoor / gorpcore product-on-model (Soul)
Original: "A naturally posed side profile of an individual standing relaxed in front of a textured rugged rock wall within a mountainous terrain. The person wears a matte black technical waterproof hardshell jacket with an oversized hood fully raised… taped seams and waterproof zippers… orange-tinted wraparound goggles…"

Template:
```
A naturally posed [ANGLE, e.g. side profile] of [MODEL] standing relaxed in front of [BACKDROP] in [TERRAIN]. [He/She] wears a [JACKET: color, material, hood, construction details like taped seams, cinch cords], [PANTS], [FOOTWEAR]. [EYEWEAR reflecting the landscape], partially obscuring the face. Soft diffused indirect daylight emphasizing the texture of [FABRIC] and [BACKGROUND SURFACE]. Casual spontaneous framing, slightly tilted, authentic candid iPhone aesthetic. Hyper-realistic, cinematic, [VIBE, e.g. calm tactical futuristic outdoor].
```
How to tweak: for the user's own garment, upload it as a reference and write "the jacket from @image_1" instead of describing it.

## 5. Overhead graphic editorial (Soul / Nano Banana)
Original: "A high-resolution, vertically framed photo captured from directly above a wide escalator, showing a fashion model standing mid-step in a clean, graphic grid of metallic escalator steps… Shot with a 85mm lens… cropped varsity jacket paired with a crisp white pleated mini skirt… bold red platform sneakers… Heart-shaped sunglasses…"

Template:
```
A high-resolution vertically framed photo captured from directly above [GRAPHIC LOCATION, e.g. a wide escalator / zebra crossing / tiled pool], showing a fashion model [ACTION] within a clean graphic grid of [PATTERN]. Shot with an 85mm lens, natural compression, full body head to toe, top-down symmetrical composition. The model wears [OUTFIT], styled with [STATEMENT ITEM in a color that pops against the neutral grid]. [ACCESSORY]. Relaxed playful posture, gaze [DIRECTION]. [ASPECT RATIO 9:16 or 2:3].
```

## 6. Studio fashion portrait with bold styling (Soul)
Original: "He's framed in a medium close-up against a matte electric blue studio backdrop, standing with squared shoulders and arms crossed… oversized black varsity jacket with silver leather sleeves… bubblegum pink mesh tank… cherry red hair spiked high…"

Template:
```
[He/She] is framed in a medium close-up against a matte [BACKDROP COLOR] studio backdrop, [POSE AND ATTITUDE]. Wearing [OUTER LAYER with material + lettering], [INNER LAYER], [BOTTOMS + BELT]. Hair [COLOR + STYLE]. [EYEWEAR / JEWELRY]. Gaze [EXPRESSION]. Even studio lighting, crisp fabric texture, editorial fashion portrait.
```

## 7. Neutral character base → outfit swap → scene (Help Center 3-step)
Step 1 base:
```
Photorealistic full-body studio portrait of [CHARACTER: age, build, hair, skin details, expression], standing straight facing the camera, arms relaxed. Wearing [BASIC OUTFIT]. Clean seamless white studio background, soft even lighting, sharp detail, visible skin pores, shot on medium format camera. Full body visible head to toe, centered composition.
```
Step 2 outfit swap (attach base image):
```
Keep the exact same [man/woman], same face, same pose, same white studio background and lighting. Change only [his/her] outfit: [NEW OUTFIT, piece by piece: headwear, outerwear, top, accessories, gloves, bottoms, footwear]. [PROP IN HANDS]. [EXPRESSION].
```
Step 3 place in scene:
```
Place this exact [CHARACTER] inside [LOCATION]. Cinematic [SHOT SIZE] of [FOCUS AREA]: [TEXTURE DETAILS]. [LIGHT SOURCE + DIRECTION], blurred [BACKGROUND DETAILS], warm glowing bokeh, hazy air. Moody cinematic color grading, shallow depth of field, film grain, anamorphic look.
```
How to tweak: "keep the exact same…" is the identity lock; never drop it. Use this chain for lookbooks: one base model, one swap per outfit.

## 8. Website product-on-model studio shot (Nano Banana Pro)
Original prompt (Academy): "professional studio picture, model wearing all clothes, monochromatic background, side profile view"
Template:
```
Professional studio picture, model wearing all clothes from the references, [BACKGROUND COLOR] monochromatic background, [VIEW: side profile / front / rear view showing the back logo].
```
How to tweak: upload each garment separately as its own reference. To swap in a brand ambassador: "Change the person in image one into the person in image two, keep the outfit, pose and lighting."

## 9. Cinematic fashion editorial reel (Sora 2 / Seedance, video)
Short version (Sora guide): "Create an editorial lookbook reel: three beats—walk-by past string lights → slip jacket off one shoulder → sling jacket over shoulder and lean to wall; transitions: match cuts on motion;"

Long template (from the Sora 2 guide fashion reel):
```
Format & Style: Cinematic fashion editorial reel – fast-paced studio shoot with multi-angle cutting and flash-synced transitions. Glossy, modern, editorial-meets-film energy. [DURATION]s, [ASPECT RATIO].
Camera: Full-frame cinema camera intercut with handheld BTS cam. Dolly tracking, whip-pans, static tripod bursts, fast focus pulls between poses.
Lens: alternating 35mm (wide tracking) and 85mm (close-ups), shallow DOF.
Main Subject: [MODEL], bold cinematic presence, alternating slow elegance and high-intensity pose transitions.
Wardrobe & Props: [BRAND_NAME] look — [GARMENT LIST]. Props: [studio stool, standing mirror, handheld fan, scattered Polaroids].
Location: minimal studio, [CYC WALL COLOR] cyc wall, two visible strobe umbrellas, faint crew silhouettes.
Lighting & Palette: strobe bursts + LED fill, tungsten side spill. Color anchors: [BRAND COLORS].
Actions & Camera Beats:
 0–2s — wide dolly-in, model walks toward light flare, hair caught by fan. Flash → cut.
 2–4s — medium, sharp turn, hands on hips, whip-pan, flash mid-spin.
 4–6s — macro on [DETAIL: earring / logo / stitching] under strobe flicker.
 6–8s — BTS insert, photographer crouching, model mid-turn.
 8–10s — full-body power pose, fan lifts fabric, circular arc, slow-motion flash bloom.
 10–12s — extreme close-up, camera rises from collar to eyes, final flash freeze.
Dialogue: photographer off-screen: "Yes—hold that! Turn! Beautiful—chin up!"
Sound & Foley: flash pops and shutter clicks synced to cuts, fan whoosh, fabric ripple, low synth pulse at 120 BPM, no melody.
Finish: fine grain, halation on strobes, [GRADE].
```

## 10. Virtual try-on / outfit-appears video (Marketing Studio, Pro Virtual Try-On)
Use the "Skate-through try-on" template in `ugc-and-ads.md` (clothes float in the air and appear on the model as he passes through them).

## More original Soul lifestyle prompts (use as tone references)
- "A bright iPhone photo taken in golden hour glow. A woman with loose waves and a cotton robe sits diagonally on the bed, a book open beside her. On the duvet lies a wooden tray with a petite bowl of yogurt, granola, and sliced mango arranged like a flower… Feels like a moment stolen from a wellness magazine spread."
- "A glamorous shot of a woman in an outdoor café, wearing a camel coat and oversized sunglasses. Her red lipstick pops against her fair skin. She's holding a cappuccino, natural golden hour lighting."
- "A girl in a business suit stands at a café counter, one hand inside her large black tote bag, searching for her card. Minimalist setting, neutral tones, and overhead lighting. iPhone perspective."
- "A tattooed man in baggy jeans and no shirt walks barefoot along a rocky riverbank, jeans soaked at the bottom… The colors are muted, skin slightly desaturated in the iPhone camera. Everything feels cool, slow, peaceful — no staging."
- "A bird's-eye view of a wooden slatted tea tray. Centered: a shallow white porcelain teacup with golden Darjeeling tea… Calm morning setting, subtle reflections in the tea, quiet contemplative energy." (works for food/beverage brands)
Pattern to copy: short prompts still work when they name one product, one light condition and one camera ("iPhone perspective").
