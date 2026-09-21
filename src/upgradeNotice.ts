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
  missions: [
    "Added durable autonomous missions for concrete outcomes: dependency-aware steps, bounded budgets, checkpoints, retries, and restart-safe execution.",
    "Missions can fan out independent work, wait for timers or exact provider events, pause, resume, repair, replan, and attach evidence before verification and completion.",
    "Mission status, proof, controls, and owner isolation are available across Telegram, the CLI, SDK/API, dashboard, and MCP through the same persisted runtime.",
  ],
  meetings: [
    "Added Recall-powered meeting participation for Zoom, Google Meet, Microsoft Teams, and Webex, with natural copilot and owner-scoped representative modes.",
    "Meeting representatives can support sales and onboarding with approved connected-app tools, participant chat, contact capture, calendar availability, reminders, tasks, and follow-through.",
    "Added optional screen-share understanding, Nova-3 live transcription, encrypted opt-in transcript retention, private outcomes, and scratchpad/Notion follow-through.",
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
