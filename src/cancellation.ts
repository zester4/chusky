import { createHash } from "node:crypto";

/** A provider call stopped because its owning run was cancelled. */
export class CancellationError extends Error {
  readonly code = "cancelled";

  constructor(message = "The operation was cancelled.") {
    super(message);
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new CancellationError(signal.reason instanceof Error ? signal.reason.message : "The operation was cancelled.");
}

/**
 * Stop waiting for a provider promise as soon as the run is cancelled. The
 * provider still needs to honor its own AbortSignal to stop server-side work;
 * this wrapper guarantees Chusky will not continue using a late result.
 */
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new CancellationError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || error instanceof CancellationError || (error instanceof Error && error.name === "AbortError");
}

export interface SafeToolAudit {
  tool: string;
  userHash?: string;
  runId?: string;
  argumentKeys: string[];
  argumentCount: number;
  argumentBytes: number;
  redactedValues: true;
  auditRef: string;
  durationMs?: number;
  status?: "started" | "completed" | "failed" | "cancelled";
  result?: { requested?: boolean };
  error?: string;
}

function boundedJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "string") return item.slice(0, 512);
      return item;
    }).slice(0, 16_384);
  } catch {
    return String(value).slice(0, 16_384);
  }
}

/** Build audit metadata without retaining secrets, message text, or raw args. */
export function safeToolAudit(input: {
  tool: string;
  args?: unknown;
  userId?: number | string;
  runId?: string;
  startedAt?: number;
  status?: SafeToolAudit["status"];
  error?: unknown;
  requested?: boolean;
}): SafeToolAudit {
  const args = input.args && typeof input.args === "object" && !Array.isArray(input.args)
    ? input.args as Record<string, unknown>
    : {};
  const serialized = boundedJson(args);
  const keys = Object.keys(args).sort().slice(0, 100);
  const result: SafeToolAudit = {
    tool: input.tool.slice(0, 180),
    ...(input.userId !== undefined ? { userHash: createHash("sha256").update(`chusky-user:${input.userId}`).digest("hex").slice(0, 16) } : {}),
    ...(input.runId ? { runId: input.runId.slice(0, 180) } : {}),
    argumentKeys: keys,
    argumentCount: Object.keys(args).length,
    argumentBytes: Buffer.byteLength(serialized, "utf8"),
    redactedValues: true,
    auditRef: createHash("sha256").update(serialized).digest("hex").slice(0, 24),
    ...(input.startedAt !== undefined ? { durationMs: Math.max(0, Date.now() - input.startedAt) } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.requested ? { result: { requested: true } } : {}),
    ...(input.error !== undefined ? { error: String(input.error).slice(0, 500) } : {}),
  };
  return result;
}
