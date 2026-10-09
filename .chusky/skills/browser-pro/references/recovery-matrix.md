# Browser Pro recovery matrix

| Observed condition | Safe response | Resume condition |
| --- | --- | --- |
| `stale_observation` | observe again; rebuild selector | new observation ID and generation |
| field missing | inspect forms and accessibility | one unambiguous enabled control |
| custom dropdown | click, observe options, select exact option | selected state matches request |
| checkbox uncertain | use `check`/`uncheck` after fresh observe | checked state matches request |
| validation error | repair only named field | control valid and error cleared |
| page/context closed | health + diagnostics; reconnect/acquire | fresh page and checkpoint |
| detached iframe | discard locator; observe again | current frame/control returned |
| navigation timeout | idempotent fresh-tab retry | usable URL/title, not chrome-error |
| HTTP/2/network failure | bounded retry, diagnostics, classify | fresh page or external failure |
| CAPTCHA/human challenge | Kernel may wait for its provider solver; otherwise private handoff | fresh page is clear, not merely solver success |
| 2FA/passkey/OTP | private handoff; never request secret | same-origin detector passes |
| popup/native dialog | inspect tabs/dialogs before acting | intended page/control is fresh |
| unknown mutation result | stop and reconcile before retry | prior effect proven absent/present |
| payment/order control | stop at approval boundary | exact reviewed owner approval |

## Retry policy

Retry observations within their timeout budget. Retry navigation only when
idempotent and with fresh page state. Never blindly retry a click, submit,
add-to-cart, purchase, deletion, upload, or payment action. Inspect first.

## Evidence policy

An action succeeds only with an independent postcondition: final URL/title for
navigation; value/validity for fills; checked/selected state for controls;
cart URL/text and expected item for carts; order-review text for checkout;
confirmation ID or provider read-back for external submissions.
