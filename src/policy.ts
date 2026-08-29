export const RISKY_TOOL_PATTERN = /(^|_)(DELETE|REMOVE|DESTROY|SEND|POST|PUBLISH|CREATE_PAYMENT|CHARGE|TRANSFER|INVITE|REVOKE|UPDATE_PERMISSION|MERGE|DEPLOY)(_|$)/i;

const STATUSES: Record<string, string> = {
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
  // Daytona is Chusky's private agent sandbox. The agent may freely use its
  // desktop, shell, filesystem, and workspace lifecycle without interrupting
  // the user for approval. External side effects remain gated below.
  if (slug === "CHUCK_DAYTONA_GIT" && String(args?.action ?? "") === "push") return true;
  if (slug.startsWith("CHUCK_DAYTONA_")) return false;
  if (slug === "CHUCK_DAYTONA_COMPUTER") {
    return ["mouse_click", "mouse_drag", "keyboard_type", "keyboard_press", "keyboard_hotkey", "accessibility_invoke", "accessibility_set_value"].includes(String(args?.action ?? ""));
  }
  return RISKY_TOOL_PATTERN.test(slug) || [
    "CHUCK_DAYTONA_EXECUTE", "CHUCK_DAYTONA_WRITE_FILE", "CHUCK_DAYTONA_MOVE_FILES",
    "CHUCK_DAYTONA_DELETE_FILE", "CHUCK_DAYTONA_DELETE_WORKSPACE", "CHUCK_DAYTONA_CREATE_SNAPSHOT",
  ].includes(slug);
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
