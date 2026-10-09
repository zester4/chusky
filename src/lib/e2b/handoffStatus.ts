export type BrowserHandoffObservation = {
  needsUserInteraction?: unknown;
  challenge?: unknown;
};

/**
 * A handoff is not complete because the owner pressed "done". Completion is
 * safe only after a fresh observation shows that the website challenge is no
 * longer active. Keep this predicate small and provider-neutral: the browser
 * runtime remains responsible for detecting the challenge itself.
 */
export function browserChallengeStillActive(observed: BrowserHandoffObservation): boolean {
  if (observed.needsUserInteraction === true) return true;
  if (!observed.challenge || typeof observed.challenge !== "object") return false;
  return (observed.challenge as { detected?: unknown }).detected === true;
}
