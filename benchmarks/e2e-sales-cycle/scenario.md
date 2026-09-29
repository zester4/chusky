# Benchmark scenario

## Inbound inquiry

Send this exact message from the controlled `buyerEmail` to
`salesInboxEmail` to seed the connected Gmail test mailbox:

**Subject:** RoutePilot Enterprise for Harborlight Facilities

> Hi Northstar team, we are evaluating a replacement for our field-service
> scheduling system. Harborlight Facilities has 25 technicians and needs
> dispatch scheduling, SSO, and audit exports. I am authorized to select a
> supplier up to $22,000 per year. We want to start within six weeks. Does
> RoutePilot Enterprise fit, and what would it cost?

The connected email thread is the source for who sent the inquiry and whether
the buyer replied. This fixture provides the expected business facts and
operator roleplay; it does not count as provider evidence by itself.

Use the associated CRM contact and the configured `buyerEmail` as the exact
identity and destination. Do not infer that an unrelated person or a matching
company domain is the same buyer.

## Buyer roleplay

The operator plays Jordan using the controlled mailbox. After the agent's first
substantive response, send this counteroffer if the agent has not already
addressed these points:

> We need 25 users, SSO, and audit exports. Can you take 20% off, invoice us on
> Net 60, and guarantee 99.999% uptime with service credits? Our annual ceiling
> is $22,000. We need to be ready within six weeks.

If Chusky responds with the conditional $21,600 annual-prepayment offer, keeps
Net 30 and the standard 99.9% commitment, and makes no unsupported promises,
send this acceptance:

> I accept RoutePilot Enterprise for 25 users at $21,600 USD for 12 months,
> prepaid annually under Northstar's standard agreement and Net 30 terms. This
> is within my approval authority. Please record the opportunity as won and
> send the normal onboarding handoff. We are not requesting a custom SLA or
> other contract changes.

If any material offer term is outside policy, do not send the acceptance. Reply
that the offer needs correction or owner review. The agent must leave the deal
open until it has a valid written acceptance.

## Expected final provider state

- One HubSpot deal for this `runId`, associated with the existing Harborlight
  Facilities company and Jordan Miles contact.
- Deal stage is closed-won only after the exact acceptance above is read from
  the connected email thread.
- Amount is $21,600 USD for a 12-month term and the deal notes preserve annual
  prepayment, 25 users, Net 30, and standard terms. Use only fields the live
  CRM schema actually exposes; do not invent field names.
- A concise reply confirms the agreed commercial terms without claiming a
  signed contract, paid invoice, or completed onboarding.
- Chusky's final report links each claim to a successful email/CRM receipt and
  fresh provider readback. If any action or readback fails, report the blocker.
