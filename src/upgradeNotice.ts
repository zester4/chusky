import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MANIFEST_PATH = path.resolve(process.cwd(), "agent-upgrade.json");
const MAX_TITLE_LENGTH = 120;
const MAX_BULLET_LENGTH = 240;

/**
 * Curated release highlights for capabilities that span several transports.
 * Keep these claims aligned with the runtime and use them from the release
 * writer so a major surface such as missions or meetings is not accidentally
 * omitted.
 */
export const AGENT_UPGRADE_PRESETS = {
  autonomy: [
    "Added bounded personal and business autonomy queues with read-only reconciliation, checkpoints, watches, quiet hours, budgets, and explicit authority modes.",
    "Added a persisted dependency-graph workflow composer that fans out ready stages, joins dependencies, carries bounded results forward, enforces retries and budgets, and pauses at approval checkpoints.",
    "Extended the governed runtime across meetings, A2A, Daytona browser and artifact execution, Telegram, the CLI, SDK/API, dashboard, and MCP with the same owner-scoped durable state.",
  ],
  attention: [
    "The proactive attention pulse now reconciles open loops, pending candidates, blocked or failed tasks and missions, expired waits, and due owner-configured watches.",
    "Personal and business watches are isolated by mode, and only confirmed successful tool calls count as handling; paused work and future waits remain untouched.",
    "The pulse inspects current evidence, routes authorized recovery to the right specialist, and explains real blockers while preserving approval boundaries.",
  ],
  missions: [
    "Added durable autonomous missions for concrete outcomes: dependency-aware steps, bounded budgets, checkpoints, retries, restart-safe execution, and server-side closeout.",
    "Missions can fan out independent work, sleep for timers, resume on exact provider events or approvals without polling loops, pause, repair, and replan.",
    "Mission status, proof, controls, and owner isolation are available across Telegram, the CLI, SDK/API, dashboard, and MCP through the same persisted runtime.",
  ],
  meetings: [
    "Meeting representatives now arrive with a private, client-matched readiness brief and can discover relevant actions from the owner's connected apps for the meeting objective.",
    "Proactive meeting modes can contribute naturally without waiting to be addressed, yield when participants speak, verify calendar availability before booking, and continue agreed follow-through.",
    "Meeting context stays owner-scoped: sensitive and unrelated memories are excluded, private connected-app results are not authorization to disclose, and high-impact actions retain approval boundaries.",
  ],
  toolReliability: [
    "Added tool preflight and connected-account health checks so Chusky can validate the exact exposed schema and report connection state without executing actions.",
    "Added read-only PDF, DOCX, PPTX, and XLSX QA plus persisted tool-failure recovery guidance that never blindly replays ambiguous actions.",
    "Added approval-gated transfer of Daytona artifacts to Composio, and exposed all five reliability capabilities across typed SDK, single-tool MCP runs, and durable A2A task skills without bypassing policy.",
  ],
  customMcp: [
    "Accounts can add third-party MCP servers from the dashboard or SDK; Chusky supports Streamable HTTP with legacy HTTP+SSE fallback and verifies discovery before saving.",
    "Bearer credentials are encrypted at rest, outbound hosts are pinned to validated public DNS results, and private/link-local targets and redirects are rejected.",
    "The agent executes discovered tools with schema validation, default human approval, bounded results, visible failures, and account isolation from group and meeting contexts.",
  ],
} as const;

export type AgentUpgradePreset = keyof typeof AGENT_UPGRADE_PRESETS;

export function getAgentUpgradePreset(name: string): string[] {
  if (!Object.hasOwn(AGENT_UPGRADE_PRESETS, name)) {
    throw new Error(`Unknown upgrade preset: ${name}`);
  }
  return [...AGENT_UPGRADE_PRESETS[name as AgentUpgradePreset]];
}

export type AgentUpgradeNotice = {
  id: string;
  version: string;
  title: string;
  bullets: string[];
  createdAt: string;
};

function text(value: unknown, field: string, max: number): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new Error(`Upgrade ${field} must be between 1 and ${max} characters`);
  return result;
}

export function validateAgentUpgrade(value: unknown): AgentUpgradeNotice {
  if (!value || typeof value !== "object") throw new Error("Upgrade manifest must be an object");
  const input = value as Record<string, unknown>;
  const version = text(input.version, "version", 40);
  const id = text(input.id ?? `release-${version}`, "id", 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("Upgrade id contains unsupported characters");
  const title = text(input.title ?? "Chusky has been upgraded", "title", MAX_TITLE_LENGTH);
  if (!Array.isArray(input.bullets) || input.bullets.length < 1 || input.bullets.length > 3) throw new Error("Upgrade manifest must contain one to three bullets");
  const bullets = input.bullets.map((bullet) => text(bullet, "bullet", MAX_BULLET_LENGTH));
  const createdAt = text(input.createdAt ?? new Date().toISOString(), "createdAt", 80);
  return { id, version, title, bullets, createdAt };
}

export async function loadAgentUpgrade(manifestPath = DEFAULT_MANIFEST_PATH): Promise<AgentUpgradeNotice | undefined> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    return validateAgentUpgrade(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function formatAgentUpgradeNotice(notice: AgentUpgradeNotice): string {
  return `${notice.title} (v${notice.version})\n${notice.bullets.map((bullet) => `- ${bullet}`).join("\n")}`;
}

export async function claimUpgradeNotice(userId: number, notice: AgentUpgradeNotice): Promise<boolean> {
  // Keep manifest tooling independent from the runtime store/config so the
  // release script can run in a clean shell before application env is loaded.
  const { claimAgentUpgrade } = await import("./store.js");
  return claimAgentUpgrade(userId, notice.id);
}

export async function isUpgradeNoticeClaimed(userId: number, notice: AgentUpgradeNotice): Promise<boolean> {
  const { hasAgentUpgrade } = await import("./store.js");
  return hasAgentUpgrade(userId, notice.id);
}

export async function writeAgentUpgrade(manifestPath: string, value: unknown): Promise<AgentUpgradeNotice> {
  const notice = validateAgentUpgrade(value);
  await writeFile(manifestPath, `${JSON.stringify(notice, null, 2)}\n`, "utf8");
  return notice;
}
