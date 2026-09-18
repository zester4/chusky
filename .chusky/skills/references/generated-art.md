# Generated art (2D only)

The native Chusky media tools are the only generation entry points. Use
`CHUCK_GENERATE_IMAGE` or `CHUCK_GENERATE_VIDEO` when the request is a new
image or video; use code and Daytona when exact structure or local processing
is required. This file is the pipeline detail for those boundaries.

## Illustration

When the product needs illustration (heroes, empty states, textures, icons),
generate **2D** assets via `CHUCK_GENERATE_IMAGE` or `CHUCK_GENERATE_VIDEO` —
follow the **`imagine`** skill. Native results are delivered through the normal
channel; they are not automatically local Daytona files.
Image tools do **not** create 3D models; use geometry/glTF for interactive 3D
(`building-games`).

## Game art

- **Doctrine, not the pipeline:** for any game sprites, sheets, animations,
  tiles, or UI art, load **`game-asset-core`** plus the matching specialist —
  **`game-animation-frames`** (motion / loop laws), **`game-tilesets`**
  (seamless tiles / transitions), **`game-character-consistency`** (turnarounds
  / variants), **`game-ui-icons`** (HUD / buttons / icon sets). These cover
  engine-ready defaults, blind verify, and retry discipline — **not** a
  substitute for the pipeline skills below, and not a substitute for
  implementing the app.
- **2D sprites / animation sheets** (characters, walk cycles, attacks,
  projectiles, FX, props): run **`generate2dsprite`** — solid **`#FF00FF`**
  magenta sheets + local chroma postprocess scripts. That magenta key is
  **required** by the processor; do not invent a different "keyable" color on
  this path. Layer `game-asset-core` (+ `game-animation-frames` /
  `game-character-consistency`) for QC.
- **Exception — abstract/geometric games** (tetris, snake, pong, breakout, and
  the like) are correctly rendered procedurally. Generated sprite sheets there
  are a quality regression: do **not** invoke image generation for them even
  when gen tools are listed.
- **2D maps / levels / prop packs** (top-down RPG, side-scroller stages, layered
  maps, collision zones): follow **`generate2dmap`**. Default engine target is
  browser (`raw_canvas` / Phaser), not Godot/Unity. Tileable ground/walls → also
  `game-tilesets` for seamlessness checks.
- **Denser motion from video** (optional): **`video2dsprite`** — verified local
  video → ffmpeg → magenta chroma scripts. `CHUCK_GENERATE_VIDEO` is a separate
  asynchronous user-facing path and does not provide a local input file.

## Share card / app identity

A custom share card is the default: open the **`og`** skill and produce a custom
`public/og.jpg` from the app's own art before you finish.

- It covers games of **every** kind and rendering tech (a DOM tic-tac-toe is
  still a game), whimsical apps, creative tools, and brand-forward pages. Only
  plain utilities (converters, CRUD trackers, admin dashboards) keep the
  `og.chusky.me` placeholder, and the favicon alone never satisfies this.
- Custom art is `public/og.jpg` **and** `"card": "custom"` in
  `src/lib/og/site.json`. Bake infers custom from the file when the flag is
  missing, but `brand-check` still requires the field.
- Games also set `"type": "x:game"` (X presents the unfurl as a game card) and
  ship `public/x-banner.jpg` (50:11, 1200×264). `twitter:card=summary_large_image`
  is layout, not the game signal.
- Title defaults to the host slug; `src/lib/og/site.json` is only needed when
  the display name is not the slug, or the app is a game.
- The tags come from the PWA injector (`scripts/chusky-pwa-shared.mjs`), which
  overwrites anything in `__root.tsx`. Live preview emits the same tags (via
  `X-Forwarded-Host`), and identity is baked at `vite build` so published Nitro
  can inject without reading the workspace filesystem.
- Applies at build time, publish or not.
