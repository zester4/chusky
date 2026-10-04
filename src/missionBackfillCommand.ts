export interface MissionBackfillCommandOptions {
  help: boolean;
  apply: boolean;
  userId?: number;
}

/** Parse the operator CLI before it opens Redis or Neon connections. */
export function parseMissionBackfillCommand(args: readonly string[]): MissionBackfillCommandOptions {
  let userArg: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--user-id") {
      if (userArg !== undefined) throw new Error("--user-id may be provided only once.");
      userArg = args[index + 1];
      if (!userArg || !/^\d+$/.test(userArg) || !Number.isSafeInteger(Number(userArg))) {
        throw new Error("--user-id must be a non-negative safe integer.");
      }
      index += 1;
      continue;
    }
    if (!["--help", "--apply", "--confirm-quiesced"].includes(argument)) {
      throw new Error(`Unknown mission backfill argument: ${argument}`);
    }
  }
  if (args.includes("--help")) {
    if (args.length !== 1) throw new Error("--help cannot be combined with migration options.");
    return { help: true, apply: false };
  }

  const apply = args.includes("--apply");
  const confirmedQuiesced = args.includes("--confirm-quiesced");
  if (apply !== confirmedQuiesced) {
    throw new Error("Migration writes require both --apply and --confirm-quiesced; omit both for a read-only dry run.");
  }

  const userId = userArg === undefined ? undefined : Number(userArg);
  if (apply && userId === undefined) {
    throw new Error("Apply requires one explicit --user-id; migrate and verify one owner per quiesced invocation.");
  }

  return { help: false, apply, ...(userId === undefined ? {} : { userId }) };
}
