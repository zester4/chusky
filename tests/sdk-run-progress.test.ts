import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSdkRunProgress, progressFromSdkStatus, progressFromSdkToolActivity, progressFromSdkToolCheckpoint, terminalSdkRunProgress } from "../src/sdkRunProgress.js";

test("SDK run progress is bounded and strips unsafe evidence links", () => {
  const progress = normalizeSdkRunProgress({
    phase: "acting",
    title: "  Send\u0000 the approved update  ",
    detail: "A\nprovider action is running.",
    provider: "gmail",
    progress: 4,
    requiresApproval: false,
    evidence: [
      { id: "step-1", label: "Draft ready", detail: "Safe detail", kind: "step", href: "https://example.test/source" },
      { label: "Unsafe link", href: "javascript:alert(1)" },
    ],
  });

  assert.deepEqual(progress, {
    phase: "acting",
    title: "Send the approved update",
    detail: "A provider action is running.",
    provider: "gmail",
    progress: 1,
    requiresApproval: false,
    evidence: [
      { id: "step-1", label: "Draft ready", detail: "Safe detail", kind: "step", href: "https://example.test/source" },
      { label: "Unsafe link" },
    ],
  });
});

test("SDK progress derives human phases from statuses and tool activity", () => {
  const planning = progressFromSdkStatus("🧭 I’m understanding your request…");
  assert.equal(planning.phase, "planning");
  assert.equal(planning.title, "Working…");
  assert.equal(planning.detail, undefined);

  const research = progressFromSdkToolActivity({
    toolSlug: "CHUCK_SEARCH_SKILLS",
    status: "completed",
    message: "Searching the relevant guidance.",
    actionLabel: "Found the relevant guidance",
    toolkitName: "Chusky",
    callId: "call-1",
    summary: "Returned 3 matching skill files.",
  });
  assert.equal(research.phase, "researching");
  assert.equal(research.provider, "Chusky");
  assert.equal(research.evidence?.[0]?.kind, "step");

  const approval = progressFromSdkToolActivity({
    toolSlug: "GMAIL_SEND_EMAIL",
    status: "approval_required",
    message: "I'm taking care of that...",
    actionLabel: "I'm taking care of that...",
    toolkitSlug: "gmail",
  }, research);
  assert.deepEqual(approval, {
    phase: "waiting",
    title: "Gmail · Send Email",
    detail: "Waiting for your approval before this action can continue.",
    provider: "gmail",
    requiresApproval: true,
    evidence: research.evidence,
  });
});

test("SDK progress replaces generic model filler with a provider-qualified tool action", () => {
  const progress = progressFromSdkToolActivity({
    toolSlug: "GOOGLEMAPS_SEARCH_BUSINESSES",
    status: "started",
    message: "I’m taking care of that…",
    actionLabel: "I’m taking care of that…",
    toolkitSlug: "google_maps",
    toolkitName: "Google Maps",
  });

  assert.equal(progress.title, "Google Maps · Search Businesses");
  assert.equal(progress.detail, undefined);
  assert.equal(progress.provider, "google_maps");
});

test("SDK progress publishes a bounded done-and-next checkpoint after four tool calls", () => {
  const checkpoint = progressFromSdkToolCheckpoint([
    { toolSlug: "CHUCK_TREG_BALANCE", status: "completed", message: "Done", toolkitName: "Treg", summary: "Balance checked" },
    { toolSlug: "CHUCK_TREG_SEARCH", status: "completed", message: "Done", toolkitName: "Treg", summary: "Capabilities found" },
    { toolSlug: "CHUCK_TREG_COMPANY_SEARCH", status: "completed", message: "Done", toolkitName: "Treg", summary: "Companies found" },
    { toolSlug: "CHUCK_TREG_PEOPLE_SEARCH", status: "completed", message: "Done", toolkitName: "Treg", summary: "People found" },
  ], {
    toolSlug: "CHUCK_TREG_ENRICH_PERSON",
    status: "started",
    message: "Running now",
    toolkitName: "Treg",
  });

  assert.equal(checkpoint.title, "Treg · Progress update");
  assert.match(checkpoint.detail ?? "", /Done:/);
  assert.match(checkpoint.detail ?? "", /Next: Treg · Enrich Person\./);
  assert.equal(checkpoint.phase, "acting");
});

test("completed SDK progress exposes generated artifacts as safe evidence", () => {
  const progress = terminalSdkRunProgress("completed", {
    artifacts: [{ id: "artifact_1", name: "proposal.pdf" }],
  });

  assert.equal(progress.phase, "completed");
  assert.equal(progress.progress, 1);
  assert.deepEqual(progress.evidence, [{ id: "artifact_1", label: "proposal.pdf", kind: "artifact", href: "artifact:artifact_1" }]);
});

test("terminal SDK progress preserves failure and cancellation instead of impersonating approval", () => {
  const failed = terminalSdkRunProgress("failed", { error: "The model request timed out." });
  const cancelled = terminalSdkRunProgress("cancelled");
  assert.equal(failed.phase, "failed");
  assert.equal(failed.requiresApproval, undefined);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.requiresApproval, undefined);
});
