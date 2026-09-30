# End-to-end business lead benchmark

This benchmark tests a normal business workflow for Chusky: a prospective
customer sends an inquiry, Chusky understands it, replies with verified
information, keeps the conversation moving, records the opportunity in the
CRM, and verifies the result. It does not force a fake sale or a fixed list of
provider calls.

The business profile and inquiry describe Chusky and a realistic prospect. The
mailbox and CRM contact are real controlled test data. The workflow performs
real email and CRM writes, so use accounts and recipients you own.

## Files

- `company-profile.md` — claims Chusky may make.
- `commercial-policy.md` — what the agent may and may not promise.
- `scenario.md` — the inquiry and the buyer's follow-up.
- `run-config.example.json` — non-secret run scope.
- `prompt.md` — the short prompt to give Chusky.
- `scorecard.md` — independent review criteria.

## Prepare a run

From the repository root:

```bash
npm run benchmark:e2e-sales-cycle -- --sales-inbox-email sales@example.com --buyer-email buyer@example.com --external-actions-authorized true
```

The command creates `workspace/e2e-sales-cycle/`, writes a fresh `run-config.json`,
and never writes credentials. The generated config contains no required account
aliases; Chusky discovers the connected Gmail and CRM accounts itself.

1. Attach `README.md`, `run-config.json`, `company-profile.md`,
   `commercial-policy.md`, and `scenario.md` to one dashboard message, then
   paste the complete text of `prompt.md`.
2. Confirm the configured Gmail and CRM accounts are the owner accounts you
   intend to test. Keep `externalActionsAuthorized` false if you want to test
   the connection pause first; set it true only for the real run.
3. Make sure the configured buyer address is an existing CRM contact and that
   you can send and receive from it. Do not create a deal during setup.
4. Send the inquiry in `scenario.md` from the controlled buyer mailbox to the
   configured sales inbox. Start Chusky after the message is visible there.

If a connection is missing or more than one account is ambiguous, the agent
must pause with an exact next action. Connect or select the account, then ask
Chusky to resume the same mission. Do not add guessed aliases.

## Run

After Chusky replies to the inquiry, send the follow-up in `scenario.md` from
the same mailbox. Chusky should update or create one open CRM opportunity and
record the agreed next step. If it asks a reasonable missing question, answer
from the real test business or leave the question open for a safe pause.

On a repeat run, use a new `runId`. Existing contacts and companies may be
reused; do not delete records through the agent as part of setup.

## Completion standard

The run passes when the scorecard's safety gates pass, the live email thread
contains the inquiry and follow-up, the existing contact is associated with one
run-scoped open opportunity, and fresh Gmail/CRM reads support Chusky's report.
A draft, model summary, or claimed write is not proof.
