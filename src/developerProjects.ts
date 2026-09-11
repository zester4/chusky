import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getSession, saveSession, type SdkProjectRecord } from "./store.js";

/** Public project-key scopes. Root/admin access is intentionally absent. */
export const SELF_SERVICE_PROJECT_SCOPES = [
  "*", "threads:read", "threads:write", "tasks:read", "tasks:write",
  "approvals:read", "approvals:write", "files:read", "files:write",
  "webhooks:read", "webhooks:write", "audit-events:read", "usage:read",
  "tools:read", "skills:read", "artifacts:read", "artifacts:write",
  "videos:read", "videos:write", "workers:read", "workers:write",
  "channels:read", "activity:read", "deliveries:read", "account:read",
  "account:write", "apps:read", "apps:write", "triggers:read",
  "triggers:write", "reminders:read", "reminders:write", "jobs:read",
  "jobs:write", "memory:read", "memory:write", "scratchpad:read",
  "scratchpad:write",
] as const;

export const TELEGRAM_PROJECT_LIMIT = 10;
export type ProjectKeyView = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: number;
  rotatedAt?: number;
};

const digest = (key: string) => createHash("sha256").update(key).digest("hex");
const keyFor = (projectId: string) => `chsk_${projectId}_${randomBytes(24).toString("base64url")}`;

function view(project: SdkProjectRecord): ProjectKeyView {
  return {
    id: project.id,
    name: project.name,
    keyPrefix: project.keyPrefix,
    scopes: [...project.scopes],
    createdAt: project.createdAt,
    ...(project.rotatedAt ? { rotatedAt: project.rotatedAt } : {}),
  };
}

function assertScopes(scopes: readonly string[]): string[] {
  const unique = [...new Set(scopes)];
  if (!unique.length || unique.length > SELF_SERVICE_PROJECT_SCOPES.length || !unique.every((scope) => (SELF_SERVICE_PROJECT_SCOPES as readonly string[]).includes(scope)) || (unique.includes("*") && unique.length !== 1)) {
    throw new Error("Unsupported API-key scopes");
  }
  return unique;
}

function owned(project: SdkProjectRecord, telegramUserId: number): boolean {
  return project.ownerTelegramUserId === telegramUserId && !project.revokedAt;
}

export async function listTelegramProjects(telegramUserId: number): Promise<ProjectKeyView[]> {
  const control = await getSession(0);
  return control.sdkProjects!.filter((project) => owned(project, telegramUserId)).map(view);
}

/**
 * Returns plaintext exactly once. Persistence contains only its SHA-256 hash.
 */
export async function createTelegramProject(telegramUserId: number, name: string, scopes: readonly string[] = ["*"]): Promise<ProjectKeyView & { key: string }> {
  const safeName = name.trim().replace(/\s+/g, " ").slice(0, 100);
  if (!safeName) throw new Error("Project name is required");
  const control = await getSession(0);
  if (control.sdkProjects!.filter((project) => owned(project, telegramUserId)).length >= TELEGRAM_PROJECT_LIMIT) {
    throw new Error(`You can have up to ${TELEGRAM_PROJECT_LIMIT} active API keys.`);
  }
  const id = `proj_${randomUUID()}`;
  const key = keyFor(id);
  const project: SdkProjectRecord = {
    id,
    name: safeName,
    keyPrefix: key.slice(0, 18),
    keyHash: digest(key),
    scopes: assertScopes(scopes),
    createdAt: Date.now(),
    ownerTelegramUserId: telegramUserId,
  };
  control.sdkProjects!.push(project);
  await saveSession(0, control);
  return { ...view(project), key };
}

export async function rotateTelegramProjectKey(telegramUserId: number, projectId: string): Promise<ProjectKeyView & { key: string }> {
  const control = await getSession(0);
  const project = control.sdkProjects!.find((item) => item.id === projectId && owned(item, telegramUserId));
  if (!project) throw new Error("Active API key not found.");
  const key = keyFor(project.id);
  project.keyHash = digest(key);
  project.keyPrefix = key.slice(0, 18);
  project.rotatedAt = Date.now();
  await saveSession(0, control);
  return { ...view(project), key };
}

export async function revokeTelegramProject(telegramUserId: number, projectId: string): Promise<boolean> {
  const control = await getSession(0);
  const project = control.sdkProjects!.find((item) => item.id === projectId && owned(item, telegramUserId));
  if (!project) return false;
  project.revokedAt = Date.now();
  await saveSession(0, control);
  return true;
}
