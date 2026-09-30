# Chusky benchmarks

These are repeatable scenarios for testing complete agent behavior with real,
owner-authorized tools. They use controlled mailboxes and CRM contacts, so
choose recipients and records deliberately.

## End-to-end business lead

Prepare a fresh local run with:

```bash
npm run benchmark:e2e-sales-cycle -- --sales-inbox-email sales@example.com --buyer-email buyer@example.com --external-actions-authorized true
```

The command writes `workspace/e2e-sales-cycle/run-config.json` with a unique
run ID and copies the scenario files there. It never writes credentials and it
does not require account aliases.

Open the Chusky dashboard chat and attach these five files from that folder:

1. `README.md`
2. `run-config.json`
3. `company-profile.md`
4. `commercial-policy.md`
5. `scenario.md`

Then paste the complete text of `prompt.md` as the single message. Keep
`scorecard.md` for independent review. The run discovers the active Gmail and
HubSpot accounts; if one is missing or ambiguous, it pauses with the exact
connection or selection action and resumes the same mission after repair.
