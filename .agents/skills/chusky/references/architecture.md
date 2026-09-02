# Chusky Architecture and Data Contracts

## Request lifecycle

1. Telegram delivers an update to grammY through polling or `/webhook`.
2. `guard()` verifies the allowlist and records the user's Telegram chat ID.
3. The handler enforces rate limits, creates an abort controller, and acquires the distributed user lock.
4. `runAgent()` reuses or restores the Composio ToolRouter session, obtains Composio tools, appends native schemas, and builds the OpenRouter message list.
5. The model either returns text or emits tool calls. Tool calls loop until a final response or `MAX_TOOL_ROUNDS`.
6. Risky tool calls persist an approval and stop before execution. Telegram callback approval resumes the request with exact tool/argument matching.
7. The handler persists a safe user label and assistant response, updates usage, edits the status message, sends generated media, and releases the lock.

CLI requests follow the same lifecycle through `/cli/chat` or `/cli/chat/stream`: the paired device resolves to the Telegram user ID, the server loads the same session, acquires the same distributed lock, calls `runAgent()`, persists the completed turn, and returns Markdown or an approval-required event. Provider credentials never leave the server.

Sendblue iMessage groups use a separate authorization and conversation scope. The
owner first links their private Sendblue identity, creates a short-lived code with
`/channel link sendblue-group` in Telegram, and sends `/link-group <code>` inside
the group from that linked number. Authorization defaults to all participants;
`/group-access owner` restricts use to the owner, `/group-access all` restores
participant access, and `/unlink-group` removes the authorization. Group history is
stored separately from the owner's private account history, and shared prompts
must not read or write account-only memory.

## Module contracts

### `agent.ts`

Own model inference, Composio session reuse, modality routing, retry behavior, tool execution, and approval boundaries. Do not put Telegram API calls or Redis implementation details here.

### `handlers.ts`

Own Telegram concerns only: filters, commands, status messages, callback buttons, media download orchestration, and user-facing errors. Do not add provider-specific API logic here.

### `store.ts`

Own persistence and atomic ownership checks. Any new durable entity needs a typed record, a normalized default for old Redis records, CRUD helpers, and tests for missing/expired/foreign records.

### `nativeTools.ts` and `agentTools.ts`

Keep schema and implementation in sync. Schema names are stable API identifiers. Validate again in implementation; model-generated JSON is untrusted input.

## Durable session shape

```ts
interface UserSession {
  model: string;
  history: Message[];
  summaries: string[];
  memories: MemoryFact[];
  scratchpad: Record<string, ScratchpadEntry>;
  approvals: ApprovalRecord[];
  reminders: ReminderRecord[];
  jobs: JobRecord[];
  triggerIds: string[];
  composioSessionId?: string;
  telegramChatId?: number;
  totalMessages: number;
  totalCost: number;
  createdAt: number;
  updatedAt: number;
}
```

When evolving this shape, use optional reads and defaults so old Redis JSON remains readable. Avoid destructive migrations in the message path.

## State transitions

### Approval

`pending → approved → consumed` or `pending → denied`; an expired pending record is never executable. Store exact serialized arguments and compare them before execution.

### Reminder

`scheduled → sent`, `scheduled → cancelled`, or `scheduled → failed`. The workflow must re-read state immediately before delivery.

### Recurring job

`active → cancelled`. The QStash schedule and local record must be treated as separate resources; cancellation should update the provider and record, and report partial failure clearly.

### Trigger event

`unseen → claimed`. Claim the event ID before Telegram delivery. A duplicate must return success without sending a second notification.

### CLI device

`unpaired → paired → active → revoked`. Pairing codes are single-use and expire. Device records contain only a token hash, owner ID, display name, timestamps, and optional revocation time. Revoked or unknown hashes are rejected before session access.

## Adding a native tool

1. Define a stable `CHUCK_*` schema in `agentTools.ts`.
2. Add strict implementation validation in `nativeTools.ts`.
3. Enforce ownership, authorization, idempotency, and bounded output.
4. Add a dispatch branch or native dispatcher case.
5. Add system-prompt instructions describing when to use it and when to ask questions.
6. Add success, invalid input, failure, duplicate, and unauthorized tests.
7. Document required environment variables and restart/deployment implications.
