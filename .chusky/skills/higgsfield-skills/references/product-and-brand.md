# Product, Brand Identity & Graphic Prompts

Sources: Academy "Brand Visuals with AI" (Inventing the Brand, Creating the Products), "How to Make AI Product Photos Without a Studio", Nano Banana Pro Full Prompt Bank, Marketing Studio CUE app guide, Cinematic Ad Academy stage 1 (higgsfield.ai).

Best models: Soul Cinema (logos, mockups in batches of 4), Nano Banana Pro (edit/replace logo with a reference image, variations), GPT Image 2 (packaging, UI, text), Marketing Studio (product-shot presets + Recreate).

Higgsfield workflow tip: ask an LLM to expand a one-line brief into the detailed prompt, generate a batch, then fix small issues with a follow-up EDIT prompt on the chosen image instead of regenerating.

## Product photo set (Marketing Studio)
Source photo rules: uncluttered background, even light, product fills most of the frame, packaging text readable. Add multiple angles + packaging, name and short description in the Product slot.
Product shot formats: Closeup, Faceless, Full body, Editorial, UGC, Studio white, Color pop, Natural, Usage. Minimum set: Studio white (hero) + Closeup with avatar + Usage/Faceless + Full body. Then Marketplace covers (white hero first).
Recreate prompt (edit field), template:
```
Replace the product with mine from @image_1, keep the template's layout, lighting and style. [ONE CHANGE, e.g. make the background warm terracotta / add a hand holding it / place it on a wooden market table].
```
Always check shape, color, logo and label text against the real product.

---

## 1. Logo (Soul Cinema, then Nano Banana Pro)
Brief to expand: "Give me a prompt for a logo for a fashion brand called HIGGS. Accent color #d1fe17. Flat vector, minimal."
Original output (abridged): "Fashion brand logo for "HIGGS" clothing label. Two-part vertical composition: icon on top, wordmark below… Rendered in #d1fe17 acid yellow on black. WORDMARK (bottom): "higgs" in lowercase… Flat vector. No gradients. No shadows. No extra elements. Ultra-clean, suitable for embroidery and labels."

Template:
```
[INDUSTRY] brand logo for "[BRAND_NAME]" [PRODUCT CATEGORY] label. Two-part vertical composition: icon on top, wordmark below.
ICON (top): [CONCEPT — a symbol tied to the brand story, reduced to a clean geometric glyph]. Rendered in [HEX_ACCENT] on [BACKGROUND COLOR].
WORDMARK (bottom): "[brand name]" in [lowercase/uppercase], centered beneath the icon. [TYPE STYLE, e.g. razor-thin extended sans / sharp condensed / elegant display serif]. Color: [white or HEX_ACCENT].
Layout: icon and wordmark stacked vertically, centered, clear breathing room.
Aesthetic: [CONCEPT A] meets [CONCEPT B]. Flat vector. No gradients. No shadows. No extra elements. Ultra-clean, suitable for embroidery and labels.
Style: logo design, brand identity, flat vector, minimal, two-part stacked logo
```
How to tweak: keep it memorable, not clever (think three stripes, a checkmark). Generate 4, pick one.

Logo fix (Nano Banana Pro, attach the logo):
```
Recreate this logo exactly — same [MARK DESCRIPTION], same background, same composition and proportions — but change only the "[wordmark]": [CHANGE, e.g. make it bolder (heavy weight, thicker strokes) and tilt it 3–5 degrees clockwise]. Keep the same font family, color, size and position.
```
Logo variations sheet:
```
Use the provided logo to generate a clean visual mini-guide.
1. A monogram version of the logo (simplified, minimal, recognizable).
2. A standalone symbol/icon derived from the logo.
3. A third creative variation based on the same identity [e.g. horizontal lockup].
(6 total outputs: 3 on white, 3 on black)
- Clean layout, like a compact brand sheet
```

## 2. Apparel flat-lay mockup — jersey / tee (Soul Cinema)
Original (abridged): "Flat lay product mockup of an oversized short-sleeve soccer football jersey, ghost mannequin style, isolated on pure white background #FFFFFF, sharp studio lighting… 100% polyester performance mesh… Large black raglan-style panel covering both shoulders… Single word "AXIS"… BACK: completely clean… Technical: flat lay top-down symmetrical view, ghost mannequin, ultra high resolution…"

Template:
```
Flat lay product mockup of [GARMENT TYPE + FIT], ghost mannequin style, isolated on pure white background #FFFFFF, sharp studio lighting.
FABRIC: - [MATERIAL] — visible [TEXTURE] - [FINISH/STRUCTURE]
FIT: - [FIT DETAILS, e.g. oversized boxy, dropped shoulders]
COLLAR/NECK: - [DETAILS]
PANELS & COLORWAY: - [PANEL 1: color + position] - [PANEL 2] - [STRIPES/PIPING with exact count, e.g. "one stripe only, not three"]
FRONT BRANDING: - "[TEXT]" only — [FONT STYLE], [COLOR], approx [SIZE]
BACK: [completely clean / number / logo]
Technical: flat lay top-down symmetrical view, ghost mannequin, ultra high resolution, isolated on #FFFFFF, photorealistic [FABRIC] texture, apparel product photography
```
How to tweak: state counts and "only" explicitly. Generate with a placeholder wordmark, then swap in the real logo with Nano Banana Pro ("replace the chest text with the logo from @image_2, smaller").

## 3. Outerwear front + back sheet (Soul Cinema)
Original (abridged): "Two views of a full bomber jacket product shot side by side, front view on the left and back view on the right, both entirely visible from top to bottom, nothing cropped… bold lime yellow-green (#d1fe17) and deep black colorway… Ghost mannequin style, pure white studio background, no shadows, no gradients, no clipping, no cropping…"

Template:
```
Two views of a full [GARMENT] product shot side by side, front view on the left and back view on the right, both entirely visible from top to bottom, nothing cropped, floating centered on a pure white background. [DESIGN STYLE], [GARMENT] in [COLOR 1 (HEX)] and [COLOR 2], color-blocked panels with sharp clean edges. [POCKETS / CLOSURES]. [HOOD / COLLAR]. Front view: [LOGO: style, text "[BRAND]", position]. Back view: [BACK DESIGN]. [MATERIAL + TEXTURE], [VIBE]. Ghost mannequin style, pure white studio background, no shadows, no gradients, no clipping, no cropping, both garments visible collar to hem, 8K detail, sharp fabric texture, product catalog style, flat lay apparel reference sheet.
```

## 4. Footwear 4-view reference sheet (Soul Cinema / GPT Image 2)
Original (abridged): "Technical footwear reference sheet showing ONE original trail sneaker in 4 views, 2x2 grid, pure white background #FFFFFF… TOP LEFT — LATERAL SIDE… TOP RIGHT — OVERHEAD… BOTTOM LEFT — HEEL REAR… BOTTOM RIGHT — OUTSOLE… Pure white background, NO text, NO callouts, NO labels"

Template:
```
Technical footwear reference sheet showing ONE original [SHOE TYPE] in 4 views, 2x2 grid, pure white background #FFFFFF, sharp studio lighting, photorealistic textures. Fully original design.
LOGO: [SHAPE] — 1. [POSITION A: size, finish] 2. [POSITION B: e.g. molded in outsole heel, HEX color]
UPPER: - [MATERIALS + OVERLAYS] - [FINISH, e.g. glossy lacquered with sharp specular highlights]
DETAILS: toe cap [..], heel counter [..], pull tab [..], lacing [..], laces [HEX]
MIDSOLE: [LAYERS + COLOR STRIPE]   OUTSOLE: [LUG PATTERN, color]
COLORWAY: [FULL COLORWAY]
TOP LEFT — LATERAL SIDE: [..]  TOP RIGHT — OVERHEAD: [..]  BOTTOM LEFT — HEEL REAR: [..]  BOTTOM RIGHT — OUTSOLE: [..]
Pure white background, NO text, NO callouts, NO labels. [KEY FINISH] must be clearly visible.
```
Why: video models need every angle of a product to stay consistent across shots.

## 5. Pants / accessory mockups (Soul Cinema)
Pants template:
```
Flat lay product mockup of [PANT STYLE], ghost mannequin style, isolated on pure white background #FFFFFF, sharp studio lighting. FABRIC: [..]. SILHOUETTE: [..]. WAISTBAND: [..]. DETAILS: single vertical piping stripe down outer seam, [HEX], [WIDTH]. LOGO ON [POSITION] (small, embroidered): [SYMBOL ONLY — NO letters]. Colors: [BASE] base, [HEX] accents only. Technical: flat lay top-down symmetrical view, ghost mannequin, full length, ultra high resolution, photorealistic [FABRIC] texture, apparel product photography.
```
Eyewear/accessory campaign template (original: "Rectangular sport sunglasses, single pair, matte black to chartreuse-yellow (#D1EF17) gradient frame… floating on pure black backdrop, dramatic moody rim lighting… luxury eyewear campaign photography"):
```
[PRODUCT SHAPE + TYPE], single [unit], [FINISH + COLOR/GRADIENT with HEX]. [KEY PARTS]. [SILHOUETTE]. [ACCENT DETAIL]. [No logos / logo at POSITION]. Single [unit], [ANGLE, e.g. front three-quarter], floating on [BACKDROP], dramatic moody rim lighting catching [FEATURE], luxury [CATEGORY] campaign photography, editorial style.
```

## 6. Hero product still on grey (Soul Cinema / GPT Image 2)
Original: "A polished chrome football ball with embossed pentagons and hexagons sits perfectly centered on a uniform gray background… Sharp specular highlights… crisp reflections outlining every panel seam."
```
[PRODUCT with material + finish] sits perfectly centered on a uniform [COLOR] background. [SURFACE DETAIL 1] while [SURFACE DETAIL 2], creating a two-tone contrast. Sharp specular highlights reflect the studio lighting, crisp reflections outlining every [SEAM/EDGE]. [16:9 / 1:1], no characters, no text.
```
Packaging sheet (GPT Image 2, attach one product photo): `Turn this [can/jar/box] into one product sheet: front, back and top views, same label, same colors, clean white background, every label text legible.`

## 7. App UI / landing page (GPT Image 2 — renders text accurately)
Original (abridged): "Modern dark minimal landing page for "CUE" — AI-powered recipe generator. Style: premium, minimal, dark green aesthetic, clean SaaS, Apple-level design… Placeholder: "Type ingredients or upload a photo..." … Large transparent ice cube floating in space… modern sans-serif typography (Inter / SF Pro). Mood: calm, premium, slightly futuristic…"
```
Modern [THEME] landing page for "[APP_NAME]" — [ONE-LINE WHAT IT DOES].
Style: premium, minimal, [COLOR] aesthetic, clean SaaS, Apple-level design.
Header: logo "[APP_NAME]", nav [ITEMS]. Headline: "[HEADLINE]". Subheadline: "[SUB]". Input placeholder: "[PLACEHOLDER]". Button: "[CTA]".
Hero visual: [VISUAL METAPHOR + material details].
Small example text: "[EXAMPLE]". Typography: modern sans-serif (Inter / SF Pro).
Mood: [MOOD].
```
Follow-up screens: `@image_1 — visual style and design system reference for [APP_NAME]. Same design system as @image_1. [SCREEN NAME] — [ELEMENTS]. Keep the same aesthetic.` Mobile: drag the desktop image in, set 9:16, no new prompt needed.

## 8. Full brand identity system board (Nano Banana Pro, "logical layout anchors")
Original opening: "Create a full, multi-dimensional brand identity system for "Higgsfield AI"… LOGO SYSTEM… COLOR PALETTE… TYPOGRAPHY… GRAPHIC LANGUAGE… BRAND PERSONALITY… MOTION DESIGN… APPLICATIONS… MATERIALS & LIGHTING… BRAND MYTHOLOGY…"
```
Create a full, multi-dimensional brand identity system for "[BRAND_NAME]," [WHAT THE BRAND IS]. Base all visuals around [LOGO DESCRIPTION]. The identity must feel [3–5 ADJECTIVES].
LOGO SYSTEM: [core symbol meaning]. Wordmark: "[BRAND_NAME]" in [TYPE]. Variants: icon + wordmark, stacked, icon-only, white version, outline version. Rules: [e.g. never warp, min padding].
COLOR PALETTE: Core: [NAME HEX], [NAME HEX], [NAME HEX]. Supporting: [..]. Meaning: [color = value].
TYPOGRAPHY: Headlines [..]; body [..]; UI [..].
GRAPHIC LANGUAGE: [patterns derived from the logo].
BRAND PERSONALITY: [traits]. Voice: [..]. Sample lines: "[TAGLINE 1]," "[TAGLINE 2]."
APPLICATIONS: website hero [..]; app icon [..]; social templates [..]; merch [..]; packaging [..]; posters [..].
MATERIALS & LIGHTING: [..].
BRAND MYTHOLOGY: [the story behind the symbol].
```
How to tweak: section headers in CAPS act as layout regions; keep them.

## 9. Posters, infographics & ad layouts (Nano Banana Pro / GPT Image 2)
Short originals (NB Pro guide): "Retro 80s cassette ad layout, grainy texture, floating player, bold title, bottom lineup, fictional branding".
Technical breakdown template (original F-117 prompt):
```
High-resolution infographic breakdown illustration of [PRODUCT]. Crisp detailed technical diagram style similar to Formula 1 car schematics. White handwritten-style arrows and labels pointing to all key components. Clean engineering aesthetic, like automotive blueprint annotations. Full object visible in dynamic perspective, sharp lighting, high clarity. Background clean and slightly blurred. Add multiple callouts with lines and text, e.g.: '[Component Name]', '[Function / Purpose]', '[Material Type]', '[Dimensions]', '[Performance Stats]'. Consistent white annotation lines, diagram boxes, arrows. Infographic title at the top in a clean modern font: '[PRODUCT] - Technical Breakdown.'
```
Multi-section poster: write "Top header: …", "Section 1 – … ", "Section 2 – …", "Bottom section: …" with exact text in quotes and a font style per item. Exact counts work ("seven cuts of steak… gradient of doneness from Blue Rare to Well Done").
Product-in-scene originals: "Ultra-detailed POV shot from inside a transparent container filled with crushed pink ice, looking upward at a young woman leaning over the opening. She sips through a bright blue straw… Hyperrealistic textures, high-contrast colors, cinematic saturation, crisp details, energetic and refreshing mood" — great for drinks: swap container, liquid, straw color.

## 10. 3D character / game card from a photo (Nano Banana Pro)
Original: "Generate the man from Image 1 as a 3D video game character with a weapon inspired by modern FPS games, on a screen after the match with an MVP badge over him. Stats: Accuracy, Kills, K/D ratio, Assists, Revives. He is wearing tactical gear standing in a confident pose."
```
Generate the [person] from Image 1 as a [STYLE, e.g. 3D video game character / collectible figure] [WITH PROP], on [SCREEN / PACKAGING CONTEXT] with [BADGE/TEXT "[TEXT]"]. Stats: [LIST]. [He/She] is wearing [OUTFIT] in a [POSE].
```
Good for brand mascots and fan engagement posts.
