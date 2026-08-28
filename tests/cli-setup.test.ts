import test from "node:test";
import assert from "node:assert/strict";
import { healthReport, mergeEnv, parseEnv } from "../src/cli/setup.js";

test("setup parses quoted values and preserves unrelated env content", () => {
  const source = "# keep this\nTELEGRAM_BOT_TOKEN=old\nCUSTOM=value\n";
  const merged = mergeEnv(source, { TELEGRAM_BOT_TOKEN: "new-token", REDIS_URL: "redis://localhost:6379/0" });
  assert.match(merged, /^# keep this\n/m);
  assert.match(merged, /TELEGRAM_BOT_TOKEN=\"new-token\"/);
  assert.match(merged, /CUSTOM=value/);
  assert.match(merged, /REDIS_URL=\"redis:\/\/localhost:6379\/0\"/);
  assert.equal(parseEnv(merged).get("TELEGRAM_BOT_TOKEN"), "new-token");
});

test("health report distinguishes required, optional, and configured settings", () => {
  const report = healthReport(new Map([["TELEGRAM_BOT_TOKEN", "token"], ["DEFAULT_MODEL", "model"]]));
  assert.equal(report.find((row) => row.key === "TELEGRAM_BOT_TOKEN")?.status, "configured");
  assert.equal(report.find((row) => row.key === "OPENROUTER_API_KEY")?.status, "missing");
  assert.equal(report.find((row) => row.key === "REDIS_URL")?.status, "optional");
  assert.equal(report.find((row) => row.key === "DEFAULT_MODEL")?.status, "configured");
});
