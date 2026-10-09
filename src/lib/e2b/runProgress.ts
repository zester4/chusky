type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function bounded(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formStateMarker(value: unknown): JsonRecord | undefined {
  const state = record(value);
  if (!state) return undefined;
  return {
    controlRole: bounded(state.controlRole, 40),
    valuePresent: boolean(state.valuePresent) ?? (typeof state.valueLength === "number" ? state.valueLength > 0 : undefined),
    valueLength: typeof state.valueLength === "number" ? Math.max(0, Math.min(10_000, state.valueLength)) : undefined,
    checked: boolean(state.checked),
    selectedTextPresent: typeof state.selectedText === "string" ? state.selectedText.trim().length > 0 : undefined,
    selectedTextLength: typeof state.selectedText === "string" ? Math.min(1_000, state.selectedText.length) : undefined,
    invalid: boolean(state.invalid),
    autocompleteSelected: boolean(state.autocompleteSelected),
    autocompleteCandidates: typeof state.autocompleteCandidates === "number" ? Math.max(0, Math.min(100, state.autocompleteCandidates)) : undefined,
  };
}

function formsMarker(value: unknown): Array<JsonRecord> | undefined {
  if (!Array.isArray(value)) return undefined;
  const controls: Array<JsonRecord> = [];
  for (const form of value.slice(0, 20)) {
    const formRecord = record(form);
    if (!Array.isArray(formRecord?.controls)) continue;
    for (const control of formRecord.controls.slice(0, 80)) {
      const item = record(control);
      if (!item) continue;
      controls.push({
        id: bounded(item.id, 160),
        role: bounded(item.role, 40),
        name: bounded(item.name, 160),
        valuePresent: boolean(item.valuePresent),
        valueLength: typeof item.valueLength === "number" ? Math.max(0, Math.min(10_000, item.valueLength)) : undefined,
        checked: boolean(item.checked),
        selectedTextLength: typeof item.selectedText === "string" ? Math.min(1_000, item.selectedText.length) : undefined,
        invalid: boolean(item.invalid),
      });
    }
  }
  return controls.length ? controls : undefined;
}

/**
 * Build a stable, non-sensitive page-state marker for the agent run guard.
 *
 * This deliberately excludes screenshots, node IDs, raw page text, raw form
 * values, and timestamps. It retains only non-sensitive form shape/state
 * signals such as value lengths, checked state, and validation state, so a
 * long form can keep advancing without exposing credentials in the marker.
 */
export function browserRunProgressMarker(result: unknown, failure?: unknown): string {
  const root = record(result);
  const health = record(root?.health);
  const challenge = record(root?.challenge);
  const verification = record(root?.actionVerification);
  const agent = record(root?.agent);
  const marker = {
    url: bounded(root?.observedUrl ?? root?.url, 2_000),
    title: bounded(root?.title, 200),
    accessibilityHash: bounded(root?.accessibilityHash, 128),
    pageGeneration: typeof root?.pageGeneration === "number" ? root.pageGeneration : undefined,
    formState: formStateMarker(root?.formState),
    forms: formsMarker(root?.forms),
    submitted: boolean(root?.submitted),
    needsUserInteraction: boolean(root?.needsUserInteraction),
    challengeDetected: boolean(challenge?.detected),
    challengeType: bounded(challenge?.type, 80),
    verificationRequired: boolean(root?.verificationRequired),
    urlChanged: boolean(verification?.urlChanged),
    titleChanged: boolean(verification?.titleChanged),
    pageGenerationChanged: boolean(verification?.pageGenerationChanged),
    agentStoppedReason: bounded(agent?.stoppedReason, 80),
    healthStatus: bounded(health?.status, 80),
    failure: typeof failure === "string" ? failure.slice(0, 500) : undefined,
  };
  return JSON.stringify(marker);
}

export function browserRunHasProgress(previous: string | undefined, current: string): boolean {
  return Boolean(previous && previous !== current);
}
