export type MissionProjectionStage = "validate" | "read_session" | "write_session";

export class MissionWebProjectionError extends Error {
  constructor(
    public readonly stage: MissionProjectionStage,
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MissionWebProjectionError";
  }
}

function sourceMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown projection error";
}

function retryableFor(stage: MissionProjectionStage, message: string): boolean {
  if (stage === "validate") return false;
  return !/(?:invalid|malformed|not found|does not exist|owner-scoped terminal mission)/i.test(message);
}

export function wrapMissionProjectionError(stage: MissionProjectionStage, error: unknown): MissionWebProjectionError {
  if (error instanceof MissionWebProjectionError) return error;
  const message = sourceMessage(error);
  return new MissionWebProjectionError(stage, message, retryableFor(stage, message), error instanceof Error ? { cause: error } : undefined);
}

function failureCode(message: string): string {
  if (/session mutation is busy|being migrated or saved concurrently|coordination lease/i.test(message)) return "session_lease_busy";
  if (/lost its coordination lease/i.test(message)) return "session_lease_lost";
  if (/domain version conflict|sdk run version conflict/i.test(message)) return "session_version_conflict";
  if (/(?:redis|ioredis|econn|etimedout|timeout|timed out|connection reset|connection refused|connect(?:ion)? failed)/i.test(message)) return "storage_transport";
  if (/(?:neon|postgres|database|query|transaction|durable storage)/i.test(message)) return "durable_storage";
  if (/valid owner-scoped terminal mission|invalid|malformed|not found/i.test(message)) return "invalid_projection_input";
  return "projection_error";
}

function safeMessage(error: unknown): string {
  return sourceMessage(error)
    .replace(/(?:rediss?|postgres(?:ql)?):\/\/\S+/gi, "[redacted-connection]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function missionProjectionFailureDetails(error: unknown): {
  errorType: string;
  errorCode: string;
  errorMessage: string;
  projectionStage: MissionProjectionStage | "unknown";
  retryable: boolean;
} {
  const typed = error instanceof MissionWebProjectionError ? error : undefined;
  const rawMessage = sourceMessage(error);
  const message = safeMessage(error);
  const code = failureCode(rawMessage);
  return {
    errorType: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "UnknownError",
    errorCode: code,
    errorMessage: message || "Unknown projection error",
    projectionStage: typed?.stage ?? "unknown",
    retryable: typed?.retryable ?? code !== "invalid_projection_input",
  };
}
