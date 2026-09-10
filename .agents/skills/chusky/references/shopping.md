# Shopping Engine

Chusky shopping is a general website workflow. It must not be implemented as
Amazon-only logic or as a list of hard-coded login instructions.

## Components

- `src/shopping/shopping.ts`: validates requests, creates private durable
  shopping plans, selects retailers, updates constraints, and returns the next
  safe action for the agent.
- `src/shopping/retailers.ts`: a broad curated retailer starter catalogue for
  useful suggestions. It is not an allowlist: a user may select any clean HTTPS
  retailer through `CHUCK_SHOPPING_SELECT_RETAILER` with an explicit origin.
  It includes regional options across North America, the UK, Europe, Africa,
  India, and Australia—including Jumia Ghana—but availability is always
  confirmed on the retailer's own site.
- `src/shopping/policy.ts`: shopping action classification. Cart-building is
  autonomous; checkout, payment, and order placement remain approval-gated.
- `src/store.ts`: persists owner-scoped `shoppingRuns`. These records contain
  the shopping list, selection, budget, and workflow state only. Credentials,
  cookies, and payment data remain outside Redis in the vault/browser boundary.

## Agent flow

1. For a request such as “buy my groceries” or “find dog food”, call
   `CHUCK_SHOPPING_START` in a private conversation.
2. Ask only for details needed to make a decision: country/delivery area,
   retailer when there is a genuine choice, delivery or pickup, budget, and
   substitution preferences.
3. Use the returned suggestions as a starting point. For local or current
   options outside the starter catalogue, use live research and present concise
   choices; never claim current availability or prices without checking.
4. After the user chooses, call `CHUCK_SHOPPING_SELECT_RETAILER`.
5. Check the chosen website using `CHUCK_VAULT_LIST` or
   `CHUCK_VAULT_STATUS`. If not connected, use `CHUCK_VAULT_SAVE`; otherwise
   use `CHUCK_VAULT_LOGIN`.
6. Use `CHUCK_DAYTONA_BROWSER` to inspect, search, compare, and add items to
   the cart. Use accessibility-first interactions and verify every resulting
   page state.
7. Present cart total, delivery options, substitutions, and any uncertainty.
   Checkout, payment, and placing an order require the existing approval path.

## Human website steps without losing browser state

For CAPTCHA, 2FA/MFA, consent, age verification, or a website-only login step:

1. Call `CHUCK_SHOPPING_PAUSE` with its safe reason.
2. Call `CHUCK_DAYTONA_BROWSER_HANDOFF`. It issues a short-lived signed noVNC
   link to the **same retained Daytona desktop/browser**.
3. Deliver that bearer link only in the owner’s direct conversation. Never log
   it, store it in plan metadata, or put it in a group.
4. The user completes the step privately and replies “continue”.
5. Call `CHUCK_SHOPPING_RESUME`, inspect the current page, then continue. Do
   not retry a form submit or repeat a cart mutation blindly.

The link expires quickly (five minutes by default, bounded to 1–15 minutes).
It is not a credential export: Chusky's model never receives passwords,
cookies, authentication codes, or browser tokens.

## Screenshots and saved sites

- For “show me the browser” or “take a screenshot and do nothing else”, call
  `CHUCK_DAYTONA_BROWSER` with `action=screenshot`. The image is delivered
  through the private active channel; do not take another browser action.
- `CHUCK_SHOPPING_SAVE_SITE`, `CHUCK_SHOPPING_LIST_SITES`, and
  `CHUCK_SHOPPING_REMOVE_SITE` manage user-owned retailer preferences. A saved
  site holds only a name, clean HTTPS origin, and optional safe capability
  metadata. It is not a saved login; use the vault separately when needed.

## Safety and privacy

- Shopping plans are private account data. Do not create, list, or modify them
  in a shared/group conversation.
- Never ask for a retailer username, password, recovery code, cookie, or card
  number in chat. The vault setup form and trusted broker own credentials.
- Do not infer an address, payment method, retailer, or substitution policy.
- A cancelled plan cancels only Chusky's plan. It must not mutate an external
  cart, account, or order.
- CAPTCHA, MFA/2FA, age verification, and other user-only challenges pause the
  workflow and require the short-lived private browser handoff.

## Verification

- Test a named retailer and a custom clean HTTPS retailer.
- Test owner isolation, plan updates, cancellation, and old-session defaults.
- Test that schemas never accept secret or payment fields.
- Test that `add_to_cart` remains autonomous while checkout/order placement is
  approval-gated.
- Before a live rollout, run one browser cart-building flow with a test account
  and confirm that logs contain metadata only.
