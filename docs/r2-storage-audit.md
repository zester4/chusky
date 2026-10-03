# R2 storage audit and migration plan

Updated: 2026-10-03

## Decision

Neon remains the authorization and metadata authority; R2 stores private object
bytes. Redis may cache bounded metadata but is not the canonical owner/object
catalog. Do not apply bucket-wide expiry or retention rules until every existing
prefix has an explicit data class and retention policy. Do not delete existing
objects during migration or backfill without an owner-scoped manifest and a
verified rollback path.

## Existing R2 paths

| Data/path | Current implementation | Metadata / access | Finding |
| --- | --- | --- | --- |
| Generated and imported images (`images/<owner>/...`) | `saveImageAsset`, `registerImageAsset` in `src/store.ts`; S3 operations in `src/lib/storage/r2.ts` | Image metadata is held in the session `assets` domain (Neon only when `DURABLE_STATE_ENABLED` is active; otherwise legacy Redis). Reads resolve metadata for the owner before issuing a 5-minute signed URL or server-side read. | Bytes already use R2; there is no dedicated normalized Neon object catalog, content hash, or expiry. Replacement cleanup is best effort and old metadata can be evicted by the 100-item cap. |
| Dashboard/SDK file uploads (`sdk/<owner>/...`) | `/v1/files` creates a signed upload intent; `/complete` checks `HeadObject` type and size in `src/sdkApi.ts` | `sdkFiles` live in the session `assets` domain; only `available` records are downloadable and owner identity comes from authenticated SDK context. | Upload verification and ownership exist. Intent expiry is five minutes, but stale intent records and rejected/unreferenced R2 objects do not have a complete cleanup job. No checksum or explicit retention metadata. |
| Channel and Telegram attachments (`channels/...`, `telegram/...`) | `src/channels/agentHandler.ts`, `src/handlers.ts`, `src/lib/storage/r2.ts` | Image attachments are registered as owner image assets; some document attachments are uploaded without a durable asset-catalog record. | R2 keeps bytes out of Redis, but the object inventory and cleanup coverage are inconsistent across attachment types. |
| Generated Sendblue media | `src/channels/sendblueMedia.ts` writes temporary objects and may issue a short-lived signed URL. | Delivery metadata is returned to the channel adapter; there is no general Neon retention record. | Temporary delivery objects need an explicit expiry/cleanup policy, not a permanent asset policy. |
| E2B browser files | `src/lib/e2b/browser.ts` uses R2 read/write/delete helpers. | Browser file metadata is owner/session scoped and checked before reads. | R2 is already the byte store; retention and durable normalized metadata need review alongside the browser-file lifecycle. |

## Large content that is not yet in R2

| Data | Current location and bounds | Required target |
| --- | --- | --- |
| Explicitly retained Recall transcript segments | Encrypted with AES-256-GCM in `src/store.ts`, then kept in Redis sorted sets with TTL, count and byte bounds. Retention requires owner opt-in for 1, 7, or 30 days. | Store encrypted segment objects in R2; keep owner/meeting/segment IDs, hash, size, expiry, and encryption version in Neon. Preserve opt-in, exact expiry, deduplication, deletion, and bounded search behavior. Never persist transcripts when retention was not explicitly requested. |
| Agent run checkpoints and tool results | `AgentRunRecord` is bounded and stored through the Redis backend; tool results are capped to 120 entries, run events to 200, and a record to 2 MB. | Keep compact state and summaries in Neon; archive oversized, non-resume-critical payloads to encrypted R2 with hash/size metadata. Do not archive credentials, raw authorization headers, or data that current retention policy says to discard. |
| Other model/provider outputs | Most paths compact or bound content before persistence, but there is no common object archive abstraction. | Classify by data sensitivity and owner-visible retention before moving any content. Keep short previews and object references in structured records. |

## Gaps and safety constraints

- `src/lib/storage/r2.ts` centralizes S3-compatible put/get/head/delete and signed
  URLs, but currently accepts raw keys and does not persist a common hash,
  retention, encryption-version, or lifecycle record.
- Existing signed download URLs are bearer credentials. Keep their lifetimes
  short and authorize ownership from Neon before signing; never expose R2 keys
  as an authorization mechanism.
- R2 lifecycle rules are prefix-based. Existing prefixes mix permanent user
  assets and temporary delivery objects, so a broad expiry rule is unsafe.
- Metadata and object writes span Neon and R2 and are not one transaction. New
  archive writes need idempotent object keys, durable pending/available/deleting
  states, checksum verification, and retryable orphan cleanup.
- The application already encrypts retained transcript segments before storage.
  Preserve authenticated encryption and key-version compatibility when moving
  ciphertext to R2; do not silently change the encryption key or retention clock.
- R2 upload completion currently validates declared type and size. A checksum,
  content sniffing/malware policy, quota, and stale-intent cleanup remain
  separate hardening items; successful `HeadObject` verification is not malware
  scanning.

## Ordered implementation slices

1. Add a migration for owner-scoped Neon object metadata, with uniqueness,
   lifecycle status, content hash, size/type, encryption version, expiry, and
   indexes for owner lookup and cleanup. Add optimistic/idempotent repository
   operations and tests before wiring payloads.
2. Add a private archive service on the existing R2 client: owner-scoped keys,
   application encryption for sensitive archives, streamed/bounded reads,
   SHA-256 verification, and short-lived signed access only after Neon
   authorization. Keep current media API contracts compatible.
3. Move explicitly retained Recall transcript segments first. Use one immutable
   object per segment to avoid rewriting a growing transcript blob; persist
   segment metadata and enforce the current count/byte/expiry bounds atomically.
   Keep zero-retention meeting text ephemeral and preserve owner deletion.
4. Archive only non-resume-critical oversized run/tool payloads. Keep compact
   worker checkpoints and recent trace tails available for restart and debugging.
5. Add a bounded retryable retention/orphan sweeper. Tombstone metadata before
   deletion, retry failed object deletes, and remove metadata only after object
   deletion is confirmed or the object is already absent.
6. Add dry-run inventory/backfill and parity checks for existing image/file
   records. Cut over one object class at a time; do not bulk-delete legacy keys.
7. Configure Cloudflare lifecycle rules only for isolated temporary prefixes
   after inventory proves the prefix contains no longer-retained objects.

## Verification gates

- Unit/integration tests cover owner isolation, duplicate uploads, partial
  Neon/R2 failures, checksum mismatch, expired access, retention expiry,
  explicit deletion, key rotation/version failure, retryable cleanup, and
  restart recovery.
- A live canary must upload a synthetic, non-user object, verify its Neon
  metadata and R2 checksum without reading/logging its payload, test owner
  denial and expiry, then delete only that canary object and metadata.
- Do not declare the R2 phase complete until every object class has a retention
  rule, a recoverable metadata record, and production parity evidence.

## Current status

The metadata foundation and the first integrated path are implemented on the
`codex/neon-durable-state` branch: migration `0008_neon_object_metadata.sql`
adds the owner-scoped catalog, and the SDK file upload/complete/download/delete
routes can use it behind `DURABLE_OBJECT_CATALOG_ENABLED`. The flag requires
`DURABLE_STATE_ENABLED` and fails startup if the object catalog migration is
missing. Completed uploads are hashed after the R2 size/type checks; deletion
persists a tombstone before deleting bytes so an interrupted delete can be
retried. Existing records are not automatically backfilled, so do not enable
the flag for production until a controlled backfill has populated metadata for
the existing SDK files. With the flag on, presigned uploads write only to a
temporary staging key; completion streams within the configured size limit,
hashes the bytes, copies them to a unique final key, then atomically changes
the Neon row from pending staging key to available final key. A still-valid
upload URL therefore cannot overwrite the object later authorized for download.
Concurrent completions use distinct final keys; only the first matching
pending-to-available Neon transition wins, and losing copies are cleaned up
best-effort. Staging cleanup can still leave an orphan if the process crashes,
so an expiry/orphan sweeper is required before broad rollout.

This is not the R2 phase completion: other image/file and attachment flows do
not yet write the catalog. Encrypted transcript/run-trace archival,
retention/orphan-cleanup workers, inventory/backfill tooling, production
migration, and a live R2 canary remain outstanding. No lifecycle expiry rules
are configured for user object prefixes.
