---
name: game-scaffold
description: >
  First-stop skill when the user asks to make, scaffold, or prototype a browser
  game. Forces a playable skeleton fast: pick stack, copy a template, wire loop
  + input + score/fail, smoke-test. Then load building-games (and controls if
  movement) for depth. Triggers on game, platformer, snake, tetris, racing,
  fps, canvas game, three.js game, make a game, scaffold game.
---

# Game Scaffold

**Goal:** a **playable** browser game in one work slice — not a design essay.

This skill is the **on-ramp**. Deep craft lives in **`building-games`**. Input
signs for WASD/vehicles/flight live in **`controls`**. Assets in game-asset /
sprite / tileset skills. Co-op only via **`multiplayer-p2p`**.

## Non-negotiables (done bar)

A scaffold is **not done** until all are true:

1. Runnable (open HTML or app route loads without error)
2. Real game loop (`requestAnimationFrame` or engine tick)
3. Input does something visible
4. Score, timer, lives, or clear win/lose state
5. Start or restart path exists
6. You verified by running it (Daytona browser or local preview) — do not claim playable from prose alone

## Decision: which template

| Situation | Template |
|-----------|----------|
| Quick demo, no app context, one file | `templates/one-file-canvas/` |
| Inside this TanStack Start + React app | `templates/tanstack-2d/` |
| 3D / R3F / Three | After 2D shell works, load **building-games** + **threejs**; do not start from empty Three |
| 2–8 player co-op | Load **multiplayer-p2p** *after* single-player loop works |
| WASD / vehicle / flight | Load **controls** *before* writing movement |

Default: **single-player**. Bots optional. No half-built socket servers.

## Workflow

```text
1. Clarify genre in one line (snake / platformer / arena / …) if missing
2. Copy the matching template into the target path (Daytona workspace or app routes)
3. Rename title + tune constants for the genre
4. Implement the smallest fun loop for that genre
5. If movement: load controls skill and pass its checklist
6. Load building-games for collision, feel, genre playbook as needed
7. Smoke-test in browser
8. Only then polish art (generate2dsprite, tilesets, …)
```

## Load order

```text
game-scaffold  →  controls (if move)  →  building-games  →  assets / threejs / multiplayer-p2p
```

## References

| File | Use |
|------|-----|
| `references/01-done-and-smoke.md` | Smoke-test checklist |
| `references/02-genre-minimums.md` | Minimum features per genre |
| `templates/one-file-canvas/index.html` | Standalone starter |
| `templates/tanstack-2d/*` | App route starter |

## Never

- Ship static screenshots as the “game”
- Skip the loop “for now”
- Invent multiplayer backends when P2P skill is the supported path
- Write vehicle/flight input without **controls**
- Claim success without a run/verify step
