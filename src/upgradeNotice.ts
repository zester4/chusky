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
    "Extended the governed runtime across meetings, A2A, E2B browser and Daytona artifact execution, Telegram, the CLI, SDK/API, dashboard, and MCP with the same owner-scoped durable state.",
  ],
  attention: [
    "The proactive attention pulse now reconciles open loops, pending candidates, blocked or failed tasks and missions, expired waits, and due owner-configured watches.",
    "Personal and business watches are isolated by mode, and only confirmed successful tool calls count as handling; paused work and future waits remain untouched.",
    "The pulse builds bounded decision context, lets Jev propose the specialist and exact connected-app action, and preserves deterministic authority, account, and verification gates while preserving approval boundaries.",
  ],
  missions: [
    "Added durable autonomous missions for concrete outcomes: dependency-aware steps, bounded budgets, checkpoints, retries, restart-safe execution, server-side closeout, and live provider outcome verification.",
    "Missions can fan out independent work, sleep for timers, resume on exact provider events or approvals without polling loops, pause, repair, and replan.",
    "Mission status, proof, controls, and owner isolation are available across Telegram, the CLI, SDK/API, dashboard, and MCP through the same persisted runtime.",
  ],
  meetings: [
    "Meeting representatives now arrive with a private, client-matched readiness brief and can discover relevant actions from the owner's connected apps for the meeting objective.",
    "Proactive meeting modes can contribute naturally without waiting to be addressed, yield when participants speak, verify calendar availability before booking, and continue agreed follow-through.",
    "Meeting context stays owner-scoped: sensitive and unrelated memories are excluded, private connected-app results are not authorization to disclose, and high-impact actions retain approval boundaries.",
  ],
  ownerAutonomy: [
    "Owner-private chat, calls, and meetings now use relevant owner history and context plus connected Composio, MCP, and native tools across personal and business use.",
    "Owner-private interactive runs use relevant owner context and connected tools for routine requests; deletion, financial, permission, deployment/push, and provider-marked high-impact actions pause for exact approval.",
    "Personal and business context stays appropriately separated, and shared rooms, autonomous workflows, and delegated workers keep their explicit scopes and policies.",
  ],
  sharedHistory: [
    "Private dashboard conversations now persist in the same owner-scoped account history as Telegram and linked private channels, including eligible conversations created before this upgrade.",
    "Linking a web account with Telegram imports its private conversation history, scratchpad, and eligible memories once while preserving the Telegram session and connected-app session.",
    "The dashboard shows earlier shared private turns; shared rooms and company/project runs remain outside personal account history.",
  ],
  toolReliability: [
    "Added tool preflight and connected-account health checks so Chusky can validate the exact exposed schema and report connection state without executing actions.",
    "Added read-only PDF, DOCX, PPTX, and XLSX QA plus persisted tool-failure recovery guidance that never blindly replays ambiguous actions.",
    "Added approval-gated transfer of Daytona artifacts to Composio, and exposed all five reliability capabilities across typed SDK, single-tool MCP runs, and durable A2A task skills without bypassing policy.",
  ],
  mediaAutomation: [
    "Image requests in ordinary conversation now cover Pinterest Pins, YouTube thumbnails, Shopify product media, Slack messages, and Instagram carousels alongside existing posts, email, and Drive uploads.",
    "Chusky uses the selected owner image with each app's current Composio schema, staging files or issuing short-lived R2 links as the action requires.",
    "Ambiguous selections stop before execution; Instagram carousels require 2 to 10 JPEGs and provider read-back, and uncertain writes require inspection before retrying.",
  ],
  daytonaImages: [
    "Images created inside Daytona can be imported into the owner's private image library and then used by connected-app posts and uploads in the same conversation.",
    "Current chat images, generated images, and saved images can be copied into the owner's Daytona workspace with unique filenames and a returned file path.",
    "A Daytona screenshot becomes available for a connected-app action only when the owner explicitly asks to send or publish that screenshot.",
  ],
  generatedImageApi: [
    "Completed API and SDK runs now include metadata for generated images saved to the owner's private image store.",
    "The SDK refreshes a short-lived image download URL through an owner-scoped endpoint; image bytes, storage keys, and signed URLs are not persisted in run records.",
    "The dashboard renders generated image previews, and project API keys require the dedicated images:read permission.",
  ],
  xDirectMessages: [
    "Added a regular X Direct Messages channel alongside separate encrypted XChat, with independent OAuth settings and identity links.",
    "X webhook CRC and signature checks use the official adapter; message routing, account linking, durable state, and delivery use Chusky's channel gateway.",
    "Linked X DMs are private conversations, while unsolicited X notifications stay off until explicitly enabled. The installed adapter does not expose inbound DM images yet.",
  ],
  customMcp: [
    "Accounts can add third-party MCP servers from the dashboard or SDK; Chusky supports Streamable HTTP with legacy HTTP+SSE fallback and verifies discovery before saving.",
    "Bearer credentials are encrypted at rest, outbound hosts are pinned to validated public DNS results, and private/link-local targets and redirects are rejected.",
    "The agent executes discovered tools with schema validation, default human approval, bounded results, visible failures, and account isolation from group and meeting contexts.",
  ],
  treg: [
    "Added Treg as Chusky's first-class live-data gateway with bounded native tools for provider catalog search, endpoint inspection, provider comparison, enrichment, data resolution, organization-tool discovery, usage, and balance checks.",
    "Treg calls use server-only organization credentials, rate limits, atomic owner and mission spend reservations, bounded receipts, response-header settlement, and reusable idempotency keys.",
    "Treg OAuth handoffs keep provider tokens with Treg; authenticated actions stay in connected Composio apps, while empty, ambiguous, stale, or provider-flagged results are handled explicitly before customer-facing or irreversible work.",
  ],
  linkAgentWallet: [
    "Added an owner-controlled Stripe Link Agent Wallet with PKCE OAuth, encrypted server-side token storage, and bounded safe wallet and payment-method metadata.",
    "Purchase requests carry the exact merchant, amount, currency, and owner-visible context to Link, which owns the approval notification and approval decision before any payment credential is released.",
    "Approved checkout credentials remain outside model context, chat history, Redis plaintext, and tool arguments; owner-private E2B checkout can fill them server-side and never claims success before Link and the merchant confirm it.",
  ],
  jevRouting: [
    "Added Jev decision routing for skills, Composio toolkits and actions, and Treg endpoint selection, layered on top of Chusky's existing deterministic routes.",
    "Composio routing now includes a bounded catalog of apps the user has not connected; named unavailable apps trigger connection setup while their actions remain non-callable until connected.",
    "Jev runs under one per-turn deadline with deterministic fallback, while approvals, budgets, account isolation, and native tool policy remain authoritative.",
  ],
  browserAutonomy: [
    "Added a bounded browser decision loop and an owner-scoped E2B Playwright/Chromium browser with headed sessions, accessible controls, tabs, scrolling, drag/drop, forms, keyboard actions, navigation, and screenshots.",
    "CAPTCHA, 2FA, passkeys, security keys, and other human-only challenges can hand the same E2B browser session to the owner through a short-lived private noVNC link; ordinary browsing remains autonomous.",
    "Browser observations are redacted and bounded before Jev sees them, while origin checks, session leases, existing approval policy, high-impact safeguards, and the Daytona fallback remain authoritative.",
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
