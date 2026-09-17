# Enable, disable, status

## Tools

Use `CHUCK_ATTENTION_PULSE` with `action`:

| Action | Effect |
|--------|--------|
| `enable` | Create durable hourly job `pulse_{userId}` if missing |
| `disable` | Cancel all `kind: attention_pulse` jobs for the owner |
| `status` | Report whether pulse jobs are active |

Default schedule: hourly (`0 * * * *`) unless the owner specifies a valid cron.

## Enable checklist

1. Confirm owner intent (chat or `/home` control).
2. Call enable.
3. Prefer ensuring a Telegram `delivery_preference` exists (enabled, reasonable maxPerDay).
4. Confirm in plain language: pulse is on, cadence, that silence means nothing pending.

## Disable checklist

1. Confirm intent.
2. Call disable.
3. Confirm schedules cancelled. Attention *records* remain; only the scheduler stops.

## Status response

State clearly: enabled or not, job ids if useful, last delivery only if known.
Do not dump internal QStash identifiers unless debugging with the owner.

## Never

- Enable silently without owner intent
- Leave orphan schedules after disable
- Imply the pulse reads all email/chat continuously — it does not
