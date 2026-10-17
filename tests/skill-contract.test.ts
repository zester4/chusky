import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillContracts: Array<[string, RegExp[]]> = [
  ["browser-pro", [/Runtime contract/, /fresh observation/, /verified state/]],
  ["composio-routing", [/Runtime contract/, /Jev/, /provider state/]],
  ["computer-pro", [/Runtime contract/, /workspace scope/, /checkpoint/]],
  ["deal-closer-pro", [/Runtime contract/, /concession/, /provider receipt/]],
  ["decision-pro", [/Runtime contract/, /observed facts/, /recommendation/]],
  ["expansion-pro", [/Runtime contract/, /Green health/, /attributable signal/]],
  ["launch-pro", [/Runtime contract/, /go\/no-go/, /provider receipt/]],
  ["lead-intel-pro", [/Runtime contract/, /MonID/, /provenance/]],
  ["lead-magnets", [/Chusky runtime contract/, /minimum capture data/, /definition of a qualified lead/]],
  ["meeting-pro", [/Runtime and live-meeting contract/, /meeting's scope/, /structured outcome/]],
  ["memory-pro", [/Runtime contract/, /bounded memory brief/, /canonical store/]],
  ["mission-pro", [/Runtime contract/, /CHUCK_MISSION_START/, /idempotent/]],
];

test("production skills expose the shared execution contract", async () => {
  for (const [name, patterns] of skillContracts) {
    const content = await readFile(`.chusky/skills/${name}/SKILL.md`, "utf8");
    assert.match(content, new RegExp(`name:\\s*${name.replace(/[-]/g, "\\-")}`));
    for (const pattern of patterns) assert.match(content, pattern, `${name} is missing ${pattern}`);
  }
});
