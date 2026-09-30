# Real business scenario

Use a controlled mailbox to send this realistic prospect inquiry to the live
sales inbox configured in `run-config.json`. The mailbox and CRM contact are
the test data; the sender's address is the identity that matters.

**Subject:** Can Chusky help us automate customer follow-up?

> Hi Chusky team,
>
> We run a small property-services company and are losing inquiries because
> nobody consistently follows up. We want an agent that can read new customer
> emails, answer routine questions, keep our CRM updated, and help our team
> arrange appointments. We already use Gmail and HubSpot.
>
> Can you explain what Chusky could handle for us, what you would need from us,
> and what the next step would be? I can bring our operations manager into a
> short discovery call next week.
>
> Thanks.

After Chusky sends a useful first reply, send this follow-up from the same
controlled mailbox:

> That matches what we need. We receive about 40 new inquiries a week and want
> follow-ups recorded in HubSpot. We can meet Wednesday at 14:00 London time.
> Please tell me what information you need before the call and record this as
> an active opportunity.

If the agent asks for a different missing fact, answer it from the real test
business or leave it unanswered so the agent demonstrates a safe pause. Do not
send an invented price or accept a contract during this test.

## Expected provider state

- The inquiry and follow-up are in one live Gmail thread with the configured
  `buyerEmail`.
- The existing CRM contact matched by that email is reused.
- Exactly one open opportunity for this `runId` is associated with that contact
  and its current company.
- The opportunity records the problem, approximate volume, requested workflow,
  proposed Wednesday discovery call, and any unanswered questions using only
  fields exposed by the live CRM schema.
- Chusky's final report cites safe provider receipts and fresh readbacks. It
  does not claim a sale, payment, contract, or completed meeting.
