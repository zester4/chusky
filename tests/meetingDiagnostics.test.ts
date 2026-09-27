import assert from "node:assert/strict";
import test from "node:test";
import { meetingAgentFailureDiagnostics } from "../src/meetings/diagnostics.js";

test("meeting diagnostics extract an OpenRouter HTTP status without logging provider text", () => {
  const privateDetail = "OpenRouter 400: invalid tool schema containing private transcript text";
  assert.deepEqual(meetingAgentFailureDiagnostics(new Error(privateDetail)), {
    errorType: "Error",
    failureReason: "http_400",
    httpStatus: 400,
  });
  assert.equal(JSON.stringify(meetingAgentFailureDiagnostics(new Error(privateDetail))).includes("private transcript"), false);
});

test("meeting diagnostics classify safe model, Composio, abort, and unknown failures", () => {
  assert.deepEqual(meetingAgentFailureDiagnostics(new Error("OpenRouter returned an empty stream")), {
    errorType: "Error",
    failureReason: "model_empty_stream",
  });
  assert.equal(meetingAgentFailureDiagnostics(new Error("Composio provider response with private details")).failureReason, "connected_app_runtime_error");
  assert.equal(meetingAgentFailureDiagnostics(new DOMException("private request data", "AbortError")).failureReason, "request_aborted");
  assert.deepEqual(meetingAgentFailureDiagnostics({ status: 429, message: "private" }), {
    errorType: "UnknownError",
    failureReason: "http_429",
    httpStatus: 429,
  });
});

test("meeting diagnostics never include raw error messages", () => {
  const diagnostics = meetingAgentFailureDiagnostics(new Error("participant transcript and provider payload"));
  assert.deepEqual(diagnostics, { errorType: "Error", failureReason: "agent_runtime_error" });
  assert.equal(JSON.stringify(diagnostics).includes("participant transcript"), false);
  assert.equal(JSON.stringify(diagnostics).includes("provider payload"), false);
});
