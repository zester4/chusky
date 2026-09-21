import { createHash, randomUUID } from "node:crypto";
import { getSession, saveSession, type ContextNodeRecord, type ContextScope, type ContextSensitivity, type DepartmentSpaceRecord, type WorkPacketRecord, type WorkPacketStatus, type MissionEvidenceRecord } from "./store.js";

const safeId = (value: string, prefix: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

export type ContextSelection = {
  scope?: ContextScope;
  scopeId?: string;
  purpose?: "planning" | "execution" | "meeting" | "support" | "sales" | "reporting" | "handoff";
  query?: string;
  includeSensitive?: boolean;
  limit?: number;
};

function normalizeNode(userId: number, input: Partial<ContextNodeRecord> & Pick<ContextNodeRecord, "scope" | "kind" | "key" | "value">): ContextNodeRecord {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Context owner is invalid");
  if (!/^[a-z_]+$/.test(input.scope) || !["user", "organization", "department", "project", "mission", "meeting", "conversation", "channel"].includes(input.scope)) throw new Error("Context scope is invalid");
  if (!/^[a-z_]+$/.test(input.kind)) throw new Error("Context kind is invalid");
  const now = Date.now();
  return {
    id: input.id && /^ctx_[A-Za-z0-9_-]{1,96}$/.test(input.id) ? input.id : `ctx_${randomUUID()}`,
    userId, scope: input.scope, ...(input.scopeId ? { scopeId: input.scopeId.slice(0, 180) } : {}), kind: input.kind,
    key: input.key.trim().slice(0, 240), value: input.value.trim().slice(0, 20_000), ...(input.source ? { source: input.source.slice(0, 500) } : {}), ...(input.sourceRef ? { sourceRef: input.sourceRef.slice(0, 500) } : {}), confidence: Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? Number(input.confidence) : 1)), sensitivity: input.sensitivity === "sensitive" ? "sensitive" : "normal", tags: [...new Set((input.tags ?? []).filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().slice(0, 80)).filter(Boolean))].slice(0, 20), createdAt: input.createdAt ?? now, updatedAt: now,
    ...(input.reviewAt ? { reviewAt: input.reviewAt } : {}), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
}

export async function upsertContextNode(userId: number, input: Partial<ContextNodeRecord> & Pick<ContextNodeRecord, "scope" | "kind" | "key" | "value">): Promise<ContextNodeRecord> {
  const session = await getSession(userId);
  const node = normalizeNode(userId, input);
  const identity = `${node.scope}:${node.scopeId ?? ""}:${node.kind}:${node.key}`;
  const index = (session.contextNodes ?? []).findIndex((item) => `${item.scope}:${item.scopeId ?? ""}:${item.kind}:${item.key}` === identity);
  if (index >= 0) { node.id = session.contextNodes![index].id; node.createdAt = session.contextNodes![index].createdAt; session.contextNodes![index] = node; }
  else session.contextNodes = [node, ...(session.contextNodes ?? [])].slice(0, 1000);
  await saveSession(userId, session);
  return node;
}

export async function selectContext(userId: number, selection: ContextSelection = {}): Promise<ContextNodeRecord[]> {
  const now = Date.now();
  const query = selection.query?.trim().toLowerCase();
  const purposeKinds: Record<string, ContextNodeRecord["kind"][]> = {
    planning: ["objective", "decision", "preference", "open_loop", "memory", "fact"], execution: ["objective", "decision", "preference", "tool_receipt", "artifact", "fact"], meeting: ["meeting", "decision", "preference", "relationship", "fact"], support: ["fact", "decision", "tool_receipt", "open_loop"], sales: ["fact", "decision", "relationship", "objective", "artifact"], reporting: ["tool_receipt", "artifact", "decision", "objective"], handoff: ["objective", "decision", "open_loop", "tool_receipt", "artifact"],
  };
  const allowedKinds = selection.purpose ? new Set(purposeKinds[selection.purpose] ?? []) : undefined;
  return (await getSession(userId)).contextNodes?.filter((node) => {
    if (node.expiresAt && node.expiresAt <= now) return false;
    if (node.reviewAt && node.reviewAt <= now && selection.purpose !== "planning") return false;
    if (!selection.includeSensitive && node.sensitivity === "sensitive") return false;
    if (selection.scope && node.scope !== selection.scope) return false;
    if (selection.scopeId && node.scopeId !== selection.scopeId) return false;
    if (allowedKinds && !allowedKinds.has(node.kind)) return false;
    if (query && !`${node.key} ${node.value} ${node.tags.join(" ")}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((a, b) => (b.confidence - a.confidence) || (b.updatedAt - a.updatedAt)).slice(0, Math.max(1, Math.min(100, selection.limit ?? 30))) ?? [];
}

export async function contextPrompt(userId: number, selection: ContextSelection = {}): Promise<string> {
  const nodes = await selectContext(userId, selection);
  return nodes.length ? nodes.map((node) => `- [${node.scope}${node.scopeId ? `:${node.scopeId}` : ""}/${node.kind}] ${node.key}: ${node.value}${node.source ? ` (source: ${node.source})` : ""}`).join("\n") : "No matching context was found.";
}

export async function upsertDepartmentSpace(userId: number, input: Omit<DepartmentSpaceRecord, "id" | "userId" | "createdAt" | "updatedAt"> & { id?: string }): Promise<DepartmentSpaceRecord> {
  const session = await getSession(userId); const now = Date.now();
  const department = input.department.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 80);
  if (!department || !input.name.trim()) throw new Error("Department and name are required");
  const record: DepartmentSpaceRecord = { ...input, id: input.id && /^dept_[A-Za-z0-9_-]{1,96}$/.test(input.id) ? input.id : `dept_${randomUUID()}`, userId, department, name: input.name.trim().slice(0, 120), objectives: input.objectives.slice(0, 30).map((item) => item.slice(0, 500)), policies: input.policies.slice(0, 50).map((item) => item.slice(0, 1000)), approvedTools: [...new Set(input.approvedTools)].slice(0, 100), contextNodeIds: [...new Set(input.contextNodeIds)].slice(0, 100), activeMissionIds: [...new Set(input.activeMissionIds)].slice(0, 100), decisionNodeIds: [...new Set(input.decisionNodeIds)].slice(0, 100), ...(input.mission ? { mission: input.mission.slice(0, 2000) } : {}), ...(input.escalationOwner ? { escalationOwner: input.escalationOwner.slice(0, 200) } : {}), ...(input.budget ? { budget: input.budget } : {}), createdAt: now, updatedAt: now };
  const existing = session.departmentSpaces?.findIndex((item) => item.id === record.id || item.department === department);
  if (existing !== undefined && existing >= 0) { record.id = session.departmentSpaces![existing].id; record.createdAt = session.departmentSpaces![existing].createdAt; session.departmentSpaces![existing] = record; } else session.departmentSpaces = [record, ...(session.departmentSpaces ?? [])].slice(0, 50);
  await saveSession(userId, session); return record;
}

export async function listDepartmentSpaces(userId: number): Promise<DepartmentSpaceRecord[]> { return (await getSession(userId)).departmentSpaces ?? []; }

export async function createWorkPacket(userId: number, input: Omit<WorkPacketRecord, "id" | "userId" | "status" | "createdAt" | "updatedAt"> & { id?: string }): Promise<WorkPacketRecord> {
  const session = await getSession(userId); const now = Date.now();
  const packet: WorkPacketRecord = { ...input, id: input.id && /^pkt_[A-Za-z0-9_-]{1,96}$/.test(input.id) ? input.id : `pkt_${randomUUID()}`, userId, objective: input.objective.trim().slice(0, 4000), inputs: structuredClone(input.inputs ?? {}), constraints: input.constraints.slice(0, 30).map((item) => item.slice(0, 1000)), evidenceRequired: input.evidenceRequired.slice(0, 30).map((item) => item.slice(0, 500)), ...(input.outputSchema ? { outputSchema: structuredClone(input.outputSchema) } : {}), ...(input.fromAgent ? { fromAgent: input.fromAgent.slice(0, 120) } : {}), ...(input.toAgent ? { toAgent: input.toAgent.slice(0, 120) } : {}), ...(input.approvalBoundary ? { approvalBoundary: input.approvalBoundary.slice(0, 1000) } : {}), ...(input.deadline ? { deadline: input.deadline } : {}), status: "queued", createdAt: now, updatedAt: now };
  session.workPackets = [packet, ...(session.workPackets ?? []).filter((item) => item.id !== packet.id)].slice(0, 500); await saveSession(userId, session); return packet;
}

export async function updateWorkPacket(userId: number, id: string, patch: Partial<Pick<WorkPacketRecord, "status" | "result" | "evidence" | "toAgent" | "approvalBoundary">>): Promise<WorkPacketRecord | undefined> {
  const session = await getSession(userId); const packet = session.workPackets?.find((item) => item.id === id); if (!packet) return undefined; Object.assign(packet, patch, { updatedAt: Date.now() }); await saveSession(userId, session); return packet;
}

export function workPacketEvidence(packet: WorkPacketRecord): MissionEvidenceRecord[] { return packet.evidence ?? []; }
