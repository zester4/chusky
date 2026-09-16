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
  assert.match(bullets[0], /Zoom/);
  assert.match(bullets[1], /sales and onboarding/);
  assert.match(bullets[2], /screen-share/);
  assert.throws(() => getAgentUpgradePreset("unknown"), /Unknown upgrade preset/);
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

test("current upgrade manifest announces the meeting release", async () => {
  const notice = await loadAgentUpgrade(path.resolve(process.cwd(), "agent-upgrade.json"));
  assert.equal(notice?.id, "release-3.2.0");
  assert.equal(notice?.version, "3.2.0");
  assert.match(formatAgentUpgradeNotice(notice!), /Chusky meetings are now live/);
  assert.match(formatAgentUpgradeNotice(notice!), /Google Meet/);
  assert.match(formatAgentUpgradeNotice(notice!), /sales and onboarding/);
  assert.match(formatAgentUpgradeNotice(notice!), /Nova-3/);
});
