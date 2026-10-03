Goal: use Jev's routing to load only the tools, skills and prompt modules a turn needs, without breaking anything that works today.

1. The problem, measured

Every model request carries a fixed block of tokens before the user's words. Token counts below are estimates (chars / 3.6). They match the ~60k minimum seen in production, so treat them as accurate to roughly 15%. Ground truth comes from the provider's usage.prompt_tokens (see WI-0).

Piece sent on every request	Tokens	Source
Native tool schemas, 213 tools	~44,100	modelFacingChuckTools in src/agentTools.ts
Static system prompt (composed)	~17,500	composeSystemPrompt in src/prompt.ts
of which the customizable default prompt	~14,500	config.chuckSystemPrompt
of which autonomy kernel, shopping and meeting playbooks	~2,600	agent.ts mandatorySections
Fixed floor per request	~61,600
Skill guidance	up to ~6,700	MAX_CONTEXT_CHARS = 24_000 in src/skills/catalog.ts
Composio session tools, MCP tools	unmeasured	agent.ts, composioTools and mcpTools
Memory, knowledge, summaries, accounts, route context, history (7 msgs)	unmeasured	memoryContext, dynamicSystemContext

Run scripts/measure-prompt-budget.ts (Appendix A) to reproduce the first four rows.

Native tool cost by bundle (the router's own classification)
Bundle	Tools	Tokens
core (alwaysAvailable)	13	~3,000
meetings	28	~8,300
browser	37	~8,300
intelligence	39	~7,600
artifacts	21	~6,800
autonomy	36	~5,200
code	24	~3,800
other / shopping / workspace	28	~4,100

Native schema text splits into ~17k tokens of descriptions and ~21k of parameter schemas.

2. Root causes (ranked)
The full tool catalog is the fallback. baselineRoute() in src/decisions/nativeToolRouter.ts returns every tool. It is used whenever Jev isn't confident (low_confidence_or_none), when no keyword matches (no_native_candidate_set), when Jev times out, or when routing is off. In production logs both sampled turns hit this fallback, so Jev routing saved zero tokens even in enforce mode.
Every tool round re-sends everything. The agent loop in src/agent.ts re-sends the whole messages array and the whole tool list each round, and MAX_TOOL_ROUNDS defaults to 70 (config.ts). A 3-round turn is ~3x the floor.
The system prompt is mostly static and mostly unused per turn. The shopping and meeting playbooks and the autonomy kernel are injected for every non-voice, non-shared turn regardless of topic.
No visibility. orChat keeps only usage.cost and discards prompt_tokens, completion_tokens and cached tokens (agent.ts ~L367, ~L2652, ~L3444). No cache_control is set anywhere, so prompt caching is unverified.
History is not the cause. Cutting it from 7 messages saves little next to a ~60k floor. Do not start there.
3. Prior art (why this design)
Deferred tool loading / tool search. The model sees a search tool plus a small always-on set. Matches become callable on the next turn. Vendors report >85% fewer definition tokens, loading ~3-5 tools per request, and a stable tool list helps prompt caching. Worth it from ~10 tools or ~10k tokens of definitions. Sources: orq.ai tool-search docs; WorkOS "MCP server token cost"; GitHub Copilot CLI tool-search docs.
Caveats. Each search and reload costs tokens and a round trip, so the model needs a compact index of what exists, and descriptions must be good enough to search.
Jev-based routers (jev-tool-router, jev-mcp-router) expose a small routing surface and fail open. Their rule: selection is not authorization, and vague descriptions make routing worse. This matches Chusky's existing rule that Jev only proposes.
4. Design principles (non-negotiable)
Additive and flagged. Ship behind NATIVE_TOOL_LOADING=full|bundle (default full). Nothing changes until the flag flips.
Jev proposes, code decides. Approvals, allowlists, account scope and spend limits stay exactly as they are.
Never hide a tool without an escape hatch. Every hidden tool must be discoverable through CHUCK_FIND_TOOLS in the same turn.
Fail toward more capability, but not toward everything. Low confidence means core tools plus keyword-matched bundles plus CHUCK_FIND_TOOLS, not the full catalog.
Keep the prefix stable for caching: static content first, stable ordering, append-only changes within a turn.
Missions are untouched. Worker allowlists (missionWorkerToolAllowlist) and retainLifecycleToolFamilies keep their behavior. CHUCK_MISSION_* lifecycle tools must never be hidden from a mission worker.
5. Work items

Do them in this order. Each is a separate PR with its own tests.

WI-0: Instrumentation (ship first, zero risk)

Files: src/agent.ts (orChat, ~L367 streaming chunk.usage, ~L2652 response.usage, ~L3444 final.usage), src/decisions/telemetry.ts.

Capture prompt_tokens, completion_tokens and cached tokens (prompt_tokens_details.cached_tokens or the provider's equivalent) in addition to cost. Add them to the existing run.model_requested/run.round_* run events and to the Chusky done log line.
Add one request.budget info log per request with estimated tokens per component: static system, dynamic context, history, user message, native tools (count and tokens), Composio tools, MCP tools, skill guidance.
Acceptance: after one day in production you can answer "what is in the 70k?" from logs, including the Composio, MCP and memory rows that are unmeasured today.
WI-1: Bundle-first native tool selection

Files: src/decisions/nativeToolRouter.ts, src/config.ts (~L220-225 Jev native settings).

Add NATIVE_TOOL_LOADING (full | bundle).
In bundle mode, change the fallback paths in computeNativeToolRoute: no_native_candidate_set, low_confidence_or_none, no_selected_native_tool, Jev error, timeout and breaker-open all return core + keyword-matched bundles + CHUCK_FIND_TOOLS, never the full tools array. Today baselineRoute() returns everything.
Ask Jev one question over the ~9 bundles (a single Choice or Noul call per bundle) instead of ranking 100+ individual tools. Keep tool-level ranking only inside a selected bundle when you want finer trimming. Bundle choice is cheaper, more accurate and needs fewer thresholds.
Keep CORE_TOOLS, retainLifecycleToolFamilies, the CHUCK_MEDIA_BRIDGE exclusion and the keyword baseline as the deterministic safety net. Force-include bundles the keyword scorer matches strongly (an explicit "image" must always surface CHUCK_GENERATE_IMAGE) regardless of Jev's answer.
Acceptance: with the flag on, the greeting turn and the "generate an image" turn from the Railway logs send core + at most the artifacts bundle, not 213 tools. tests/native-tool-router.test.ts and tests/jev-routing.test.ts extended for each fallback path.
WI-2: CHUCK_FIND_TOOLS (progressive disclosure)

Files: src/agentTools.ts (schema), src/nativeTools.ts (handler), src/agent.ts (round loop).

New native tool: CHUCK_FIND_TOOLS({ query, bundle? , max_results? }). It searches names, descriptions and parameter names of tools not currently loaded, returns up to 5 (default), and reveals them from the next round.
In the round loop (const routedTools = nativeToolRoute.tools, ~L2602) build the per-round list as routedTools + revealedTools. The loop already recomputes this each round, so no restructuring is needed. Reveal is append-only so the cached prefix is not reshuffled.
Respect every fence: allow, deny, shared-channel denials, voice-turn lists. CHUCK_FIND_TOOLS can never reveal a tool the run is not allowed to call. Mission workers either don't get it or get it constrained to their allowlist.
If the model calls a tool name that exists but is not loaded, return a short error naming CHUCK_FIND_TOOLS. Do not execute it.
Add a compact tool index (~300 tokens: bundle name plus one line each) to dynamicSystemContext so the model knows what exists.
Optional: when more than ~12 tools match, rank them with Jev and return the best 5.
Acceptance: unit tests for reveal timing, fences, allowlisted workers, and the "not loaded" error. Mission end-to-end tests (tests/mission-*.test.ts) unchanged and green.
WI-3: Composio and MCP tool surface

Files: src/agent.ts (~L2186-2210, fullComposioTools, composioTools, mcpTools), src/decisions/composioRouter.ts.

Today, when a user has 80 or fewer Composio tools, all of them are attached with full schemas. Above 80, only COMPOSIO_* meta tools plus allowlisted ones are attached. Apply the "meta tools plus routed actions" shape at a much lower threshold, and cap how many direct tools a turn gets.
MCP tools from mcpClient.discoverToolsForUser are attached in full with no cap that I could find. Route them with the same bundle-or-search approach (keyword plus Jev on server names, reveal via CHUCK_FIND_TOOLS). Measure with WI-0 first. This row is unmeasured and may be large.
Acceptance: request.budget shows Composio plus MCP tokens under an agreed ceiling for a user with typical connections.
WI-4: System prompt slimming

Files: src/prompt.ts, src/agent.ts (staticSystemPrompt/mandatorySections, ~L2506-2512), src/config.ts (~L353 chuckSystemPrompt).

Keep always: identity, IMMUTABLE_SAFETY_KERNEL, operating mode, core rules (target ~3-4k tokens).
Make conditional: shopping playbook, meeting-mission playbook, trigger autonomy, upgrade notices. Inject only when routed as relevant (keyword plus a cheap Jev choice, fail toward including).
Move long rule sections of the 14.5k default prompt into skills under .chusky/skills/, which already load on demand through CHUCK_SEARCH_SKILLS.
First check whether the Railway deployment sets a SYSTEM_PROMPT variable. If it does, the live prompt differs from the default measured here.
Acceptance: static prompt <=6k tokens on a plain turn. tests/prompt.test.ts asserts the safety kernel is always present.
WI-5: Tool schema diet

Files: src/agentTools.ts.

Rules: descriptions <=300 characters, short parameter descriptions, move usage guidance into skills, use enums instead of prose. Do not change validateNativeToolArguments behavior or any slug.
Biggest first (est. tokens): CHUCK_MEETING_JOIN ~1,470, CHUCK_MISSION_START ~1,360, CHUCK_DAYTONA_APP ~880, CHUCK_ATTENTION_STATE ~840, CHUCK_BROWSER ~810, CHUCK_CREATE_PRESENTATION ~750.
Add tests/tool-budget.test.ts: fails if total native schema tokens or any single tool exceeds a budget. This stops regrowth.
Acceptance: at least 40% fewer native schema tokens, with tests/native-tool-contract.test.ts and tests/agent-tools.test.ts passing.
WI-6: Rounds, tool results, history, memory

Files: src/config.ts (~L609 maxToolRounds), src/agent.ts (round loop, promptHistory, memoryContext), src/skills/catalog.ts.

Split MAX_TOOL_ROUNDS: chat turns ~15-20, mission and worker slices keep the high value.
Truncate large tool results when re-sent in later rounds (keep head and tail, store the full result durably) and collapse completed rounds.
Cap each history message (~1,500 characters) and the knowledge and memory blocks (per-chunk and total).
Lower the skill context cap from 24,000 to ~9,000 characters. Skills are already routed, and the model can read more on demand.
Acceptance: a 3-round turn costs well under 3x a 1-round turn.
WI-7: Prompt caching

Files: src/agent.ts (orChat, message assembly, the messages.splice(2, 0, ...) at the start of the round loop).

Keep the order static system, then tools in stable order, then dynamic context, then history. Replace the mid-prefix messages.splice(2, 0, ...) with an append so the prefix stays intact.
For Claude-family models via OpenRouter, add cache_control breakpoints on the static prefix. For others, confirm provider-side implicit caching from the new cached_tokens metric. Check the production model (stealth/space-bunny-alpha).
Acceptance: cached_tokens / prompt_tokens visible in logs. Report the hit rate before and after.
WI-8: Telemetry, validation and rollout
Extend the Jev decision log: selected bundles, the "none" probability, whether a hint or fallback was applied, and tool-miss events (model called CHUCK_FIND_TOOLS, or tried an unloaded tool).
Offline replay before enabling: for the last N turns, take the tools actually used (run records or toolsUsed) and check whether the proposed core + bundle selection would have contained them all. Target a miss rate below 5% before flipping any flag.
Rollout: bundle mode for 10% of turns with a full holdout. Compare task completion, tool-miss rate, p50/p95 latency, tokens per request, and cost. Ramp only if completion does not drop.
6. Expected result
Step	Approx. effect per request
WI-1 + WI-2 (bundle loading + find tool)	native tools ~44k to ~8-12k
WI-4 (prompt modules)	system ~17.5k to ~5-6k
WI-5 (schema diet)	a further ~30-40% off whatever tools remain
WI-6 (skills cap, rounds, results)	up to ~4k off skills, plus multi-round growth
Total	~60k floor to ~15-20k, before caching

These are estimates. WI-0 replaces them with measurements.

7. Risks and mitigations
Risk	Mitigation
Model doesn't know to search and answers without a needed tool	Tool index in context, force-include on strong keyword matches, track the tool-miss rate
Extra search round adds latency	Preload the confident tools, keep the core set rich, measure p95
Hidden tool causes a silent failure	Clear "not loaded, use CHUCK_FIND_TOOLS" error, never a silent drop
Reveal breaks mission workers	Workers keep allowlists, CHUCK_FIND_TOOLS constrained or absent, mission tests stay green
Vague descriptions hurt search	WI-5 rewrites descriptions with search in mind, test with a labeled intent-to-tool set
Cache churn from changing tool lists	Stable ordering, append-only reveals, measure cached_tokens
8. Out of scope

Treg (the live-data gateway) is not part of tool selection and needs no change. Its 14 CHUCK_TREG_* tools simply live in the intelligence bundle. Jev model changes, mission-engine changes, and the history length setting are also out of scope.

Appendix A: scripts/measure-prompt-budget.ts

Run from the repo root: TELEGRAM_BOT_TOKEN=x COMPOSIO_API_KEY=x OPENROUTER_API_KEY=x npx tsx scripts/measure-prompt-budget.ts

ts
import fs from "node:fs";
import { config } from "../src/config.js";
import { composeSystemPrompt } from "../src/prompt.js";
import { modelFacingChuckTools } from "../src/agentTools.js";
import { nativeToolManifest } from "../src/decisions/nativeToolRouter.js";
import { AUTONOMY_OPERATING_KERNEL } from "../src/autonomy/operatingLoop.js";
import { SHOPPING_AGENT_PLAYBOOK } from "../src/shopping/shopping.js";

const tok = (chars: number) => Math.round(chars / 3.6);
const row = (name: string, chars: number) => console.log(name.padEnd(36), String(tok(chars)).padStart(7), "tokens");

const agentSource = fs.readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
const meeting = agentSource.match(/const MEETING_MISSION_PLAYBOOK = `([\s\S]*?)`;/)?.[1] ?? "";
const system = composeSystemPrompt({ customizablePrompt: config.chuckSystemPrompt, mandatorySections: [AUTONOMY_OPERATING_KERNEL, SHOPPING_AGENT_PLAYBOOK, meeting] });
row("customizable system prompt", config.chuckSystemPrompt.length);
row("static system prompt (composed)", system.length);

const sizeBySlug = new Map<string, number>(modelFacingChuckTools.map((t: any) => [String(t.function?.name).toUpperCase(), JSON.stringify(t).length]));
const total = [...sizeBySlug.values()].reduce((a, b) => a + b, 0);
row(`native tools (${sizeBySlug.size})`, total);

const bundles: Record<string, { n: number; chars: number }> = {};
let core = 0;
for (const d of nativeToolManifest) {
  const chars = sizeBySlug.get(d.slug) ?? 0;
  (bundles[d.bundle] ??= { n: 0, chars: 0 }).n++; bundles[d.bundle].chars += chars;
  if (d.alwaysAvailable) core += chars;
}
row("  core (alwaysAvailable)", core);
for (const [name, v] of Object.entries(bundles).sort((a, b) => b[1].chars - a[1].chars)) row(`  bundle ${name} (${v.n})`, v.chars);
console.log("\nlargest tool schemas:", [...sizeBySlug].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => `${n}=${tok(c)}t`).join(", "));
console.log("static floor per request (system + all native tools):", tok(system.length + total), "tokens");
Appendix B: how routing is used today (for context)
src/agent.ts runs skill, Treg and Composio routing in parallel under one JEV_TURN_BUDGET_MS deadline (default 3,000 ms), then native tool routing reuses that deadline.
routeNativeToolsForTurn returns baselineRoute(tools) (the full catalog) when routing is disabled, the query is empty, or any fallback path above fires.
Jev only runs for native tools when a keyword relevance scorer already found candidates (candidateSet). A message with no keyword match never reaches Jev.
Native routing applies only when Jev's confidence is at least JEV_NATIVE_TOOL_MIN_CONFIDENCE (0.6) and the "none" probability is below it. Tools are kept at probability JEV_NATIVE_TOOL_MIN_PROBABILITY (0.12) or more, up to JEV_NATIVE_TOOL_MAX_CANDIDATES (16).
