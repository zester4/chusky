export type BrowserPolicyAction =
  | "login" | "browse" | "search" | "add_to_cart" | "add_to_wishlist" | "checkout"
  | "place_order" | "purchase" | "change_address" | "add_payment_method" | "change_password"
  | "change_email" | "delete_account" | "download_sensitive" | "unknown";

export type BrowserPolicyDecision = "auto" | "approval_required" | "blocked";

export const BROWSER_ACTION_POLICY: Readonly<Record<BrowserPolicyAction, BrowserPolicyDecision>> = Object.freeze({
  login: "auto", browse: "auto", search: "auto", add_to_cart: "auto", add_to_wishlist: "auto",
  checkout: "approval_required", place_order: "approval_required", purchase: "approval_required",
  change_address: "approval_required", add_payment_method: "approval_required", download_sensitive: "approval_required",
  change_password: "blocked", change_email: "blocked", delete_account: "blocked", unknown: "approval_required",
});

export function browserActionPolicy(action: BrowserPolicyAction): BrowserPolicyDecision { return BROWSER_ACTION_POLICY[action]; }

export function classifyBrowserTarget(label: string): BrowserPolicyAction | undefined {
  const text = String(label ?? "").toLowerCase();
  if (/(delete (my )?account|close account)/.test(text)) return "delete_account";
  if (/(change password|reset password)/.test(text)) return "change_password";
  if (/(change email|update email)/.test(text)) return "change_email";
  if (/(add payment|new card|payment method)/.test(text)) return "add_payment_method";
  if (/(change address|edit address)/.test(text)) return "change_address";
  if (/(checkout|place order|buy now|pay now|complete purchase|subscribe|upgrade plan|pay invoice)/.test(text)) return "place_order";
  if (/(add to (cart|bag|basket))/.test(text)) return "add_to_cart";
  if (/(download|export).*(statement|invoice|report|data)/.test(text)) return "download_sensitive";
  return undefined;
}

export type BrowserPolicyInput = {
  action: string;
  targetLabel?: string;
  targetUrl?: string;
  ownerPrivateRun?: boolean;
  ownerApprovedAction?: boolean;
  vaultAction?: string;
};

export type BrowserPolicyResult = { action: BrowserPolicyAction; decision: BrowserPolicyDecision; reason: string };

export function evaluateBrowserAction(input: BrowserPolicyInput): BrowserPolicyResult {
  const explicit = input.vaultAction && input.vaultAction in BROWSER_ACTION_POLICY ? input.vaultAction as BrowserPolicyAction : undefined;
  const classified = classifyBrowserTarget(`${input.targetLabel ?? ""} ${input.targetUrl ?? ""}`);
  const direct = input.action in BROWSER_ACTION_POLICY ? input.action as BrowserPolicyAction : undefined;
  const action = explicit ?? classified ?? direct ?? (input.action === "open" || input.action === "navigate" ? "browse" : "unknown");
  const decision = browserActionPolicy(action);
  if (decision === "blocked") return { action, decision, reason: `${action} is blocked by the browser safety policy` };
  if (decision === "approval_required" && input.ownerPrivateRun && input.ownerApprovedAction && explicit === action) return { action, decision: "auto", reason: `${action} has a matching owner approval` };
  if (decision === "approval_required") return { action, decision, reason: `${action} requires an explicit matching approval` };
  return { action, decision, reason: `${action} is routine browser work` };
}
