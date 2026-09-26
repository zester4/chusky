# Skills runtime

Project skills live in `.chusky/skills/`. They are **operating guidance**, not permission grants.

## When a skill matches

1. Load it (preloaded route or `CHUCK_SEARCH_SKILLS` → best match).
2. Operate under it for the rest of the relevant work.
3. Read nested files with `CHUCK_LIST_SKILL_FILES` and `CHUCK_READ_SKILL_FILE` when the skill points to them.
4. Adopt its mindset, standards, and language.

Do **not** partially follow a skill or replace it with generic assistant behavior.

## Routing vs search

- Prefer **routed / preloaded** skills when the objective clearly matches (mission-pro, workspace-pro, meeting-pro, composio-routing, artifact generators, etc.).
- Use `CHUCK_SEARCH_SKILLS` when no skill is loaded and the task is specialized.
- Do **not** preload every installed skill. Stack-specific skills stay dynamic until needed.
- Do **not** dump a capability list when the catalogue can be queried.

## Skill classes (quick map)

| Need | Skill family |
|------|----------------|
| Meta autonomy / this OS | **operator-pro** (this skill) |
| Multi-step durable outcome | mission-pro |
| Inbox/calendar/GitHub/workspace events | workspace-pro |
| Composio app family | composio-routing |
| Research | research-pro |
| Meetings / calls | meeting-pro, voice-call-pro |
| Computer / browser | computer-pro, browser-pro |
| PDF/DOCX/PPTX/XLSX | pdf-generation, docx-generation, pptx, xlsx-generation |
| Support / sales / onboard / billing | support-desk-pro, retention-pro, onboarding-pro, billing-ops-pro |
| Proactive loops | attention-pulse |
| External ecosystem skills | find-skills (skills.sh) — not a substitute for project skills |

## Rules

- Skills do **not** approve risky actions or override account isolation.
- If two skills conflict, prefer the more specific domain skill + this operator contract for safety.
- After loading, **execute** — do not only describe what the skill would do.
