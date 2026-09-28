import { config } from "../../config.js";

const VECTOR_REQUEST_TIMEOUT_MS = 2_500;
const VECTOR_MAX_ATTEMPTS = 2;
const VECTOR_RETRY_BASE_DELAY_MS = 100;
const VECTOR_DEGRADED_COOLDOWN_MS = 30_000;
const vectorDegradedUntil = new Map<string, number>();

export class UpstashVectorRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "UpstashVectorRequestError";
  }
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelay(attempt: number): number {
  const exponential = VECTOR_RETRY_BASE_DELAY_MS * (2 ** attempt);
  return exponential + Math.floor(Math.random() * VECTOR_RETRY_BASE_DELAY_MS);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface KnowledgeMetadata { userId: string; projectId?: string; documentId: string; sourceType: string; contentType?: string; chunkIndex: number; visibility: "private" | "project"; [key: string]: string | number | boolean | undefined; }
export interface KnowledgeMatch { id: string; score?: number; data?: string; metadata?: KnowledgeMetadata; }

function filterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function namespace(userId: string, projectId?: string): string {
  const clean = (value: string) => value.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  if (!userId.trim()) throw new Error("userId is required");
  return projectId?.trim() ? `project_${clean(projectId)}` : `account_${clean(userId)}`;
}

export class UpstashKnowledgeStore {
  private readonly url: string;
  constructor(url = config.upstashVectorRestUrl, token = config.upstashVectorRestToken) {
    if (!url || !token) throw new Error("Upstash Vector is not configured");
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }
  private readonly token: string;
  private async call<T>(path: string, body: unknown, method: "POST" | "DELETE" = "POST"): Promise<T> {
    const degradedUntil = vectorDegradedUntil.get(this.url) ?? 0;
    if (degradedUntil > Date.now()) {
      throw new UpstashVectorRequestError("Upstash Vector is temporarily unavailable; use structured search until it recovers");
    }
    if (degradedUntil) vectorDegradedUntil.delete(this.url);

    const requestUrl = `${this.url}${path}`;
    for (let attempt = 0; attempt < VECTOR_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), VECTOR_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(requestUrl, {
          method,
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) {
          vectorDegradedUntil.delete(this.url);
          const payload = await response.json() as { result: T };
          return payload.result;
        }
        await response.body?.cancel();
        if (attempt + 1 < VECTOR_MAX_ATTEMPTS && retryableStatus(response.status)) {
          await wait(retryDelay(attempt));
          continue;
        }
        if (retryableStatus(response.status)) vectorDegradedUntil.set(this.url, Date.now() + VECTOR_DEGRADED_COOLDOWN_MS);
        throw new UpstashVectorRequestError(`Upstash Vector request failed (${response.status})`, response.status);
      } catch (error) {
        if (error instanceof UpstashVectorRequestError) throw error;
        if (attempt + 1 >= VECTOR_MAX_ATTEMPTS) {
          vectorDegradedUntil.set(this.url, Date.now() + VECTOR_DEGRADED_COOLDOWN_MS);
          throw new UpstashVectorRequestError("Upstash Vector request failed before a response", undefined);
        }
        await wait(retryDelay(attempt));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new UpstashVectorRequestError("Upstash Vector request failed before a response", undefined);
  }
  async upsert(chunks: Array<{ id: string; data: string; metadata: KnowledgeMetadata }>): Promise<void> {
    if (!chunks.length) return;
    const groups = new Map<string, typeof chunks>();
    for (const chunk of chunks) { const ns = namespace(chunk.metadata.userId, chunk.metadata.projectId); groups.set(ns, [...(groups.get(ns) ?? []), chunk]); }
    for (const [ns, values] of groups) await this.call(`/upsert-data/${encodeURIComponent(ns)}`, values.map(({ id, data, metadata }) => ({ id, data, metadata })));
  }
  query(userId: string, data: string, options: { projectId?: string; topK?: number; filter?: string } = {}): Promise<KnowledgeMatch[]> {
    const ns = namespace(userId, options.projectId);
    const filter = options.filter ? `userId = '${userId.replace(/'/g, "\\'")}' AND (${options.filter})` : `userId = '${userId.replace(/'/g, "\\'")}'`;
    return this.call(`/query-data/${encodeURIComponent(ns)}`, { data, topK: Math.min(Math.max(options.topK ?? 5, 1), 50), includeData: true, includeMetadata: true, filter });
  }
  async deleteDocument(userId: string, documentId: string, projectId?: string): Promise<{ deleted: number }> {
    const ns = namespace(userId, projectId);
    return this.call(`/delete/${encodeURIComponent(ns)}`, { prefix: `${documentId}:` }, "DELETE");
  }

  async upsertMemory(memory: { userId: string; id: string; category: string; key: string; value: string; projectId?: string; personKey?: string }): Promise<void> {
    await this.upsert([{
      id: `memory:${memory.id}:0`,
      data: `${memory.category} ${memory.key}: ${memory.value}`,
      metadata: {
        userId: memory.userId,
        projectId: memory.projectId,
        documentId: memory.id,
        sourceType: "memory",
        contentType: "text/plain",
        chunkIndex: 0,
        visibility: "private",
        memoryId: memory.id,
        category: memory.category,
        personKey: memory.personKey,
      },
    }]);
  }

  async upsertMemories(memories: Array<{ userId: string; id: string; category: string; key: string; value: string; projectId?: string; personKey?: string }>): Promise<void> {
    await this.upsert(memories.map((memory) => ({
      id: `memory:${memory.id}:0`,
      data: `${memory.category} ${memory.key}: ${memory.value}`,
      metadata: {
        userId: memory.userId,
        projectId: memory.projectId,
        documentId: memory.id,
        sourceType: "memory",
        contentType: "text/plain",
        chunkIndex: 0,
        visibility: "private" as const,
        memoryId: memory.id,
        category: memory.category,
        personKey: memory.personKey,
      },
    })));
  }

  async queryMemories(userId: string, data: string, options: { category?: string; projectId?: string; personKey?: string; topK?: number } = {}): Promise<KnowledgeMatch[]> {
    const filters = ["sourceType = 'memory'"];
    if (options.category) filters.push(`category = '${filterValue(options.category)}'`);
    if (options.projectId) filters.push(`projectId = '${filterValue(options.projectId)}'`);
    if (options.personKey) filters.push(`personKey = '${filterValue(options.personKey)}'`);
    return this.query(userId, data, { projectId: options.projectId, topK: options.topK, filter: filters.join(" AND ") });
  }

  async deleteMemory(userId: string, memoryId: string, projectId?: string): Promise<void> {
    await this.deleteDocument(userId, `memory:${memoryId}`, projectId);
  }
}

export function vectorConfigured(): boolean { return Boolean(config.upstashVectorRestUrl && config.upstashVectorRestToken); }
