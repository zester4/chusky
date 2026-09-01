export const RISKY_TOOL_PATTERN = /(^|_)(DELETE|REMOVE|DESTROY|SEND|POST|PUBLISH|CREATE_PAYMENT|CHARGE|TRANSFER|INVITE|REVOKE|UPDATE_PERMISSION|MERGE|DEPLOY)(_|$)/i;

export type ToolApprovalPolicy = "private" | "approval_required";

const PRIVATE_NATIVE_TOOLS = new Set([
  "CHUCK_ARTIFACT", "CHUCK_CANCEL_JOB", "CHUCK_CANCEL_REMINDER",
  "CHUCK_LIST_FACETIME_CALLS",
  "CHUCK_ATTENTION_STATE",
  "CHUCK_FORGET_MEMORY", "CHUCK_GENERATE_IMAGE", "CHUCK_GENERATE_VIDEO",
  "CHUCK_LIST_JOBS", "CHUCK_LIST_REMINDERS", "CHUCK_SAVE_MEMORY",
  "CHUCK_SCHEDULE_JOB", "CHUCK_SCRATCHPAD_CLEAR", "CHUCK_SCRATCHPAD_READ",
  "CHUCK_SCRATCHPAD_WRITE", "CHUCK_SEARCH_MEMORY", "CHUCK_SET_REMINDER",
  "CHUCK_TASK_BLOCK", "CHUCK_TASK_CANCEL", "CHUCK_TASK_CHECKPOINT",
  "CHUCK_TASK_COMPLETE", "CHUCK_TASK_CREATE", "CHUCK_TASK_GET",
  "CHUCK_TASK_LIST", "CHUCK_TASK_RETRY", "CHUCK_TASK_SCHEDULE",
]);

const PRIVATE_COMPOSIO_META_TOOLS = new Set([
  "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_SEARCH_TOOL",
]);

function nestedToolSlug(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as Record<string, unknown>;
  for (const key of ["tool_slug", "toolSlug", "slug", "name"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return undefined;
}

function nestedToolArguments(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") return {};
  const value = item as Record<string, unknown>;
  const raw = value.arguments ?? value.args;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

/**
 * The explicit registry protects Chusky-native contracts. Composio provider
 * tools remain classified conservatively by their externally-visible action
 * name because their catalogue is dynamic. New CHUCK_* tools fail closed until
 * they are deliberately added here.
 */
export function toolApprovalPolicy(slug: string, args: Record<string, unknown> = {}): ToolApprovalPolicy {
  if (slug === "CHUCK_DAYTONA_GIT") {
    // Daytona is Chusky's private workspace; only pushing leaves it.
    return String(args.action ?? "") === "push" ? "approval_required" : "private";
  }
  if (slug.startsWith("CHUCK_DAYTONA_")) return "private";
  if (slug === "CHUCK_CREATE_TRIGGER") return "approval_required";
  if (PRIVATE_NATIVE_TOOLS.has(slug) || PRIVATE_COMPOSIO_META_TOOLS.has(slug)) return "private";
  if (slug === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const tools = args.tools;
    if (!Array.isArray(tools) || tools.length === 0) return "approval_required";
    return tools.some((item) => {
      const nested = nestedToolSlug(item);
      return !nested || toolApprovalPolicy(nested, nestedToolArguments(item)) === "approval_required";
    }) ? "approval_required" : "private";
  }
  if (slug.startsWith("CHUCK_")) return "approval_required";
  return RISKY_TOOL_PATTERN.test(slug) ? "approval_required" : "private";
}

const STATUSES: Record<string, string> = {
  CHUCK_START_FACETIME_CALL: "📞 I’m preparing that FaceTime call…",
  CHUCK_LIST_FACETIME_CALLS: "📞 I’m checking your FaceTime call history…",
  CHUCK_ATTENTION_STATE: "🧠 I’m updating your private attention state…",
  COMPOSIO_MANAGE_CONNECTIONS: "🔗 I’m opening the connection screen…",
  COMPOSIO_REMOTE_BASH_TOOL: "🖥️ I’m running that command…",
  COMPOSIO_REMOTE_WORKBENCH: "🛠️ I’m working in your remote workspace…",
  COMPOSIO_SEARCH_TOOL: "🔎 I’m looking for the best tool…",
  COMPOSIO_MULTI_EXECUTE_TOOL: "⚡ I’m carrying out those steps…",
  CHUCK_GENERATE_IMAGE: "🎨 I’m creating your image…",
  CHUCK_GENERATE_VIDEO: "🎬 I’m creating your video…",
  CHUCK_CREATE_TRIGGER: "🔔 I’m setting up that automation…",
  CHUCK_DAYTONA_WORKSPACE: "🖥️ I’m opening my private computer workspace…",
  CHUCK_DAYTONA_EXECUTE: "🖥️ I’m working in my private computer workspace…",
  CHUCK_DAYTONA_LIST_FILES: "📁 I’m checking my workspace files…",
  CHUCK_DAYTONA_READ_FILE: "📄 I’m opening that workspace file…",
  CHUCK_DAYTONA_WRITE_FILE: "📝 I’m saving that in my workspace…",
  CHUCK_DAYTONA_FIND_FILES: "🔍 I’m finding that file in my workspace…",
  CHUCK_DAYTONA_SEARCH_FILES: "🔍 I’m searching my workspace files…",
  CHUCK_DAYTONA_FILE_DETAILS: "📄 I’m checking that file…",
  CHUCK_DAYTONA_CREATE_FOLDER: "📁 I’m organizing my workspace…",
  CHUCK_DAYTONA_MOVE_FILES: "↔️ I’m organizing my workspace…",
  CHUCK_DAYTONA_DELETE_FILE: "🗑️ I’m removing that file…",
  CHUCK_DAYTONA_DELETE_WORKSPACE: "🗑️ I’m removing my computer workspace…",
  CHUCK_DAYTONA_PREVIEW: "🌐 I’m opening the preview…",
  CHUCK_DAYTONA_CREATE_SNAPSHOT: "📦 I’m saving a restore point…",
  CHUCK_DAYTONA_COMPUTER: "🖥️ I’m using my private computer…",
  CHUCK_DAYTONA_PAUSE: "⏸️ I’m putting my computer workspace on standby…",
  CHUCK_DAYTONA_PTY: "⌨️ I’m working in your persistent terminal…",
  CHUCK_DAYTONA_GIT: "🔀 I’m working with the repository…",
  CHUCK_DAYTONA_BROWSER: "🌐 I’m browsing with my private computer workspace…",
  CHUCK_ARTIFACT: "📦 I’m preparing your deliverable…",
  CHUCK_TASK_CREATE: "📌 I’m setting up a durable task…",
  CHUCK_TASK_LIST: "📋 I’m checking your tasks…",
  CHUCK_TASK_GET: "📋 I’m checking that task…",
  CHUCK_TASK_CHECKPOINT: "💾 I’m saving task progress…",
  CHUCK_TASK_BLOCK: "⛔ I’m recording what is blocking that task…",
  CHUCK_TASK_COMPLETE: "✅ I’m marking that task complete…",
  CHUCK_TASK_CANCEL: "⏹️ I’m cancelling that task…",
  CHUCK_TASK_RETRY: "🔄 I’m re-queuing that task…",
  CHUCK_TASK_SCHEDULE: "🗓️ I’m scheduling that task…",
  CHUCK_SAVE_MEMORY: "🧠 I’m remembering that for you…",
  CHUCK_SEARCH_MEMORY: "🧠 I’m checking what I remember…",
  CHUCK_FORGET_MEMORY: "🧠 I’m removing that from memory…",
  CHUCK_SCRATCHPAD_WRITE: "📝 I’m noting that down…",
  CHUCK_SCRATCHPAD_READ: "📝 I’m checking your notes…",
  CHUCK_SCRATCHPAD_CLEAR: "📝 I’m clearing that note…",
  CHUCK_SET_REMINDER: "⏰ I’m setting that reminder…",
  CHUCK_LIST_REMINDERS: "⏰ I’m checking your reminders…",
  CHUCK_CANCEL_REMINDER: "⏰ I’m cancelling that reminder…",
  CHUCK_SCHEDULE_JOB: "🗓️ I’m scheduling that recurring task…",
  CHUCK_LIST_JOBS: "🗓️ I’m checking your scheduled tasks…",
  CHUCK_CANCEL_JOB: "🗓️ I’m cancelling that scheduled task…",
};

export function isRiskyToolSlug(slug: string, args?: Record<string, unknown>): boolean {
  return toolApprovalPolicy(slug, args) === "approval_required";
}

export function humanToolStatus(slug: string): string {
  if (STATUSES[slug]) return STATUSES[slug];
  // Internal tools must never become part of the product's voice when a new
  // capability is added before its user-facing copy is mapped above.
  if (slug.startsWith("CHUCK_") || slug.startsWith("COMPOSIO_")) return "⚙️ I’m taking care of that…";
  const parts = slug.split("_");
  const toolkit = parts[0] ? parts[0].charAt(0) + parts[0].slice(1).toLowerCase() : slug;
  const action = parts.slice(1).join(" ").toLowerCase() || "that task";
  return `⚙️ I’m using ${toolkit} to ${action}…`;
}
