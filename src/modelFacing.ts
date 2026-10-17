/**
 * Keep infrastructure/provider identifiers behind the model boundary.
 *
 * Internal tool slugs, environment variables, and implementation names are
 * still used for dispatch, persistence, policy, and diagnostics. The model
 * receives the capability contract instead: browser, computer, workspace,
 * and runtime. This prevents provider changes from changing agent behavior or
 * teaching the model to route by implementation brand.
 */
export function sanitizeModelFacingText(value: string): string {
  return String(value ?? "")
    // Canonical native tool aliases must be translated before the generic
    // provider replacements below.
    .replace(/\bCHUCK_DAYTONA_COMPUTER\b/gi, "CHUCK_COMPUTER")
    .replace(/\bCHUCK_DAYTONA_([A-Z0-9_]+)\b/gi, "CHUCK_COMPUTER_$1")
    // Do not expose provider-specific configuration knobs to the model.
    .replace(/\b(?:E2B|KERNEL|DAYTONA)_[A-Z0-9_]+\b/gi, "configured capability")
    .replace(/\bBROWSER_PROVIDER\s*=\s*[A-Za-z0-9_./-]+\b/gi, "configured browser provider")
    // Provider domains are implementation details too.
    .replace(/\b(?:e2b\.dev|e2b\.app|e2b-dev|onkernel\.com|kernel\.sh)\b/gi, "the browser service")
    // Phrase replacements keep the resulting capability language natural.
    .replace(/\bE2B\s*\/\s*Kernel(?:\s+browser)?\b/gi, "browser")
    .replace(/\bE2B\s+browser\b/gi, "browser")
    .replace(/\bKernel\s+browser\b/gi, "browser")
    .replace(/\bE2B\b/gi, "browser runtime")
    .replace(/\bKernel\b/gi, "managed browser runtime")
    // The provider replacements above are case-insensitive and also cover
    // lower-case identifiers in human-readable values.
    .replace(/\bDaytona\b/gi, "private computer");
}
