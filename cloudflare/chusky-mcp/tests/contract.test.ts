import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("MCP keeps the approval boundary and response limits explicit", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /legacy:\s*["']stateless["']/);
  assert.match(source, /corsOptions:\s*false/);
  assert.match(source, /text\.length > 1_000_000/);
  assert.match(source, /raw\.length <= 24_000/);
  assert.match(source, /redirect:\s*["']manual["']/);
  assert.doesNotMatch(source, /redirect:\s*["']error["']/);
  assert.match(source, /oauthCompletionResponse/);
  assert.match(source, /http-equiv="refresh"/);
  assert.doesNotMatch(source, /approvals\/[^"`]*\/(approve|deny)/);
  assert.match(source, /server\.registerTool\("chusky_tool_run"/);
  assert.match(source, /CHUCK_TOOL_PREFLIGHT.*CHUCK_INTEGRATION_HEALTH.*CHUCK_ARTIFACT_QA.*CHUCK_FILE_BRIDGE.*CHUCK_TOOL_RECOVERY/s);
  assert.match(source, /"chusky_run_start"[^\]]*"chusky_tool_run"/s);
  assert.match(source, /tools:\s*\{\s*allow:\s*\[tool\]/);
  assert.match(source, /budget:\s*\{\s*maxToolCalls:\s*1\s*\}/);
  assert.match(source, /If the tool requires human approval, pause/);
});
