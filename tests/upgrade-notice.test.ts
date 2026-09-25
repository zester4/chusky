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

test("media bridge upgrade preset describes direct execution, scoped assets, and provider receipts", () => {
  const bullets = getAgentUpgradePreset("mediaBridge");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.mediaBridge]);
  assert.match(bullets[0], /exact connected-app actions/);
  assert.match(bullets[1], /run in the same turn/);
  assert.match(bullets[2], /provider confirms/);
});

test("custom MCP upgrade preset describes verification, private networking controls, and agent execution", () => {
  const bullets = getAgentUpgradePreset("customMcp");
  assert.equal(bullets.length, 3);
  assert.deepEqual(bullets, [...AGENT_UPGRADE_PRESETS.customMcp]);
  assert.match(bullets[0], /legacy HTTP\+SSE fallback/);
  assert.match(bullets[1], /private\/link-local targets and redirects/);
  assert.match(bullets[2], /group and meeting contexts/);
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

test("current upgrade manifest announces the mission and connected-app media bridge release", async () => {
  const notice = await loadAgentUpgrade(path.resolve(process.cwd(), "agent-upgrade.json"));
  assert.equal(notice?.id, "release-4.9.0");
  assert.equal(notice?.version, "4.9.0");
  assert.match(formatAgentUpgradeNotice(notice!), /live provider outcome verification/);
  assert.match(formatAgentUpgradeNotice(notice!), /conversation, generated, or saved images/);
  assert.match(formatAgentUpgradeNotice(notice!), /provider confirms that exact action succeeded/);
});
