# Custom card: generate `public/og.jpg`

For prompt-craft, composition, and blind read-back verification, follow the
`imagine` and `game-asset-core` skills — this file owns the **card-specific**
contract only (size, lockup, wiring).

1. **Build an exact 16:9 source in Daytona.** The native
   `CHUCK_GENERATE_IMAGE` accepts `{ prompt, destination?, workspacePath? }`.
   Use `destination: "daytona"` or `"both"` when the result is an input to the
   app workspace. The native tool does not expose an aspect-ratio argument, so
   create the exact layout in HTML/SVG or normalize the saved source in Daytona.
   Keep the title in the middle half of the frame and verify the raw dimensions
   before cropping.

   If the user only wants a visual concept, use `destination: "telegram"`.
   Do not claim the result is the app's `public/og.jpg` unless a real file is
   available in Daytona and passes the checks below.
2. **Bake the title in like a game cover.** Store-page covers (Stardew Valley,
   Cuphead) lead with a short stylized logo-type title. Put the exact app name
   in quotes in the prompt; 1–3 strong words; optional short tagline under the
   title in smaller lettering (exact words in quotes).
   - **Stack multi-word titles** into a two-line lockup ("SKY" over "STRIKE").
   - **Center the block both ways** with generous margins — avoid "upper third"
     / percentage placement (models hug the edge).
   - **Bound the width**: lettering spans roughly half to two-thirds of the
     frame, never border to border.
   - **Keep comfortable margins anyway.** Check the raw canvas dimensions
     before cropping and re-layout in Daytona if it is not close to 16:9.
3. **Verify glyphs *and* layout on read-back** (see `imagine` / `game-asset-core`
   for the blind-describe loop). On a garble or layout miss, **regenerate with a
   corrected prompt** — never try to move a logo with `Daytona deterministic image processing` (frame
   translation / seams). After two failed attempts, ship the card **artwork-only**
   (titleless).

   **Accuracy rule:** the title is exact application text, so prefer code-built
   typography in Daytona. If generated artwork is used as a visual background,
   keep the title as a separate code-drawn layer.
4. **Normalize to exactly 1200×630 JPEG** with the baked-in ffmpeg (cover-crop —
   from 16:9 this shaves ~3% top/bottom; from 2:1 ~2.4% per side and
   nothing vertical). **JPEG, not PNG**: the card is
   photographic generative art, and a PNG of it lands at 1–2 MB — heavy
   enough that link scrapers (X card previews included) time out or skip the
   image, so the card silently fails to unfurl. JPEG at this quality is
   ~150–300 KB with no visible loss at unfurl size:

   ```sh
   ffmpeg -y -i card-raw.jpg \
     -vf "scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630" \
     -q:v 4 /workspace/.chusky/og.jpg.tmp
   node scripts/write-atomic.mjs /workspace/.chusky/og.jpg.tmp public/og.jpg
   ```

5. **Tell the injector the card is custom** — set `"card": "custom"` in
   `src/lib/og/site.json`, handed over the same way, and keep `public/og.jpg`:

   ```sh
   node scripts/write-atomic.mjs /workspace/.chusky/site.json.tmp src/lib/og/site.json
   ```

   Bake also infers custom
   from the file if the flag is missing, but brand-check still requires the
   field. The injector emits the absolute `https://${host}/og.jpg` URL. Do not
   add `og:image` to `__root.tsx`.
6. **Verify before finishing** (Pillow is installed; `ffprobe` is **not**):

   ```sh
   python3 -c "
   from PIL import Image; import os
   im = Image.open('public/og.jpg')
   kb = os.path.getsize('public/og.jpg') // 1024
   print(im.size, f'{kb} KB')"
   # expect: (1200, 630) and under 600 KB (keeps X and other scrapers
   # reliable; target <= 300 KB — if over, bump -q:v up a step and re-encode)
   ```

   **Read back the final `public/og.jpg`, not the pre-crop raw** — the crop
   is where clipping happens. This is a **hard gate, not an impression**:
   if any title glyph touches a frame edge or is visibly cut, the card is
   **rejected** — do not ship it, whatever else is right about it. Fix the
   ratio (step 1) or regenerate with the width bound restated; a shipped
   decapitated title is worse than the placeholder. Then confirm the card
   reads like *this* app at thumbnail size — clear subject, correctly
   spelled title (if any), comfortable margins.
