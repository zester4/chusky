import { createHash } from "node:crypto";
import type { BrowserObservation, ObservationRequest, ScreenshotReason, ScreenshotMode } from "./contracts.js";

export const DEFAULT_OBSERVATION_POLICY = {
  maxControls: 80,
  screenshotMode: "thumbnail" as ScreenshotMode,
  fullCaptureReasons: new Set<ScreenshotReason>(["ambiguous", "challenge", "coordinate-action", "user-request"]),
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/** Hash only non-sensitive page structure; control values are never included. */
export function structuralFingerprint(observation: Pick<BrowserObservation, "url" | "title" | "pageGeneration" | "controls">): string {
  const controls = observation.controls.map(({ observationId: _observationId, nodeId: _nodeId, screenshotHash: _screenshotHash, ...control }) => control);
  return createHash("sha256").update(stableJson({ url: observation.url, title: observation.title, pageGeneration: observation.pageGeneration, controls })).digest("hex").slice(0, 32);
}

export function pageProgressKey(observation: Pick<BrowserObservation, "url" | "title" | "pageGeneration" | "accessibilityHash">): string {
  return [observation.url, observation.title, observation.pageGeneration, observation.accessibilityHash].join("\u0000");
}

export function hasPageProgress(before: Pick<BrowserObservation, "url" | "title" | "pageGeneration" | "accessibilityHash"> | undefined, after: Pick<BrowserObservation, "url" | "title" | "pageGeneration" | "accessibilityHash">): boolean {
  return !before || pageProgressKey(before) !== pageProgressKey(after);
}

export function planObservation(
  previous: BrowserObservation | undefined,
  reason: ScreenshotReason = "after-action",
  options: Partial<typeof DEFAULT_OBSERVATION_POLICY> = {},
): ObservationRequest {
  const policy = { ...DEFAULT_OBSERVATION_POLICY, ...options };
  const screenshot = policy.fullCaptureReasons.has(reason)
    ? "viewport"
    : policy.screenshotMode;
  return {
    screenshot,
    screenshotReason: reason,
    includeForms: reason === "initial" || reason === "changed" || reason === "ambiguous",
    includeFrames: true,
    maxControls: Math.max(1, Math.min(200, policy.maxControls)),
    ...(previous ? { includeNetwork: false } : { includeNetwork: true }),
  };
}

export function observationChanged(before: BrowserObservation | undefined, after: BrowserObservation): boolean {
  return hasPageProgress(before, after) || before?.screenshot?.hash !== after.screenshot?.hash;
}
