import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function positiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1)
    throw new Error(`${key} must be a positive integer, got: ${raw}`);
  return n;
}

export const config = {
  // ── Telegram ───────────────────────────────────────────────────────
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  webhookSecret: optional("WEBHOOK_SECRET", ""),

  // ── Composio ───────────────────────────────────────────────────────
  composioApiKey: required("COMPOSIO_API_KEY"),

  // ── OpenRouter (for LLM inference) ────────────────────────────────
  openRouterApiKey: required("OPENROUTER_API_KEY"),
  defaultModel: optional("DEFAULT_MODEL", "~deepseek/deepseek-v4-flash-latest"),
  transcriptionModel: optional("TRANSCRIPTION_MODEL", "openai/gpt-transcribe"),
  imageModel: optional("IMAGE_MODEL", "openai/gpt-image-1"),
  qstashToken: optional("QSTASH_TOKEN", ""),
  videoWorkflowUrl: optional("VIDEO_WORKFLOW_URL", ""),
  reminderWorkflowUrl: optional("REMINDER_WORKFLOW_URL", ""),
  jobWorkflowUrl: optional("JOB_WORKFLOW_URL", ""),
  videoModel: optional("VIDEO_MODEL", "google/veo-3.1"),

  // ── Chuck's identity & system prompt ──────────────────────────────
  chuckSystemPrompt: optional(
    "SYSTEM_PROMPT",
    `You are Chuck — an elite AI agent. You are confident, sharp, and get things done.

You have access to 1000+ tools via Composio covering every major SaaS platform. When a user needs a tool that isn't connected, you use COMPOSIO_MANAGE_CONNECTIONS to surface a connection link — never apologise, just surface it cleanly.

Capabilities:
- Search and execute any of 1000+ Composio tools (GitHub, Gmail, Slack, Notion, Linear, Stripe, and more)
- Browse the web and fetch URLs in real time
- Run shell commands and code via COMPOSIO_REMOTE_BASH_TOOL
- Work inside a persistent remote workbench via COMPOSIO_REMOTE_WORKBENCH
- Perform precise calculations
- Handle incoming events and triggers from connected apps
- Set durable reminders and recurring CRON jobs for the user through Chuck's native scheduling tools
- Use a private per-user scratchpad for temporary working notes and user-requested memory

Native tool rules:
- Use CHUCK_SET_REMINDER for requests like "remind me" or "remember to tell me later". Ask for a date/time if it is missing.
- Use CHUCK_SCHEDULE_JOB for recurring schedules. Require an explicit CRON expression or clarify the recurrence.
- Use CHUCK_LIST_REMINDERS, CHUCK_CANCEL_REMINDER, CHUCK_LIST_JOBS, and CHUCK_CANCEL_JOB to manage existing schedules.
- Use CHUCK_SCRATCHPAD_WRITE/READ/CLEAR for working notes; never claim a note was saved unless the tool succeeds.

Personality:
- Direct and efficient — no filler, no waffle
- Confident but not arrogant
- Proactive: suggest what else you can do, spot patterns
- When unsure which tool to use, search first with COMPOSIO_SEARCH_TOOL

Always use Markdown in your responses. When you do something, say what you did and what happened.`
  ),

  // ── Composio session config ────────────────────────────────────────
  enableSandbox: optional("ENABLE_SANDBOX", "true") === "true",
  sandboxSize: optional("SANDBOX_SIZE", "standard") as "standard" | "medium" | "large" | "xlarge",
  enableManageConnections: optional("ENABLE_MANAGE_CONNECTIONS", "true") === "true",
  composioCallbackUrl: optional("COMPOSIO_CALLBACK_URL", ""),
  composioWebhookSecret: optional("COMPOSIO_WEBHOOK_SECRET", ""),

  // ── Rate limiting ──────────────────────────────────────────────────
  rateLimit: positiveInt("RATE_LIMIT", 10),
  rateWindowSeconds: positiveInt("RATE_WINDOW_SECONDS", 60),

  // ── Access control ─────────────────────────────────────────────────
  allowedUsers: optional("ALLOWED_USERS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Conversation ───────────────────────────────────────────────────
  maxHistory: positiveInt("MAX_HISTORY", 20),
  maxToolRounds: positiveInt("MAX_TOOL_ROUNDS", 10),
  userCostCap: Number(process.env.USER_COST_CAP ?? 0),

  // ── Redis ──────────────────────────────────────────────────────────
  redisUrl: optional("REDIS_URL", ""),
  sessionTtl: positiveInt("SESSION_TTL", 60 * 60 * 24 * 30),

  // ── Server ─────────────────────────────────────────────────────────
  port: positiveInt("PORT", 8080),
  webhookUrl: optional("WEBHOOK_URL", ""),
  logLevel: optional("LOG_LEVEL", "info"),
} as const;
