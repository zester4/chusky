export type VaultAction = "login" | "browse" | "search" | "add_to_cart" | "add_to_wishlist" | "checkout" | "place_order" | "purchase" | "change_address" | "add_payment_method" | "change_password" | "change_email" | "delete_account";
export type VaultActionDecision = "auto" | "approval_required" | "blocked";

const POLICY: Record<VaultAction, VaultActionDecision> = {
  login: "auto", browse: "auto", search: "auto", add_to_cart: "auto", add_to_wishlist: "auto",
  checkout: "approval_required", place_order: "approval_required", purchase: "approval_required", change_address: "approval_required", add_payment_method: "approval_required",
  change_password: "blocked", change_email: "blocked", delete_account: "blocked",
};

export function vaultActionPolicy(action: VaultAction): VaultActionDecision { return POLICY[action]; }
export function safeVaultPolicy(): Record<VaultAction, VaultActionDecision> { return { ...POLICY }; }

/** Conservative UI interlock for retained authenticated browser sessions. */
export function classifyBrowserTarget(label: string): VaultAction | undefined {
  const text = label.toLowerCase();
  if (/(delete (my )?account|close account)/.test(text)) return "delete_account";
  if (/(change password|reset password)/.test(text)) return "change_password";
  if (/(change email|update email)/.test(text)) return "change_email";
  if (/(add payment|new card|payment method)/.test(text)) return "add_payment_method";
  if (/(change address|edit address)/.test(text)) return "change_address";
  if (/(checkout|place order|buy now|pay now|complete purchase)/.test(text)) return "place_order";
  if (/(add to (cart|bag|basket))/.test(text)) return "add_to_cart";
  return undefined;
}
