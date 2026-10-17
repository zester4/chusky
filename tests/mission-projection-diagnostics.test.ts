import test from "node:test";
import assert from "node:assert/strict";
import { MissionWebProjectionError, missionProjectionFailureDetails, wrapMissionProjectionError } from "../src/missionProjectionDiagnostics.js";

test("mission projection diagnostics classify lease contention without exposing connections", () => {
  const error = new MissionWebProjectionError("write_session", "Session mutation is busy; retry shortly.", true);
  assert.deepEqual(missionProjectionFailureDetails(error), {
    errorType: "MissionWebProjectionError",
    errorCode: "session_lease_busy",
    errorMessage: "Session mutation is busy; retry shortly.",
    projectionStage: "write_session",
    retryable: true,
  });
});

test("mission projection diagnostics redact connection strings and preserve the failing stage", () => {
  const error = wrapMissionProjectionError("read_session", new Error("connect failed for postgres://user:secret@example.test/db"));
  const details = missionProjectionFailureDetails(error);
  assert.equal(details.projectionStage, "read_session");
  assert.equal(details.errorCode, "storage_transport");
  assert.equal(details.retryable, true);
  assert.doesNotMatch(details.errorMessage, /secret|postgres:\/\//i);
});

test("invalid mission projection input is non-retryable", () => {
  const details = missionProjectionFailureDetails(new MissionWebProjectionError("validate", "A valid owner-scoped terminal mission is required.", false));
  assert.equal(details.errorCode, "invalid_projection_input");
  assert.equal(details.retryable, false);
});
