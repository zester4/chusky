import { createHash } from "node:crypto";
import { isReadOnlyToolSlug, isRiskyToolSlug } from "../policy.js";
import type { OutcomeCheck } from "./contracts.js";
import type { OutcomeReadAdapter } from "./outcomeEngine.js";

const SECRET_FIELD = /token|secret|password|credential|cookie|authorization|private.?key/i;
const MAX_ARGUMENT_BYTES = 16_384;

function validateReadArguments(value: unknown, path = "arguments", depth = 0): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 6) throw new Error("Provider read arguments must be a bounded JSON object.");
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key)) throw new Error(`${path}.${key} is not allowed in a provider read check.`);
    if (depth >= 6 && item && typeof item === "object") throw new Error(`${path}.${key} exceeds the allowed nesting depth.`);
    if (item && typeof item === "object") {
      if (Array.isArray(item)) {
        if (item.length > 100) throw new Error(`${path}.${key} contains too many values.`);
        for (const [index, entry] of item.entries()) {
          if (entry && typeof entry === "object") validateReadArguments(entry, `${path}.${key}[${index}]`, depth + 1);
          else if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint" || entry === undefined) throw new Error(`${path}.${key}[${index}] is not JSON data.`);
        }
      } else validateReadArguments(item, `${path}.${key}`, depth + 1);
    } else if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint" || item === undefined) {
      throw new Error(`${path}.${key} is not JSON data.`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_ARGUMENT_BYTES) throw new Error("Provider read arguments exceed the 16 KB limit.");
}

function normalizeObserved(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (record.error !== undefined && record.error !== null && record.error !== false && record.error !== "") throw new Error("Provider reported an execution error.");
    if (record.successful === false || record.success === false) throw new Error("Provider reported an unsuccessful execution.");
    const data = record.data;
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
    if (Array.isArray(data)) return { items: data };
    return record;
  }
  if (Array.isArray(result)) return { items: result };
  return { value: result };
}

/**
 * Creates an outcome verifier that can only execute exact, currently available
 * read-only Composio actions. Provider output is captured as bounded evidence;
 * no write action is reachable through this adapter.
 */
export function createComposioOutcomeReadAdapter(input: {
  availableToolSlugs: readonly string[];
  allowedToolSlugs?: readonly string[];
  deniedToolSlugs?: readonly string[];
  execute: (toolSlug: string, args: Record<string, unknown>) => Promise<unknown>;
  now?: () => number;
}): OutcomeReadAdapter {
  const available = new Set(input.availableToolSlugs);
  const allowed = input.allowedToolSlugs ? new Set(input.allowedToolSlugs) : undefined;
  const denied = new Set(input.deniedToolSlugs ?? []);
  return {
    read: async ({ toolSlug, check }: { toolSlug: string; provider?: string; check: OutcomeCheck }) => {
      if (!available.has(toolSlug)) throw new Error("Provider read action is not available in this execution context.");
      if ((allowed && !allowed.has(toolSlug)) || denied.has(toolSlug)) throw new Error("Provider read action is not granted by the active tool policy.");
      if (!isReadOnlyToolSlug(toolSlug) || isRiskyToolSlug(toolSlug)) throw new Error("Provider outcome checks must use an exact read-only tool.");
      const args = check.arguments ?? {};
      validateReadArguments(args);
      const result = await input.execute(toolSlug, args);
      const observedAt = (input.now ?? Date.now)();
      const argumentsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 24);
      const provider = check.provider ?? toolSlug.split("_")[0]?.toLowerCase() ?? "composio";
      return { observed: normalizeObserved(result), provider, observedAt, evidenceRef: `composio-read:${toolSlug}:${argumentsHash}:${observedAt}` };
    },
  };
}
