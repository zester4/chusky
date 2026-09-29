# Chusky benchmarks

These are repeatable scenarios for testing complete agent behavior with real,
owner-authorized tools. They use fictional business data and require isolated
test accounts.

## End-to-end sales cycle

Prepare a fresh local run with:

```bash
npm run benchmark:e2e-sales-cycle -- --sales-inbox-email sales-test@example.com --buyer-email buyer-test@example.com
```

The command writes `workspace/e2e-sales-cycle/run-config.json` with a unique
run ID and copies the scenario files there. It never writes credentials.

Open the Chusky dashboard chat and attach these five files from that folder:

1. `README.md`
2. `run-config.json`
3. `company-profile.md`
4. `commercial-policy.md`
5. `scenario.md`

Then paste the complete text of `prompt.md` as the single message. Keep
`scorecard.md` for the operator's independent review. The run is intentionally
allowed to pause when Gmail or HubSpot is disconnected; connect the exact test
account and resume the same mission ID.
