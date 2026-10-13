import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { MonidSpendReservation } from "./types.js";
import type { MonidRunReceipt, MonidRunState } from "./types.js";
import type { MonidSpendGuard } from "./spend.js";

const MONID_API_BASE = "https://api.monid.ai";
const MAX_INPUT_BYTES = 32_000;
const MAX_OUTPUT_CHARS = 24_000;
const SENSITIVE_KEY = /(?:password|passwd|secret|token|credential|authorization|cookie|api[_-]?key)/i;

export interface MonidGatewayDeps {
  spend: MonidSpendGuard;
  saveReceipt(receipt: MonidRunReceipt): Promise<void>;
  listReceipts(userId: number, limit: number, organizationId?: string): Promise<MonidRunReceipt[]>;
  recordMissionEvidence?: (input: { userId: number; missionId: string; receipt: MonidRunReceipt; resultHash: string }) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

class MonidApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "MonidApiError"; }
}

function boundedText(value: unknown, max = 500): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]").replace(/\bmonid_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gi, "[redacted Monid key]").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested result omitted]";
  if (typeof value === "string") return boundedText(value, 8_000);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeValue(item, depth + 1));
  if (!value || typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    if (SENSITIVE_KEY.test(key)) continue;
    result[boundedText(key, 120)] = safeValue(item, depth + 1);
  }
  return result;
}

function boundedResult(value: unknown): unknown {
  const safe = safeValue(value);
  let encoded = "";
  try { encoded = JSON.stringify(safe) ?? "null"; } catch { return "[Monid result could not be serialized]"; }
  if (encoded.length <= MAX_OUTPUT_CHARS) return safe;
  return { truncated: true, preview: encoded.slice(0, MAX_OUTPUT_CHARS) };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function validateInput(value: unknown): Record<string, unknown> {
  const input = objectValue(value, "Monid input");
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, "utf8") > MAX_INPUT_BYTES) throw new Error(`Monid input must be at most ${MAX_INPUT_BYTES} bytes.`);
  const visit = (item: unknown, depth: number): void => {
    if (depth > 8) throw new Error("Monid input is nested too deeply.");
    if (Array.isArray(item)) {
      if (item.length > 50) throw new Error("Monid input arrays are limited to 50 items each; use small result limits to control costs.");
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (item && typeof item === "object") {
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length > 100) throw new Error("Monid input objects are limited to 100 fields.");
      for (const [key, child] of entries) {
        if (SENSITIVE_KEY.test(key)) throw new Error(`Monid input field '${boundedText(key, 80)}' looks like a credential field and is not allowed.`);
        visit(child, depth + 1);
      }
    }
  };
  visit(input, 0);
  return input;
}

function perResultExposure(input: Record<string, unknown>, unitPriceUsd: number, flatFeeUsd: number): number {
  const limitKeys = new Set(["maxitems", "maxresults", "resultslimit", "limit", "pagesize", "numresults"]);
  let resultLimit: number | undefined;
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (value.length > 1) throw new Error("Monid PER_RESULT endpoints accept at most one item in each input array to prevent multiplied per-result charges.");
      for (const child of value) inspect(child);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (limitKeys.has(key.toLowerCase().replace(/[_-]/g, "")) && typeof child === "number") {
        if (!Number.isSafeInteger(child) || child < 1 || child > 10) throw new Error("For Monid PER_RESULT endpoints, result limits must be whole numbers from 1 to 10.");
        resultLimit = Math.max(resultLimit ?? 0, child);
      }
      inspect(child);
    }
  };
  inspect(input);
  if (resultLimit === undefined) throw new Error("Monid PER_RESULT endpoints require an explicit result limit (1-10) in the inspected input schema.");
  return flatFeeUsd + unitPriceUsd * resultLimit;
}

function endpointArgs(providerValue: unknown, endpointValue: unknown): { provider: string; endpoint: string } {
  const provider = boundedText(providerValue, 64).toLowerCase();
  const endpoint = boundedText(endpointValue, 300);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider)) throw new Error("Monid provider must be a valid provider slug.");
  if (!endpoint.startsWith("/") || endpoint.length < 2 || /[?#\\]/.test(endpoint) || /(?:^|\/)\.\.?\//.test(endpoint)) throw new Error("Monid endpoint must be a catalog path beginning with /.");
  return { provider, endpoint };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("Monid response exceeded the 2 MB safety limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Monid response exceeded the size limit.");
        throw new Error("Monid response exceeded the 2 MB safety limit.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function costUsd(row: Record<string, unknown>): number | undefined {
  const cost = isRecord(row.cost) ? row.cost : undefined;
  const direct = cost ? numberAt(cost.value) : undefined;
  if (direct !== undefined) return direct;
  const billing = isRecord(row.billing) ? row.billing : undefined;
  const actual = billing && isRecord(billing.actualCost) ? billing.actualCost : undefined;
  const amount = actual ? numberAt(actual.value) : undefined;
  if (amount === undefined) return undefined;
  return String(actual?.unit ?? "").toUpperCase() === "MICRO_DOLLAR" ? amount / 1_000_000 : amount;
}

function normalizeState(value: unknown): MonidRunState {
  const status = String(value ?? "").toUpperCase();
  if (status === "READY" || status === "RUNNING" || status === "STOPPING") return "running";
  if (status === "COMPLETED") return "completed";
  if (status === "FAILED") return "failed";
  if (status === "BLOCKED") return "blocked";
  if (status === "STOPPED") return "stopped";
  if (status === "TIMED_OUT") return "timed_out";
  return "uncertain";
}

function runSummary(row: Record<string, unknown>): Record<string, unknown> {
  const providerResponse = isRecord(row.providerResponse) ? row.providerResponse : {};
  const price = isRecord(row.price) ? row.price : undefined;
  const cost = isRecord(row.cost) ? row.cost : undefined;
  const output = row.output === undefined ? undefined : boundedResult(row.output);
  return {
    ...(typeof row.runId === "string" ? { runId: boundedText(row.runId, 100) } : {}),
    ...(typeof row.provider === "string" ? { provider: boundedText(row.provider, 64) } : {}),
    ...(typeof row.endpoint === "string" ? { endpoint: boundedText(row.endpoint, 300) } : {}),
    status: boundedText(row.status, 40).toUpperCase() || "UNKNOWN",
    ...(typeof providerResponse.httpStatus === "number" ? { providerHttpStatus: providerResponse.httpStatus } : {}),
    ...(price ? { price: safeValue(price) } : {}),
    ...(cost ? { cost: safeValue(cost) } : {}),
    ...(typeof row.resultCount === "number" ? { resultCount: row.resultCount } : {}),
    ...(typeof row.createdAt === "string" ? { createdAt: boundedText(row.createdAt, 80) } : {}),
    ...(typeof row.completedAt === "string" ? { completedAt: boundedText(row.completedAt, 80) } : {}),
    ...(typeof row.stoppable === "boolean" ? { stoppable: row.stoppable } : {}),
    ...(row.controls !== undefined ? { controls: boundedResult(row.controls) } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(providerResponse.error !== undefined ? { providerError: boundedResult(providerResponse.error) } : {}),
  };
}

export class MonidGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: MonidGatewayDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private token(organizationId?: string): string {
    if (organizationId && !/^org_[A-Za-z0-9_-]{1,120}$/.test(organizationId)) throw new Error("Invalid Chusky organization scope for Monid.");
    const token = (organizationId ? config.monidOrganizationTokens[organizationId] : undefined) ?? config.monidApiKey;
    if (!token) throw new Error("Monid is enabled but no server-side MONID_API_KEY (or organization key) is configured.");
    return token;
  }

  private async request(method: "GET" | "POST", path: string, organizationId?: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    if (!config.monidEnabled) throw new Error("Monid is disabled.");
    const token = this.token(organizationId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Monid request timed out")), config.monidTimeoutMs);
    try {
      const response = await this.fetchImpl(`${MONID_API_BASE}${path}`, {
        method,
        headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
      });
      const text = await readBoundedResponse(response, 2_000_000);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      if (!isRecord(parsed)) {
        if (!response.ok) throw new MonidApiError(`Monid returned HTTP ${response.status} without a valid JSON response.`, response.status);
        throw new MonidApiError("Monid returned a non-JSON response.", response.status);
      }
      if (!response.ok) {
        const message = boundedText(parsed.message ?? parsed.error ?? parsed.code ?? `HTTP ${response.status}`);
        throw new MonidApiError(`Monid request failed (${response.status}): ${message}`, response.status);
      }
      return { status: response.status, data: parsed };
    } finally { clearTimeout(timer); }
  }

  async discover(queryInput: string, limitInput = 5, organizationId?: string): Promise<unknown> {
    const query = boundedText(queryInput, 500);
    if (!query) throw new Error("Provide a short Monid capability query.");
    const limit = Math.max(1, Math.min(10, Math.floor(limitInput)));
    const { data } = await this.request("POST", "/v1/discover", organizationId, { query, limit });
    const results = Array.isArray(data.results) ? data.results.slice(0, limit).filter(isRecord).map((row) => ({
      ...(typeof row.provider === "string" ? { provider: boundedText(row.provider, 64) } : {}),
      ...(typeof row.providerName === "string" ? { providerName: boundedText(row.providerName, 120) } : {}),
      ...(typeof row.endpoint === "string" ? { endpoint: boundedText(row.endpoint, 300) } : {}),
      ...(typeof row.description === "string" ? { description: boundedText(row.description, 1_000) } : {}),
      ...(row.price !== undefined ? { price: safeValue(row.price) } : {}),
      ...(row.metrics !== undefined ? { metrics: safeValue(row.metrics) } : {}),
      ...(row.verified !== undefined ? { verified: row.verified === true } : {}),
      ...(row.hints !== undefined ? { hints: boundedResult(row.hints) } : {}),
    })) : [];
    return { query, results, count: results.length };
  }

  async inspect(providerInput: unknown, endpointInput: unknown, organizationId?: string): Promise<unknown> {
    const { provider, endpoint } = endpointArgs(providerInput, endpointInput);
    const { data } = await this.request("POST", "/v1/inspect", organizationId, { provider, endpoint });
    return boundedResult({
      id: data.id, provider: data.provider ?? provider, providerName: data.providerName, endpoint: data.endpoint ?? endpoint,
      description: data.description, summary: data.summary, inputSchema: data.inputSchema, price: data.price ?? data.pricing, pricing: data.pricing,
      docUrl: data.docUrl, notes: data.notes, usage: data.usage, metrics: data.metrics, verified: data.verified, hints: data.hints,
    });
  }

  async run(options: { userId: number; provider: unknown; endpoint: unknown; input: unknown; maxSpendUsd?: number; missionId?: string; organizationId?: string }): Promise<unknown> {
    if (!config.monidEnabled) throw new Error("Monid is disabled.");
    const { provider, endpoint } = endpointArgs(options.provider, options.endpoint);
    const input = validateInput(options.input);
    const inspected = await this.inspect(provider, endpoint, options.organizationId);
    const inspectedRow = isRecord(inspected) ? inspected : {};
    const price = isRecord(inspectedRow.pricing) ? inspectedRow.pricing : isRecord(inspectedRow.price) ? inspectedRow.price : {};
    const priceType = String(price.type ?? price.model ?? "").toUpperCase();
    const listedPrice = numberAt(price.amount) ?? numberAt(price.unitPrice);
    const flatFee = numberAt(price.flatFee) ?? 0;
    const requestedCap = options.maxSpendUsd;
    let estimateUsd: number;
    if (requestedCap !== undefined && (!Number.isFinite(requestedCap) || requestedCap <= 0)) throw new Error("maxSpendUsd must be greater than zero.");
    if (priceType === "PER_RESULT") {
      if (requestedCap === undefined) throw new Error("This endpoint charges per result. Provide maxSpendUsd so Chusky can reserve a bounded allowance before running it.");
      if (listedPrice === undefined) throw new Error("Monid did not return a verifiable per-result price; this endpoint cannot be run safely.");
      if (flatFee > requestedCap) throw new Error(`The inspected flat fee is $${flatFee.toFixed(6)}, above the supplied maxSpendUsd.`);
      const exposure = perResultExposure(input, listedPrice, flatFee);
      if (exposure > requestedCap) throw new Error(`The inspected price and result limit estimate $${exposure.toFixed(6)}, above the supplied maxSpendUsd.`);
      estimateUsd = requestedCap;
    } else if (priceType === "PER_CALL") {
      if (listedPrice === undefined) throw new Error("Monid did not return a verifiable per-call price; this endpoint cannot be run safely.");
      estimateUsd = requestedCap ?? Math.max(0.000001, listedPrice + flatFee);
      if (listedPrice + flatFee > estimateUsd) throw new Error(`The inspected per-call price is $${(listedPrice + flatFee).toFixed(6)}, above the supplied maxSpendUsd.`);
    } else {
      throw new Error("Monid did not return a supported PER_CALL or PER_RESULT price; this endpoint cannot be run safely.");
    }
    const reservation = await this.deps.spend.reserve(options.userId, estimateUsd, options.missionId);
    const id = randomUUID();
    const createdAt = this.now();
    let receipt: MonidRunReceipt = {
      id, userId: options.userId, ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      ...(options.missionId ? { missionId: options.missionId } : {}), provider, endpoint, state: "submitting",
      estimatedCostUsd: estimateUsd, reservation, createdAt, updatedAt: createdAt,
    };
    await this.deps.saveReceipt(receipt);
    const startedAt = this.now();
    try {
      const response = await this.request("POST", "/v1/run", options.organizationId, { provider, endpoint, input });
      const row = response.data;
      const runId = typeof row.runId === "string" ? boundedText(row.runId, 100) : undefined;
      if (response.status === 202 || normalizeState(row.status) === "running") {
        if (!runId) throw new MonidApiError("Monid accepted an asynchronous run without returning a run ID.", 502);
        receipt = { ...receipt, ...(runId ? { runId } : {}), state: "running", updatedAt: this.now(), durationMs: this.now() - startedAt };
        await this.deps.saveReceipt(receipt);
        return { ...runSummary(row), status: "RUNNING", estimatedCostUsd: estimateUsd, charged: false, next: "Inspect this run with CHUCK_MONID_RUN_GET. Do not submit the run again while it is running or uncertain." };
      }
      const actual = costUsd(row);
      const lifecycleState = normalizeState(row.status);
      const hasProviderError = Number(isRecord(row.providerResponse) ? row.providerResponse.httpStatus : 200) >= 400;
      const settledCost = actual ?? (lifecycleState === "completed" && !hasProviderError ? estimateUsd : 0);
      await this.deps.spend.settle(reservation, settledCost);
      receipt = {
        ...receipt, ...(runId ? { runId } : {}), state: lifecycleState === "completed" ? "completed" : lifecycleState === "blocked" ? "blocked" : "failed",
        ...(actual !== undefined ? { actualCostUsd: actual } : {}),
        ...(typeof (isRecord(row.providerResponse) ? row.providerResponse.httpStatus : undefined) === "number" ? { providerHttpStatus: Number((row.providerResponse as Record<string, unknown>).httpStatus) } : {}),
        ...(typeof row.resultCount === "number" ? { resultCount: row.resultCount } : {}), updatedAt: this.now(), durationMs: this.now() - startedAt,
      };
      await this.deps.saveReceipt(receipt);
      let evidenceRecorded: boolean | undefined;
      try { evidenceRecorded = await this.recordEvidence(receipt, row.output); }
      catch { evidenceRecorded = false; }
      return { ...runSummary(row), estimatedCostUsd: estimateUsd, actualCostUsd: settledCost, costWasEstimated: actual === undefined, charged: true, ...(evidenceRecorded === false ? { missionEvidenceRecorded: false } : {}) };
    } catch (error) {
      const definitiveClientError = error instanceof MonidApiError && error.status >= 400 && error.status < 500;
      if (definitiveClientError) {
        await this.deps.spend.settle(reservation, 0);
        receipt = { ...receipt, state: "failed", error: boundedText(error.message), updatedAt: this.now(), durationMs: this.now() - startedAt };
      } else {
        receipt = { ...receipt, state: "uncertain", error: boundedText(error instanceof Error ? error.message : "Monid outcome is uncertain"), updatedAt: this.now(), durationMs: this.now() - startedAt };
      }
      await this.deps.saveReceipt(receipt);
      throw new Error(definitiveClientError
        ? receipt.error ?? "Monid rejected the run before it started."
        : `Monid could not confirm the run outcome. It has not been retried; inspect CHUCK_MONID_USAGE and Monid run history before starting another run. ${receipt.error ?? ""}`.trim());
    }
  }

  async getRun(userId: number, runIdInput: string, organizationId?: string): Promise<unknown> {
    const runId = boundedText(runIdInput, 100);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(runId)) throw new Error("Invalid Monid run ID.");
    const receipts = await this.deps.listReceipts(userId, 200, organizationId);
    let receipt = receipts.find((item) => item.runId === runId && item.userId === userId && item.organizationId === organizationId);
    if (!receipt) throw new Error("That Monid run is not in this owner's saved receipts.");
    const { data } = await this.request("GET", `/v1/runs/${encodeURIComponent(runId)}`, organizationId);
    const currentState = normalizeState(data.status);
    const providerResponse = isRecord(data.providerResponse) ? data.providerResponse : {};
    const actual = costUsd(data);
    if (currentState !== "running" && currentState !== "uncertain" && receipt.reservation) {
      const finalCost = actual ?? (currentState === "completed" && Number(providerResponse.httpStatus ?? 200) < 400 ? receipt.estimatedCostUsd : 0);
      await this.deps.spend.settle(receipt.reservation, finalCost);
      receipt = {
        ...receipt, state: currentState, ...(actual !== undefined ? { actualCostUsd: actual } : {}),
        ...(typeof providerResponse.httpStatus === "number" ? { providerHttpStatus: providerResponse.httpStatus } : {}),
        ...(typeof data.resultCount === "number" ? { resultCount: data.resultCount } : {}), updatedAt: this.now(),
        ...(finalCost !== undefined && actual === undefined ? { error: "Monid did not return an actual charge; Chusky settled the reserved estimate for conservative accounting." } : {}),
        reservation: undefined,
      };
      await this.deps.saveReceipt(receipt);
      try { await this.recordEvidence(receipt, data.output); } catch { /* Run settlement is already durable. */ }
    } else if (currentState !== receipt.state) {
      receipt = { ...receipt, state: currentState, updatedAt: this.now() };
      await this.deps.saveReceipt(receipt);
    }
    return runSummary(data);
  }

  async listRuns(userId: number, limitInput = 10, organizationId?: string): Promise<unknown> {
    const limit = Math.max(1, Math.min(20, Math.floor(limitInput)));
    const receipts = await this.deps.listReceipts(userId, 200, organizationId);
    const ownedRunIds = new Set(receipts.filter((item) => item.runId && item.organizationId === organizationId).map((item) => item.runId!));
    const { data } = await this.request("GET", `/v1/runs?limit=${limit}`, organizationId);
    const items = Array.isArray(data.items) ? data.items.filter(isRecord).filter((item) => typeof item.runId === "string" && ownedRunIds.has(item.runId)).slice(0, limit).map((item) => runSummary(item)) : [];
    return { items, count: items.length, note: "Chusky filters Monid workspace history to runs saved in this owner's receipts." };
  }

  async balance(organizationId?: string): Promise<unknown> {
    const { data } = await this.request("GET", "/v1/wallet/balance", organizationId);
    return boundedResult(data);
  }

  private async recordEvidence(receipt: MonidRunReceipt, output: unknown): Promise<boolean | undefined> {
    if (receipt.state !== "completed" || !receipt.missionId || !this.deps.recordMissionEvidence) return undefined;
    const resultHash = createHash("sha256").update(JSON.stringify(output ?? null)).digest("hex");
      const result = await this.deps.recordMissionEvidence({ userId: receipt.userId, missionId: receipt.missionId, receipt, resultHash });
      return result;
  }
}
