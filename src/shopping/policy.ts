export type ShoppingBrowserAction = "browse" | "search" | "add_to_cart" | "add_to_wishlist" | "checkout" | "place_order" | "purchase";

const POLICY: Record<ShoppingBrowserAction, "auto" | "approval_required"> = {
  browse: "auto",
  search: "auto",
  add_to_cart: "auto",
  add_to_wishlist: "auto",
  checkout: "approval_required",
  place_order: "approval_required",
  purchase: "approval_required",
};

export function shoppingActionPolicy(action: ShoppingBrowserAction): "auto" | "approval_required" { return POLICY[action]; }
