# Chusky pricing

**Finalized launch pricing:** 22 October 2026

Chusky is an agentic business operating system, not only a chatbot or a phone
service. The subscription covers the agent runtime, connected tools, durable
work, missions, tasks, triggers, reminders, memory, meetings, and voice. Usage
limits protect reliability and provider costs without removing access to the
tool catalogue.

## Bundled plans

These are the customer-facing plans. Each plan includes the agentic platform,
meeting capability, and voice capability in one subscription.

| Plan | Monthly price | Users | Active missions | Agent actions | Meeting hours | Voice minutes | Phone numbers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Hobby | **$79** | 1 | 2 | 2,500 | 1 | 30 | 1 |
| Starter | **$199** | 1 | 5 | 10,000 | 3 | 100 | 1 |
| Business | **$449** | 5 | 50 | 50,000 | 10 | 300 | 3 |
| Growth | **$899** | 15 | 200 | 200,000 | 30 | 1,000 | 10 |
| Scale | **$1,499** | 30 | 500 | 500,000 | 100 | 3,000 | 25 |

### Included in every plan

- Chat with Chusky through the supported product channels.
- Access to the full Chusky and connected-app tool catalogue, including more
  than 6,000 discoverable tools where the customer's connected account and
  permissions allow the action.
- Mission execution with durable checkpoints, scheduled wake-ups, retries,
  approvals, recovery, and completion evidence.
- Tasks, reminders, triggers, recurring checks, and notifications.
- Memory, context, research, enrichment, and connected-app orchestration.
- Meeting participation, transcription, notes, action items, and follow-up
  preparation within the included meeting allowance.
- Voice calls, transcripts, outcomes, tool calls, and call follow-ups within
  the included voice allowance.
- Account-scoped history, usage records, and billing receipts.

The plan limits are usage allowances, not a list of tools the agent is allowed
to see. Tool execution remains governed by the customer's connection,
permissions, approvals, provider availability, and safety policies.

## Component-only reference prices

Customers who do not need the full bundle may purchase an individual product
surface. These prices are reference add-on prices; the bundled plans provide a
better effective rate.

### Agentic platform

Includes chat, tools, missions, tasks, triggers, reminders, memory, connected
apps, research, enrichment, and durable follow-up work.

| Component plan | Monthly price | Included |
| --- | ---: | --- |
| Agent Starter | **$99** | 1 user, 10 active missions, 10,000 agent actions |
| Agent Business | **$249** | 5 users, 50 active missions, 50,000 agent actions |
| Agent Scale | **$599** | 15 users, 200 active missions, 200,000 agent actions |

### Meetings

Includes Google Meet, Zoom, Microsoft Teams, and Webex participation, subject
to the provider's access and bot-participation requirements.

| Component plan | Monthly price | Included |
| --- | ---: | ---: |
| Meetings Starter | **$149** | 10 meeting hours |
| Meetings Business | **$299** | 30 meeting hours |
| Meetings Scale | **$599** | 100 meeting hours |

Meeting features include live participation where supported, transcription,
notes, action items, follow-up tasks, and scheduling assistance. A meeting is
not marked complete until the provider result and stored meeting artifacts are
verified.

### Voice

| Component plan | Monthly price | Included |
| --- | ---: | --- |
| Voice Starter | **$79** | 1 phone number and 200 standard voice minutes |
| Voice Business | **$199** | 3 phone numbers and 1,000 standard voice minutes |
| Voice Scale | **$499** | 10 phone numbers and 3,000 standard voice minutes |

The bundled plans have smaller included allowances because the agentic,
meeting, and voice capabilities are combined at a discounted price.

## Usage and overages

### Agent actions

An agent action is a metered unit of meaningful agent execution, such as a
model-mediated connected-app action, native action, research operation, or
durable mission continuation. Simple interface rendering and passive history
reads should not consume an agent action.

The exact accounting event is recorded in the usage ledger with the run,
mission, provider, and idempotency key. Retries of the same provider action do
not create duplicate billable usage when the provider operation is idempotent
or has already produced a durable receipt.

The initial launch should not expose a confusing per-tool-call price. Included
agent actions are the protection against abuse; heavy customers should move to
the next plan or receive a negotiated usage allowance.

### Voice

Reference overage pricing:

- Standard US and Canada destinations: approximately **$0.18/minute**.
- UK, France, Germany, and Ireland: approximately **$0.22–$0.25/minute**.
- Higher-cost destinations: a live destination rate is shown before the call.

Voice usage is calculated from provider-billed duration and the verified call
record. Duplicate status callbacks never create duplicate usage charges.

The previously discussed `$0.0188/minute` figure is not the full voice cost. It
only represents an example Twilio plus Deepgram estimate. True voice cost also
includes the language model, text-to-speech, infrastructure, retries, storage,
and payment costs.

### Meetings

Reference meeting overage pricing is **$0.40–$0.60/minute**, depending on live
participation, transcription mode, speech generation, provider fees, and the
selected model. The exact rate should be shown before an account exceeds its
included allowance.

### Phone numbers

- Standard additional number: approximately **$2.99/month**.
- Only numbers with a carrier rental cost at or below the configured **$2.00**
  inventory threshold are displayed for purchase.
- Toll-free inventory is excluded from the initial launch.
- Spain, Sweden, Italy, Denmark, and Norway remain excluded from the supported
  inventory until their regulatory and cost requirements are separately
  approved.
- Country, number type, carrier, taxes, and regulatory requirements can change
  the final price.

The displayed number price must be tied to the purchased number and provider
receipt. A provider price change must never silently create a loss or an
unexpected customer charge: the account receives notice and the renewal price
is re-quoted before any changed renewal is collected.

## Billing rules

The billing system must enforce these rules:

1. Subscription billing is charged monthly through the configured payment
   provider.
2. Included allowances reset at the start of each billing period. Unused
   allowances do not roll over at launch.
3. Metered overages are recorded in an immutable, account-scoped usage ledger
   and invoiced only once using idempotent event keys.
4. A phone-number rental is active only while the number record is active and
   the provider confirms the number is assigned.
5. Releasing a number immediately stops future renewal billing. No renewal may
   be created after the release timestamp.
6. A release, cancellation, provider failure, or duplicate webhook must be
   safe to retry and must not create a second charge or a second release.
7. Failed payments enter a visible retry and grace-period state. The system
   must not silently delete data or release a customer's number without the
   published cancellation policy and required notice.
8. Taxes and legally required fees are calculated and displayed separately
   where applicable.
9. Customers can view invoices, number rentals, voice usage, meeting usage,
   agent usage, payment status, cancellations, and receipts.
10. Customer billing remains disabled until payment, renewal, cancellation,
    number-release, and failed-payment flows are externally verified.

## Cost model and pricing guardrail

The pricing engine must calculate the actual cost of a workload from the
provider receipts and configured model rates:

```text
true cost =
  Twilio transport and number rental
  + Deepgram transcription
  + text-to-speech
  + language-model input and output tokens
  + Composio or other connected-provider charges
  + Redis, QStash, Neon, storage, and bandwidth
  + payment processing and applicable taxes
```

The `$0.0188/minute` example must never be treated as the complete cost of a
voice interaction. Pricing and plan allowances should be reviewed against
measured production-like workloads, with a target gross margin of at least
60% before sales, support, tax, and exceptional provider costs.

Provider rates are not hardcoded as permanent truth. Twilio, Deepgram, model,
meeting, and integration pricing must be versioned, refreshed, and audited;
customer-facing quotes must use the current verified rate for the requested
destination or operation.

## Launch positioning

**Business at $449/month** is the recommended primary plan for companies. It
offers enough mission, meeting, voice, and agent capacity to demonstrate the
complete Chusky value proposition without promising unlimited work or hiding
variable provider costs.

Hobby and Starter are acquisition plans. Growth and Scale are for teams whose
agent is running meaningful business operations every day. Enterprise pricing
should be negotiated when a customer needs dedicated capacity, custom limits,
service commitments, or additional regulatory controls.
