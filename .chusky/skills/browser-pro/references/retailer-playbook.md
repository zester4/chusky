# Retailer and ordering playbook

Read this reference when the request involves a store, restaurant delivery,
groceries, a meal kit, a reservation, a cart, or checkout. It is a semantic
playbook, not a selector catalogue: use the live accessible tree and current
page evidence instead of hard-coded CSS or retailer DOM assumptions.

## Universal retailer state machine

Classify the site before acting:

```text
discover origin → public browse → location/account gate → search or menu
→ choose item/options → add to cart/bag → verify cart → checkout review
→ observe final order/payment control → stop for approval
```

Profiles in this playbook cover Domino's, DoorDash, Uber Eats, Instacart,
HelloFresh, OpenTable, Target, Walmart, Best Buy, Costco, and AT&T. They are
semantic routing cues, not fixed selectors.

For every state transition:

1. Observe the current page and identify the state from URL, title, accessible
   controls, and bounded visible text.
2. Prefer labels, roles, autocomplete semantics, and fresh observation metadata.
3. Re-observe after location selection, store/restaurant selection, option
   dialogs, add-to-cart, cart navigation, login, popup, redirect, or challenge.
4. Verify the business state, not just the click: selected address, item and
   options, quantity, cart line, delivery method, totals, and review details.
5. Treat a final control such as `Place order`, `Submit payment`, `Pay now`,
   `Confirm and pay`, `Order now`, or `Proceed to payment` as the approval
   boundary. Never click it merely because it is visible.

Public browsing comes before login when the site allows it. Ask for only the
missing decision that materially affects selection. Use the saved profile for
known owner preferences (for example delivery area, dietary choices, or size),
but do not invent an address, payment method, account, or substitution rule.

## Product retailers

General merchandise sites usually add a fulfillment decision that must be
verified before checkout: shipping, pickup, delivery, seller, warehouse, or
membership eligibility.

- Target and Walmart: resolve the delivery area or store, distinguish shipping,
  pickup, and delivery, then verify seller, variant, quantity, availability,
  cart line, and fulfillment estimate.
- Best Buy: inspect store or ZIP availability, model/configuration, fulfillment
  method, and membership/account gates before adding the item.
- Costco: expect warehouse or membership gates and product URLs that may not
  look like ordinary `/product` paths; use the accessible product name and
  current page evidence, then verify the cart line and quantity.
- AT&T and other device/carrier sites: treat plan, financing, trade-in,
  contract, credit check, and account changes as consequential choices. Verify
  each selected configuration and stop before any order, credit, or payment
  submission.

These are routing cues, not retailer-specific selectors. If the live page uses a
different label or layout, return to the universal state machine and re-observe.

## Food and delivery sites

Food-ordering sites commonly have a location gate, restaurant/store selection,
menu category, item customization, quantity, cart, delivery fees/tip, login,
and a final payment control. The reliable generic flow is:

`location → restaurant/store → menu item → required options → add → cart →
delivery details → total/review → final order control`

Treat an item customization modal as a new observation. Required options such
as size, crust, toppings, sides, temperature, or substitutions must be selected
and verified before adding. “Added” is not enough: inspect the cart and confirm
the line item and options. Do not silently add a subscription, tip, delivery
fee, or replacement item that the user did not authorize.

### Domino's

Domino's often starts with store/location selection, then exposes a menu with
product cards and customization dialogs. Expect the flow to be:

`location/ZIP → store → menu → product → size/crust/toppings → add to order
→ cart → checkout review → Place order/Pay now`

The menu, store selector, and customization controls can be rendered as
buttons, dialogs, links, or custom cards. Do not assume that a menu URL is
already an orderable product page. If reCAPTCHA or an account gate appears,
pause the same session and hand off to the owner.

### DoorDash and Uber Eats

These sites commonly require a delivery address before restaurants and menus
are stable. Select the address or service area first, then choose the restaurant,
item, required modifiers, and quantity. Reinspect after every modal and after
the cart opens. A restaurant page or menu screenshot is not an order; the cart
must show the selected items and estimated total.

### Instacart

Select the delivery area and retailer before searching products. Verify item
availability, quantity, substitutions, delivery window, fees, and cart totals.
Do not treat a search result or a retailer landing page as a prepared grocery
order. Login, address selection, and store choice may each trigger a challenge.

### HelloFresh and other meal kits

Distinguish a one-time meal selection from a recurring subscription. Verify
week/menu, dietary filters, servings, delivery date, price, and subscription
terms. Stop before any control that starts a subscription, confirms a plan, or
submits payment, even if the user asked to “order dinner.”

## Reservations

For OpenTable and similar services use:

`restaurant → date → time → party size → availability → reservation review`

The final `Confirm reservation`, `Book`, or equivalent control is a
consequential external write and remains approval-gated. Verify the restaurant,
date, time, party size, cancellation terms, and account before stopping.

## Challenges, login, and recovery

- CAPTCHA, Cloudflare verification, MFA, passkeys, age verification, and
  site-only consent require the private same-session handoff. Never solve or
  bypass them with a scripted click.
- If the site requires login before public browsing, use the owner-scoped vault
  flow; credentials never enter tool arguments or model context.
- `stale_observation`, detached frames, or changed custom controls require a
  fresh observation. Never replay the old node ID.
- If a cart mutation has an uncertain result, reconcile the current cart before
  retrying. Do not add a duplicate item because a previous click timed out.
- If the provider closes the page, retain diagnostics and checkpoint the last
  verified state before acquiring a fresh session.

## Required completion evidence

Report one of these states precisely:

- `discovered`: suitable site/item/menu found, no cart mutation verified;
- `prepared`: requested item/options added and cart contents verified;
- `review_ready`: checkout/review reached and final order/payment control is
  visible, but it was not clicked;
- `confirmed`: only after the owner-approved external action returns a provider
  confirmation or receipt.

Never call `prepared`, `review_ready`, or `confirmed` based only on a screenshot
or the agent's narration. Include the current URL/title, selected item/options,
cart/total evidence, challenge or login state, and the exact stop boundary.
