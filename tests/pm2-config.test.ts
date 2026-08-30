import assert from "node:assert/strict";
import test from "node:test";

const ecosystem = require("../ecosystem.config.cjs") as {
  apps: Array<Record<string, unknown>>;
};

test("the Oracle PM2 definition uses one stable fork worker", () => {
  const chusky = ecosystem.apps.find((app) => app.name === "chusky");
  assert.ok(chusky);
  assert.equal(chusky.exec_mode, "fork");
  assert.equal(chusky.instances, 1);
  assert.equal(chusky.kill_timeout, 35_000);
  assert.equal(chusky.autorestart, true);
  assert.equal(chusky.max_memory_restart, "420M");
});
