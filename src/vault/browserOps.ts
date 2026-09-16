import type { VaultAction } from "./policy.js";

export type BrowserRecipeStep = {
  role: "textbox" | "button" | "link" | "checkbox" | "combobox" | "any";
  name: string;
  nameMatch?: "exact" | "substring" | "regex";
  action: "find" | "fill" | "invoke" | "focus" | "verify" | "handoff";
  optional?: boolean;
};

export type BrowserDetector = {
  urlIncludes?: string;
  titleIncludes?: string;
  textIncludes?: string;
  required?: boolean;
};

export type BrowserTaskRecipe = {
  id: string;
  goal: string;
  action: VaultAction;
  steps: BrowserRecipeStep[];
  success: BrowserDetector[];
  lastVerifiedAt?: number;
};

export type BrowserPlaybookRecord = {
  id: string;
  userId: number;
  service: string;
  origin: string;
  accountAlias: string;
  login: {
    steps: BrowserRecipeStep[];
    success: BrowserDetector[];
    failure: BrowserDetector[];
    lastVerifiedAt?: number;
  };
  tasks: BrowserTaskRecipe[];
  version: number;
  successCount: number;
  failureCount: number;
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type BrowserAuditEvent =
  | "plan_created"
  | "session_health_checked"
  | "browser_action"
  | "verification_passed"
  | "verification_failed"
  | "handoff_requested"
  | "playbook_saved"
  | "playbook_used"
  | "session_revoked";

export type BrowserAuditRecord = {
  id: string;
  userId: number;
  event: BrowserAuditEvent;
  service?: string;
  origin?: string;
  playbookId?: string;
  action?: VaultAction;
  status: "started" | "succeeded" | "failed" | "blocked" | "waiting";
  summary: string;
  createdAt: number;
};

export type BrowserSessionHealth = {
  service: string;
  origin: string;
  workspaceId: string;
  status: "healthy" | "stale" | "expired" | "needs_reauth" | "logged_out" | "unknown";
  lastUsedAt?: number;
  expiresAt?: number;
  recommendedAction: "continue" | "recheck" | "login" | "handoff" | "none";
};

export type BrowserOperationPlan = {
  goal: string;
  origin?: string;
  action: VaultAction;
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
  stopBefore: string[];
  steps: string[];
  verification: BrowserDetector[];
  recovery: string[];
};

export type BrowserVerificationResult = {
  passed: boolean;
  matched: string[];
  missing: string[];
};

export function browserSessionIsRevoked(input: { status: string; expiresAt?: number }, now = Date.now()): boolean {
  return ["logged_out", "expired", "needs_reauth"].includes(input.status) || (input.status === "authenticated" && Boolean(input.expiresAt && input.expiresAt <= now));
}

function bounded(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${field} must be 1-${max} characters`);
  return value.trim();
}

export function normalizeBrowserOrigin(value: string): string {
  const url = new URL(bounded(value, 300, "origin"));
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("origin must be a clean HTTPS origin, such as https://www.example.com");
  return url.origin;
}

export function normalizeBrowserAlias(value: unknown): string {
  const alias = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "default";
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(alias)) throw new Error("accountAlias must use letters, numbers, dots, underscores, or hyphens");
  return alias;
}

export function classifyBrowserIntent(input: { label?: string; url?: string; role?: string } | string): VaultAction {
  const value = typeof input === "string" ? input : `${input.label ?? ""} ${input.url ?? ""} ${input.role ?? ""}`;
  const text = value.toLowerCase().replace(/[_-]+/g, " ");
  if (/(delete|close|terminate).*(account|workspace|organization)|delete account/.test(text)) return "delete_account";
  if (/(change|reset|update).*(password|passcode)|password.*(change|reset)/.test(text)) return "change_password";
  if (/(change|update).*(email|login email)/.test(text)) return "change_email";
  if (/(add|new|replace|update).*(payment|card|bank|billing)|payment.*method/.test(text)) return "add_payment_method";
  if (/(change|edit|update).*(address|shipping|delivery)/.test(text)) return "change_address";
  if (/(subscribe|subscription|upgrade|premium|plan|invoice|pay|checkout|place order|buy now|complete purchase)/.test(text)) return "place_order";
  if (/(add to|move to).*(cart|bag|basket)/.test(text)) return "add_to_cart";
  if (/(wishlist|wish list|save for later|favorite)/.test(text)) return "add_to_wishlist";
  if (/(search|find|filter|sort)/.test(text)) return "search";
  if (/(login|log in|sign in|authenticate)/.test(text)) return "login";
  if (/(download|export).*(statement|invoice|report|data)/.test(text)) return "download_sensitive";
  return "unknown";
}

export function browserActionRisk(action: VaultAction): BrowserOperationPlan["risk"] {
  if (["delete_account", "change_password", "change_email"].includes(action)) return "high";
  if (["place_order", "purchase", "checkout", "change_address", "add_payment_method", "download_sensitive"].includes(action)) return "high";
  if (["add_to_cart", "add_to_wishlist", "unknown"].includes(action)) return "medium";
  return "low";
}

export function createBrowserOperationPlan(goal: string, origin?: string, playbook?: BrowserPlaybookRecord): BrowserOperationPlan {
  const cleanGoal = bounded(goal, 1500, "goal");
  const action = /\b(cart|basket|bag)\b/.test(cleanGoal.toLowerCase()) && /stop before (payment|checkout|order)/i.test(cleanGoal)
    ? "add_to_cart"
    : classifyBrowserIntent({ label: cleanGoal, url: origin });
  const risk = browserActionRisk(action);
  const recipe = playbook?.tasks.find((task) => task.goal.toLowerCase() === cleanGoal.toLowerCase());
  const verification = recipe?.success ?? [];
  return {
    goal: cleanGoal,
    ...(origin ? { origin: normalizeBrowserOrigin(origin) } : {}),
    action,
    risk,
    requiresApproval: risk === "high" || action === "unknown",
    stopBefore: action === "place_order" || action === "checkout" || action === "purchase" || (action === "add_to_cart" && /stop before (payment|checkout|order)/i.test(cleanGoal))
      ? ["final payment or order submission", "any change to a payment method or delivery address"]
      : action === "unknown" ? ["the unclear control until the owner approves its exact purpose"] : [],
    steps: recipe?.steps.length ? recipe.steps.map((step) => `${step.action} ${step.role} '${step.name}'`) : [
      "Open only the verified HTTPS origin",
      "Inspect the current page and identify the intended accessible control",
      "Use find before fill or invoke",
      "Re-inspect after every navigation or consequential interaction",
      "Verify the result with URL, title, text, or a provider confirmation",
    ],
    verification,
    recovery: [
      "If the page is ambiguous, stop and request a private browser handoff",
      "If a login or session expires, use the saved identity and re-check the page",
      "Never repeat a non-idempotent action without verifying whether it already succeeded",
    ],
  };
}

export function verifyBrowserResult(input: { currentUrl?: string; title?: string; text?: string; detectors?: BrowserDetector[] }): BrowserVerificationResult {
  const currentUrl = input.currentUrl?.trim().toLowerCase() ?? "";
  const title = input.title?.trim().toLowerCase() ?? "";
  const text = input.text?.trim().toLowerCase() ?? "";
  const matched: string[] = [];
  const missing: string[] = [];
  for (const detector of (input.detectors ?? []).slice(0, 12)) {
    const checks = [
      detector.urlIncludes ? { label: `url contains '${detector.urlIncludes}'`, value: currentUrl, expected: detector.urlIncludes.toLowerCase() } : undefined,
      detector.titleIncludes ? { label: `title contains '${detector.titleIncludes}'`, value: title, expected: detector.titleIncludes.toLowerCase() } : undefined,
      detector.textIncludes ? { label: `page text contains '${detector.textIncludes}'`, value: text, expected: detector.textIncludes.toLowerCase() } : undefined,
    ].filter((check): check is { label: string; value: string; expected: string } => Boolean(check));
    if (!checks.length) continue;
    const hit = checks.some((check) => check.value.includes(check.expected));
    (hit ? matched : missing).push(...checks.map((check) => check.label));
  }
  const requiredCount = (input.detectors ?? []).filter((detector) => detector.required !== false && (detector.urlIncludes || detector.titleIncludes || detector.textIncludes)).length;
  const requiredMissing = (input.detectors ?? []).filter((detector) => detector.required !== false && (detector.urlIncludes || detector.titleIncludes || detector.textIncludes)).some((detector) => {
    return ![detector.urlIncludes && currentUrl.includes(detector.urlIncludes.toLowerCase()), detector.titleIncludes && title.includes(detector.titleIncludes.toLowerCase()), detector.textIncludes && text.includes(detector.textIncludes.toLowerCase())].some(Boolean);
  });
  return { passed: requiredCount === 0 || !requiredMissing, matched, missing };
}

export function sessionHealth(input: { service: string; origin: string; workspaceId: string; status: string; lastUsedAt?: number; expiresAt?: number }): BrowserSessionHealth {
  const now = Date.now();
  const expired = typeof input.expiresAt === "number" && input.expiresAt <= now;
  const status = expired ? "expired" : input.status === "authenticated" ? (input.lastUsedAt && now - input.lastUsedAt > 7 * 24 * 60 * 60_000 ? "stale" : "healthy") : input.status === "needs_reauth" ? "needs_reauth" : input.status === "logged_out" ? "logged_out" : "unknown";
  return {
    service: input.service,
    origin: input.origin,
    workspaceId: input.workspaceId,
    status,
    ...(input.lastUsedAt ? { lastUsedAt: input.lastUsedAt } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    recommendedAction: status === "healthy" ? "continue" : status === "stale" ? "recheck" : status === "expired" || status === "needs_reauth" ? "login" : status === "unknown" ? "handoff" : "none",
  };
}

export function normalizePlaybook(input: Omit<BrowserPlaybookRecord, "id" | "createdAt" | "updatedAt" | "version" | "successCount" | "failureCount"> & Partial<Pick<BrowserPlaybookRecord, "id" | "createdAt" | "updatedAt" | "version" | "successCount" | "failureCount">>): BrowserPlaybookRecord {
  const now = Date.now();
  const origin = normalizeBrowserOrigin(input.origin);
  const cleanSteps = (steps: BrowserRecipeStep[] | undefined, max: number) => (steps ?? []).slice(0, max).map((step) => ({ role: step.role, name: bounded(step.name, 160, "step.name"), nameMatch: step.nameMatch ?? "substring", action: step.action, ...(step.optional ? { optional: true } : {}) }));
  const cleanDetectors = (detectors: BrowserDetector[] | undefined) => (detectors ?? []).slice(0, 12).map((detector) => ({
    ...(detector.urlIncludes ? { urlIncludes: bounded(detector.urlIncludes, 300, "detector.urlIncludes") } : {}),
    ...(detector.titleIncludes ? { titleIncludes: bounded(detector.titleIncludes, 300, "detector.titleIncludes") } : {}),
    ...(detector.textIncludes ? { textIncludes: bounded(detector.textIncludes, 300, "detector.textIncludes") } : {}),
    ...(detector.required === false ? { required: false } : {}),
  }));
  if (!cleanSteps(input.login.steps, 20).length) throw new Error("login.steps must contain at least one step");
  return {
    id: input.id ?? `bp_${now}_${Math.random().toString(36).slice(2, 8)}`,
    userId: input.userId,
    service: bounded(input.service, 80, "service").toLowerCase(),
    origin,
    accountAlias: normalizeBrowserAlias(input.accountAlias),
    login: { steps: cleanSteps(input.login.steps, 20), success: cleanDetectors(input.login.success), failure: cleanDetectors(input.login.failure), ...(input.login.lastVerifiedAt ? { lastVerifiedAt: input.login.lastVerifiedAt } : {}) },
    tasks: (input.tasks ?? []).slice(0, 20).map((task) => ({ id: bounded(task.id, 80, "task.id"), goal: bounded(task.goal, 500, "task.goal"), action: task.action, steps: cleanSteps(task.steps, 40), success: cleanDetectors(task.success), ...(task.lastVerifiedAt ? { lastVerifiedAt: task.lastVerifiedAt } : {}) })),
    version: Math.max(1, Math.min(100, input.version ?? 1)),
    successCount: Math.max(0, Math.min(100000, input.successCount ?? 0)),
    failureCount: Math.max(0, Math.min(100000, input.failureCount ?? 0)),
    ...(input.lastUsedAt ? { lastUsedAt: input.lastUsedAt } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
}
