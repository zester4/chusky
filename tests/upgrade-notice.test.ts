import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_UPGRADE_PRESETS, formatAgentUpgradeNotice, getAgentUpgradePreset, loadAgentUpgrade, validateAgentUpgrade, writeAgentUpgrade } from "../src/upgradeNotice.js";

test("validates and formats a bounded upgrade notice", () => {
  const notice = validateAgentUpgrade({ version: "3.1.0", id: "release-3.1.0", bullets: ["One", "Two"] });
  assert.equal(formatAgentUpgradeNotice(notice), "Chusky has been upgraded (v3.1.0)\n- One\n- Two");
  assert.throws(() => validateAgentUpgrade({ version: "3.1.0", bullets: ["1", "2", "3", "4"] }), /one to three/);
});

test("meeting upgrade preset contains bounded, accurate release highlights", () => {
  const bullets = getAgentUpgradePreset("meetings");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.meetings]);
  assert.match(bullets[0], /client-matched readiness brief/);
  assert.match(bullets[1], /contribute naturally without waiting to be addressed/);
  assert.match(bullets[2], /sensitive and unrelated memories are excluded/);
  assert.throws(() => getAgentUpgradePreset("unknown"), /Unknown upgrade preset/);
});

test("mission upgrade preset contains bounded, accurate release highlights", () => {
  const bullets = getAgentUpgradePreset("missions");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.missions]);
  assert.match(bullets[0], /live provider outcome verification/);
  assert.match(bullets[1], /provider events/);
  assert.match(bullets[2], /Telegram, the CLI, SDK\/API, dashboard, and MCP/);
});

test("autonomy upgrade preset covers the current orchestration surfaces", () => {
  const bullets = getAgentUpgradePreset("autonomy");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.autonomy]);
  assert.match(bullets[0], /personal and business autonomy queues/);
  assert.match(bullets[1], /dependency-graph workflow composer/);
  assert.match(bullets[2], /Daytona browser and artifact execution/);
});

test("owner autonomy preset documents private full-context access and scoped exceptions", () => {
  const bullets = getAgentUpgradePreset("ownerAutonomy");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.ownerAutonomy]);
  assert.match(bullets[0], /chat, calls, and meetings/);
  assert.match(bullets[0], /Composio, MCP, and native tools/);
  assert.match(bullets[1], /deletion, financial, permission, deployment\/push, and provider-marked high-impact actions pause for exact approval/);
  assert.match(bullets[2], /shared rooms, autonomous workflows, and delegated workers/);
});

test("shared history upgrade preset documents private web parity without widening room scope", () => {
  const bullets = getAgentUpgradePreset("sharedHistory");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.sharedHistory]);
  assert.match(bullets[0], /same owner-scoped account history/);
  assert.match(bullets[1], /imports its private conversation history/);
  assert.match(bullets[2], /shared rooms and company\/project runs remain outside/);
});

test("attention upgrade preset describes evidence-based proactive reconciliation", () => {
  const bullets = getAgentUpgradePreset("attention");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.attention]);
  assert.match(bullets[0], /blocked or failed tasks and missions/);
  assert.match(bullets[1], /Personal and business watches are isolated/);
  assert.match(bullets[2], /preserving approval boundaries/);
});

test("tool reliability upgrade preset describes bounded diagnostics and approved artifact transfer", () => {
  const bullets = getAgentUpgradePreset("toolReliability");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.toolReliability]);
  assert.match(bullets[0], /exact exposed schema/);
  assert.match(bullets[1], /never blindly replays/);
  assert.match(bullets[2], /approval-gated transfer/);
  assert.match(bullets[2], /typed SDK, single-tool MCP runs, and durable A2A task skills/);
});

test("media automation upgrade preset describes normal-action attachment and provider receipts", () => {
  const bullets = getAgentUpgradePreset("mediaAutomation");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.mediaAutomation]);
  assert.match(bullets[0], /ordinary conversation/);
  assert.match(bullets[0], /Instagram carousels/);
  assert.match(bullets[1], /current Composio schema/);
  assert.match(bullets[2], /provider read-back/);
});

test("Daytona image upgrade preset describes private two-way transfers", () => {
  const bullets = getAgentUpgradePreset("daytonaImages");
  assert.equal(bullets.length, 3);
  assert.match(bullets[0], /created inside Daytona/);
  assert.match(bullets[1], /Current chat images/);
  assert.match(bullets[2], /explicitly asks/);
});

test("generated image API upgrade preset documents private durable image delivery", () => {
  const bullets = getAgentUpgradePreset("generatedImageApi");
  assert.equal(bullets.length, 3);
  assert.match(bullets[0], /private image store/);
  assert.match(bullets[1], /short-lived image download URL/);
  assert.match(bullets[2], /images:read/);
});

test("custom MCP upgrade preset describes verification, private networking controls, and agent execution", () => {
  const bullets = getAgentUpgradePreset("customMcp");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.customMcp]);
  assert.match(bullets[0], /legacy HTTP\+SSE fallback/);
  assert.match(bullets[1], /private\/link-local targets and redirects/);
  assert.match(bullets[2], /group and meeting contexts/);
});

test("Treg upgrade preset describes live provider data and spend controls", () => {
  const bullets = getAgentUpgradePreset("treg");
  assert.equal(bullets.length, 3);
  assert.match(bullets[0], /first-class live-data gateway/);
  assert.match(bullets[1], /atomic owner and mission spend/);
  assert.match(bullets[2], /Composio apps/);
});

test("Jev routing upgrade preset describes semantic routing and connection safety", () => {
  const bullets = getAgentUpgradePreset("jevRouting");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.jevRouting]);
  assert.match(bullets[0], /Composio toolkits and actions/);
  assert.match(bullets[1], /remain non-callable until connected/);
  assert.match(bullets[2], /deterministic fallback/);
});

test("loads and writes the release manifest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chusky-upgrade-"));
  const manifest = path.join(directory, "agent-upgrade.json");
  try {
    await writeAgentUpgrade(manifest, { version: "3.2.0", bullets: ["Skill updates are now visible."] });
    const loaded = await loadAgentUpgrade(manifest);
    assert.equal(loaded?.version, "3.2.0");
    assert.equal(JSON.parse(await readFile(manifest, "utf8")).bullets.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("current upgrade manifest announces proactive Jev attention routing", async () => {
  const notice = await loadAgentUpgrade(path.resolve(process.cwd(), "agent-upgrade.json"));
  assert.equal(notice?.id, "release-4.22.0");
  assert.equal(notice?.version, "4.22.0");
  assert.match(formatAgentUpgradeNotice(notice!), /bounded browser decision loop/);
  assert.match(formatAgentUpgradeNotice(notice!), /Jev/);
  assert.match(formatAgentUpgradeNotice(notice!), /existing approval/);
});

test("browser autonomy upgrade preset describes bounded Jev sequencing", () => {
  const bullets = getAgentUpgradePreset("browserAutonomy");
  assert.equal(bullets.length, 3);
  assert.match(bullets[0], /bounded browser decision loop/);
  assert.match(bullets[1], /credentials/);
  assert.match(bullets[2], /deterministic browser path/);
});

test("X Direct Messages upgrade preset distinguishes normal DMs from encrypted XChat", () => {
  const bullets = getAgentUpgradePreset("xDirectMessages");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.xDirectMessages]);
  assert.match(bullets[0], /regular X Direct Messages channel alongside separate encrypted XChat/);
  assert.match(bullets[1], /official adapter/);
  assert.match(bullets[2], /unsolicited X notifications stay off/);
  assert.match(bullets[2], /does not expose inbound DM images yet/);
});
