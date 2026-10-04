import assert from "node:assert/strict";
import test from "node:test";
import { parseMissionBackfillCommand } from "../src/missionBackfillCommand.js";

test("mission backfill keeps an unscoped dry run read-only", () => {
  assert.deepEqual(parseMissionBackfillCommand([]), { help: false, apply: false });
  assert.deepEqual(parseMissionBackfillCommand(["--user-id", "831236"]), { help: false, apply: false, userId: 831236 });
});

test("mission backfill apply requires quiescence confirmation and exactly one owner", () => {
  assert.throws(() => parseMissionBackfillCommand(["--apply", "--confirm-quiesced"]), /one explicit --user-id/);
  assert.deepEqual(parseMissionBackfillCommand(["--user-id", "831236", "--apply", "--confirm-quiesced"]), {
    help: false,
    apply: true,
    userId: 831236,
  });
  assert.throws(() => parseMissionBackfillCommand(["--apply"]), /both --apply and --confirm-quiesced/);
  assert.throws(() => parseMissionBackfillCommand(["--confirm-quiesced"]), /both --apply and --confirm-quiesced/);
});

test("mission backfill rejects malformed, duplicate, and unknown selectors", () => {
  assert.throws(() => parseMissionBackfillCommand(["--user-id", "-1"]), /non-negative safe integer/);
  assert.throws(() => parseMissionBackfillCommand(["--user-id", "9007199254740992"]), /safe integer/);
  assert.throws(() => parseMissionBackfillCommand(["--user-id", "1", "--user-id", "2"]), /only once/);
  assert.throws(() => parseMissionBackfillCommand(["--force"]), /Unknown mission backfill argument/);
  assert.throws(() => parseMissionBackfillCommand(["831236"]), /Unknown mission backfill argument/);
  assert.throws(() => parseMissionBackfillCommand(["--help", "--apply"]), /cannot be combined/);
});
