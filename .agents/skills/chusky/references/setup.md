# Chusky Setup and Diagnostics

## Command contract

Use the built binary as the stable interface:

```text
chusky setup       collect or resume environment configuration
chusky doctor      report configured/missing settings and service health
chusky chat        open linked terminal chat
chusky telegram    run the Telegram service
chusky start       alias for the Telegram/webhook service
chusky auth link   pair a terminal device
```

Keep `npm run dev` and the `npm run *` development aliases for contributors, but make user documentation use the `chusky` commands after building and installing/linking.

## Setup behavior

The wizard must be safe to rerun. Read the existing `.env`, preserve comments and unrelated variables, show `[keep]` for existing values, and replace only values the user confirms. Collect required provider credentials first. Then ask for deployment mode and optional integrations; pressing Enter skips an optional integration. Generate missing webhook secrets locally, never display them, and write `.env` with restrictive permissions where the platform supports them.

Never write tokens to the CLI device config, shell history, logs, README, or Git. Ensure `.env` and `.env.*` remain ignored except `.env.example`.

## Doctor behavior

Doctor output is a status report, not a secret dump. It may report presence, mode, defaults, connectivity status, HTTP status, and actionable missing dependencies. It must not report values for tokens, Redis URLs, authorization links, or webhook secrets. Local checks work in polling mode; remote `/health` checks require `WEBHOOK_URL` and should use a timeout.

Treat missing Redis as a production warning because the application falls back to memory. Treat missing QStash/workflow URLs as a feature warning, not a failure, when the user intentionally skipped scheduling/video. Treat missing required provider keys as a blocking setup error.

## Dispatch and compatibility

The CLI command dispatcher must keep the default invocation compatible with existing `npm run cli` behavior: no command means `chat`. Service commands spawn the built `dist/index.js` in production and the TypeScript entrypoint only in development. Do not start both Telegram polling and terminal chat in one command; they are separate processes and share state through the deployed service.
