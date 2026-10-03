/** E2B-backed state for browser challenges and owner handoff. */
export const BROWSER_CHALLENGE_PROVIDERS = ["e2b", "owner"] as const;
export type BrowserChallengeProvider = typeof BROWSER_CHALLENGE_PROVIDERS[number];

export const BROWSER_CHALLENGE_TYPES = ["captcha", "two_factor", "age_verification", "site_challenge", "login", "user_requested"] as const;
export type BrowserChallengeType = typeof BROWSER_CHALLENGE_TYPES[number];

export const BROWSER_CHALLENGE_STATES = ["detected", "solving", "solved_unverified", "verified", "handoff_required", "expired", "blocked"] as const;
export type BrowserChallengeState = typeof BROWSER_CHALLENGE_STATES[number];

export type BrowserChallengeEvent = "detected" | "provider_solving_started" | "provider_solving_finished" | "owner_handoff_created" | "verification_passed" | "verification_failed" | "expired" | "blocked";

export type BrowserChallengeResolution = {
  provider: BrowserChallengeProvider;
  state: BrowserChallengeState;
  automatic: boolean;
  requiresOwner: boolean;
};

export function initialChallengeResolution(provider: BrowserChallengeProvider, automaticSolverAvailable = false): BrowserChallengeResolution {
  if (provider !== "owner" && automaticSolverAvailable) return { provider, state: "detected", automatic: true, requiresOwner: false };
  return { provider: provider === "owner" ? "owner" : provider, state: "handoff_required", automatic: false, requiresOwner: true };
}

export function transitionChallengeState(state: BrowserChallengeState, event: BrowserChallengeEvent): BrowserChallengeState {
  if (state === "expired" || state === "blocked" || state === "verified") return state;
  if (event === "expired") return "expired";
  if (event === "blocked") return "blocked";
  if (event === "detected") return state === "detected" ? state : "detected";
  if (event === "provider_solving_started") {
    if (state !== "detected") throw new Error(`Cannot start provider solving from ${state}`);
    return "solving";
  }
  if (event === "provider_solving_finished") {
    if (state !== "solving") throw new Error(`Cannot finish provider solving from ${state}`);
    return "solved_unverified";
  }
  if (event === "owner_handoff_created") return "handoff_required";
  if (event === "verification_passed") {
    if (state !== "solved_unverified" && state !== "handoff_required") throw new Error(`Cannot verify a challenge from ${state}`);
    return "verified";
  }
  return state;
}

export function normalizeChallengeProvider(value: unknown): BrowserChallengeProvider {
  const provider = String(value ?? "e2b").trim().toLowerCase();
  return (BROWSER_CHALLENGE_PROVIDERS as readonly string[]).includes(provider) ? provider as BrowserChallengeProvider : "e2b";
}

export function normalizeChallengeType(value: unknown): BrowserChallengeType {
  const type = String(value ?? "site_challenge").trim().toLowerCase();
  return (BROWSER_CHALLENGE_TYPES as readonly string[]).includes(type) ? type as BrowserChallengeType : "site_challenge";
}
