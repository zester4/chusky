import { config } from "../../config.js";

export interface KnowledgeMetadata { userId: string; projectId?: string; documentId: string; sourceType: string; contentType?: string; chunkIndex: number; visibility: "private" | "project"; [key: string]: string | number | boolean | undefined; }
export interface KnowledgeMatch { id: string; score?: number; data?: string; metadata?: KnowledgeMetadata; }

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
    const response = await fetch(`${this.url}${path}`, { method, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Upstash Vector request failed (${response.status})`);
    const payload = await response.json() as { result: T };
    return payload.result;
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
}

export function vectorConfigured(): boolean { return Boolean(config.upstashVectorRestUrl && config.upstashVectorRestToken); }
