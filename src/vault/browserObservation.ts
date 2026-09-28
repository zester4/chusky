import { browserActionRisk, classifyBrowserIntent } from "./browserOps.js";
import type { VaultAction } from "./policy.js";

export type BrowserCandidateKind = "find" | "invoke" | "fill" | "reinspect" | "verify" | "handoff" | "stop";

export type BrowserCandidate = {
  id: string;
  kind: BrowserCandidateKind;
  role?: string;
  name?: string;
  nodeId?: string;
  action: VaultAction;
  risk: "low" | "medium" | "high";
  description: string;
  requiresApproval: boolean;
  execution?: Record<string, unknown>;
};

export type BrowserObservation = {
  origin?: string;
  path?: string;
  title?: string;
  loadState?: string;
  sessionStatus?: string;
  goal: string;
  candidates: BrowserCandidate[];
};

const SECRET_LABEL = /password|passcode|secret|token|api key|security code|verification code|credit card|card number|cvv|routing number|account number/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /\+?\d[\d ()-]{7,}\d/g;
const LONG_NUMBER = /\b\d{8,}\b/g;

export function redactBrowserText(value: unknown, max = 180): string {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]")
    .replace(LONG_NUMBER, "[number]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanRole(value: unknown): string {
  return redactBrowserText(value, 40).toLowerCase() || "any";
}

function cleanName(value: unknown): string | undefined {
  const name = redactBrowserText(value, 120);
  if (!name || SECRET_LABEL.test(name)) return undefined;
  return name;
}

function walkNodes(value: unknown, out: Array<{ role: string; name: string; nodeId?: string; disabled?: boolean }>, depth = 0): void {
  if (depth > 8 || out.length >= 60 || value === null || value === undefined) return;
  if (Array.isArray(value)) { for (const item of value) walkNodes(item, out, depth + 1); return; }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const role = cleanRole(record.role ?? record.type ?? record.controlType);
  const name = cleanName(record.name ?? record.label ?? record.accessibleName ?? record.text);
  const nodeId = typeof record.nodeId === "string" ? record.nodeId.slice(0, 200) : undefined;
  if (name && ["button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "option", "tab", "any"].includes(role)) {
    out.push({ role, name, nodeId, disabled: record.disabled === true || record.enabled === false });
  }
  for (const [key, child] of Object.entries(record)) {
    if (!["role", "type", "controlType", "name", "label", "accessibleName", "text", "nodeId", "disabled", "enabled", "value"].includes(key)) walkNodes(child, out, depth + 1);
  }
}

function safeOrigin(value: unknown): { origin?: string; path?: string } {
  if (typeof value !== "string") return {};
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return {};
    return { origin: url.origin, path: url.pathname.slice(0, 300) };
  } catch { return {}; }
}

function candidateAction(role: string, name: string, goal: string): { kind: "find" | "invoke" | "fill"; action: VaultAction } {
  const action = /\b(search|find|filter|sort)\b/i.test(name)
    ? "search"
    : classifyBrowserIntent({ label: name, role }) === "unknown"
      ? classifyBrowserIntent({ label: goal, role })
      : classifyBrowserIntent({ label: name, role });
  if (role === "textbox" || role === "combobox") return { kind: "fill", action };
  if (["button", "link", "menuitem", "option", "tab"].includes(role)) return { kind: "invoke", action };
  return { kind: "find", action };
}

export function buildBrowserCandidates(input: { accessibility?: unknown; goal: string; currentUrl?: string; title?: string; loadState?: string; sessionStatus?: string }, maxCandidates = 12): BrowserObservation {
  const goal = redactBrowserText(input.goal, 500);
  const page = safeOrigin(input.currentUrl);
  const nodes: Array<{ role: string; name: string; nodeId?: string; disabled?: boolean }> = [];
  walkNodes(input.accessibility, nodes);
  const candidates: BrowserCandidate[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.disabled || !node.nodeId || !node.name) continue;
    const key = `${node.role}:${node.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const selected = candidateAction(node.role, node.name, goal);
    const risk = browserActionRisk(selected.action);
    const id = `c_${candidates.length}`;
    candidates.push({
      id, kind: selected.kind, role: node.role, name: node.name, nodeId: node.nodeId, action: selected.action,
      risk, description: `${selected.kind} ${node.role} '${node.name}' for the requested goal`,
      requiresApproval: risk === "high" || selected.action === "unknown",
      execution: { action: selected.kind === "invoke" ? "invoke" : selected.kind === "fill" ? "find" : "find", role: node.role, name: node.name, nameMatch: "exact", nodeId: node.nodeId },
    });
    if (candidates.length >= Math.max(1, Math.min(24, maxCandidates - 3))) break;
  }
  const extras: BrowserCandidate[] = [
    { id: `c_${candidates.length}`, kind: "reinspect", action: "browse", risk: "low", description: "Re-inspect the current page before acting", requiresApproval: false, execution: { action: "state" } },
    { id: `c_${candidates.length + 1}`, kind: "handoff", action: "unknown", risk: "medium", description: "Pause and request a private human browser handoff", requiresApproval: false, execution: { action: "handoff" } },
    { id: `c_${candidates.length + 2}`, kind: "stop", action: "unknown", risk: "medium", description: "Stop because the page or intended action is ambiguous", requiresApproval: false, execution: { action: "stop" } },
  ];
  candidates.push(...extras);
  return { ...page, ...(typeof input.title === "string" ? { title: redactBrowserText(input.title, 160) } : {}), ...(input.loadState ? { loadState: redactBrowserText(input.loadState, 40) } : {}), ...(input.sessionStatus ? { sessionStatus: redactBrowserText(input.sessionStatus, 40) } : {}), goal, candidates: candidates.slice(0, Math.max(3, Math.min(24, maxCandidates))) };
}

export function browserObservationState(observation: BrowserObservation): Record<string, unknown> {
  return {
    goal: observation.goal,
    page: { origin: observation.origin ?? "unknown", path: observation.path ?? "unknown", title: observation.title ?? "unknown", loadState: observation.loadState ?? "unknown", sessionStatus: observation.sessionStatus ?? "unknown" },
    candidates: observation.candidates.map(({ id, kind, role, name, action, risk, description, requiresApproval }) => ({ id, kind, role, name, action, risk, description, requiresApproval })),
  };
}
