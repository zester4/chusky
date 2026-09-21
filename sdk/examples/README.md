# SDK examples

These examples are server-side TypeScript programs. They call the real Chusky
Developer API; they are not mocks and they do not contain credentials.

## Run one

From the SDK directory:

```bash
npm install
export CHUSKY_API_KEY=chsk_...
export CHUSKY_USER_ID=example-user
npx tsx examples/quickstart.ts
```

PowerShell:

```powershell
$env:CHUSKY_API_KEY = "chsk_..."
$env:CHUSKY_USER_ID = "example-user"
npx tsx examples/quickstart.ts
```

Set `CHUSKY_BASE_URL` when using a self-hosted or staging API. Use a test
project key and test identity. Some examples create durable state, upload a
file, register a webhook, or display an approval; review the source before
running them against production.

The `_client.ts` helper creates the authenticated SDK client. Each example can
also be copied into an application and inlined without depending on the helper.
