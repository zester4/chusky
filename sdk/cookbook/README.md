# Chusky SDK Cookbook

Each recipe is a complete, standalone TypeScript file. Every recipe creates
its own Chusky client so you can copy one into a server project without
importing a hidden client helper.

Set an API key created in the Chusky dashboard before running a recipe:

~~~bash
$env:CHUSKY_API_KEY = "chsk_..."
npx tsx cookbook/run-and-wait.ts
~~~

Check every recipe without making an API request:

~~~bash
npx tsc -p cookbook/tsconfig.json
~~~

The examples make real API requests. Use a development project, a test
identity, and an idempotency key that is unique to the operation.

## Recipes

| Recipe | Use it when |
| --- | --- |
| [run-and-wait.ts](run-and-wait.ts) | You need one bounded agent result |
| [streaming.ts](streaming.ts) | A UI should show progress and approval events |
| [company-agent.ts](company-agent.ts) | A company needs a governed specialist |
| [mission.ts](mission.ts) | Work has multiple steps, waits, and proof |
| [approvals.ts](approvals.ts) | A person must approve or deny a pending action |
| [context-and-department-handoff.ts](context-and-department-handoff.ts) | Teams need shared context and a typed handoff |
| [files-and-image-attachment.ts](files-and-image-attachment.ts) | Work starts with a document or image |
| [webhooks.ts](webhooks.ts) | Your server needs durable delivery notifications |
| [connect-business-app.ts](connect-business-app.ts) | A user must connect Gmail, HubSpot, or another app |
| [a2a-delegation.ts](a2a-delegation.ts) | One agent delegates durable work to another |
| [scheduled-follow-up.ts](scheduled-follow-up.ts) | A reminder or recurring job should continue later |
| [native-tool-health-check.ts](native-tool-health-check.ts) | You want to inspect or run one reliability capability |
| [workflow-composer.ts](workflow-composer.ts) | You want reusable dependency-aware stages |

Every recipe uses the same core configuration values:

- CHUSKY_API_KEY — an API key kept on the server.
- CHUSKY_USER_ID — optional; a stable application-owned identity.

The SDK uses the hosted Chusky API by default. Set `CHUSKY_BASE_URL` only when
targeting staging or a self-hosted API, and pass that value as `baseUrl` when
constructing a client.

Keep provider credentials, approval decisions, and file bytes on trusted
server boundaries. Read the run, task, or mission by ID after a timeout before
retrying.
