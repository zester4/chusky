export type ShoppingBrowserAction = "browse" | "search" | "add_to_cart" | "add_to_wishlist" | "add_to_watchlist" | "review_booking" | "review_service" | "review_subscription" | "checkout" | "book" | "place_order" | "purchase" | "change_plan" | "cancel";

const POLICY: Record<ShoppingBrowserAction, "auto" | "approval_required"> = {
  browse: "auto",
  search: "auto",
  add_to_cart: "auto",
  add_to_wishlist: "auto",
  add_to_watchlist: "auto",
  review_booking: "auto",
  review_service: "auto",
  review_subscription: "auto",
  checkout: "approval_required",
  book: "approval_required",
  place_order: "approval_required",
  purchase: "approval_required",
  change_plan: "approval_required",
  cancel: "approval_required",
};

export function shoppingActionPolicy(action: ShoppingBrowserAction): "auto" | "approval_required" { return POLICY[action]; }
