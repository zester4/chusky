# E-commerce & retail

Consume Jev's exact route first, then confirm the connected account and action
schema before any mutation. Verify inventory, cart, order, or payment state
from the provider; a successful tool call is not proof that the business state
changed. Use browser-pro only when the needed operation is genuinely UI-only.

| Prefer | Typical use |
|--------|-------------|
| `SHOPIFY_` | Orders, products, customers, inventory |
| `WIX_` | Store/site ops on Wix |
| `WOOCOMMERCE_` / Woo-related | WordPress commerce |
| `GUMROAD_` | Digital products, sales |
| `LEMON_SQUEEZY_` / `LEMONSQUEEZY_` | SaaS/digital checkout |
| `PAYSTACK_` | Payments (often with store flows) |
| `BASELINKER_` | Multi-channel commerce ops |
| `CLOUDCART_` | Cart/store management |

**Skill pairing:** launch-pro, billing-ops-pro, support-desk-pro, retention-pro.

If the storefront has no API toolkit, use the E2B browser + vault — not random Composio long-tail.
