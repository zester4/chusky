export const RISKY_TOOL_PATTERN = /(^|_)(DELETE|REMOVE|DESTROY|SEND|POST|PUBLISH|CREATE_PAYMENT|CHARGE|TRANSFER|INVITE|REVOKE|UPDATE_PERMISSION|MERGE|DEPLOY)(_|$)/i;

const STATUSES: Record<string, string> = {
  COMPOSIO_MANAGE_CONNECTIONS: "🔗 I’m opening the connection screen…",
  COMPOSIO_REMOTE_BASH_TOOL: "🖥️ I’m running that command…",
  COMPOSIO_REMOTE_WORKBENCH: "🛠️ I’m working in your remote workspace…",
  COMPOSIO_SEARCH_TOOL: "🔎 I’m looking for the best tool…",
  COMPOSIO_MULTI_EXECUTE_TOOL: "⚡ I’m carrying out those steps…",
  CHUCK_DAYTONA_WORKSPACE: "🖥️ I’m opening your isolated workspace…",
  CHUCK_DAYTONA_EXECUTE: "🖥️ I’m running that in your isolated workspace…",
  CHUCK_DAYTONA_LIST_FILES: "📁 I’m listing workspace files…",
  CHUCK_DAYTONA_READ_FILE: "📄 I’m reading a workspace file…",
  CHUCK_DAYTONA_WRITE_FILE: "📝 I’m writing to your workspace…",
  CHUCK_DAYTONA_FIND_FILES: "🔍 I’m searching workspace contents…",
  CHUCK_DAYTONA_SEARCH_FILES: "🔍 I’m finding workspace files…",
  CHUCK_DAYTONA_FILE_DETAILS: "📄 I’m checking workspace metadata…",
  CHUCK_DAYTONA_CREATE_FOLDER: "📁 I’m creating a workspace folder…",
  CHUCK_DAYTONA_MOVE_FILES: "↔️ I’m moving workspace files…",
  CHUCK_DAYTONA_DELETE_FILE: "🗑️ I’m deleting from your workspace…",
  CHUCK_DAYTONA_DELETE_WORKSPACE: "🗑️ I’m permanently deleting your workspace…",
  CHUCK_DAYTONA_PREVIEW: "🌐 I’m opening a workspace preview…",
  CHUCK_DAYTONA_CREATE_SNAPSHOT: "📦 I’m saving a workspace snapshot…",
  CHUCK_DAYTONA_COMPUTER: "🖥️ I’m operating your Daytona desktop…",
  CHUCK_DAYTONA_PAUSE: "⏸️ I’m pausing your workspace…",
  CHUCK_TASK_CREATE: "📌 I’m setting up a durable task…",
  CHUCK_TASK_LIST: "📋 I’m checking your tasks…",
  CHUCK_TASK_GET: "📋 I’m checking that task…",
  CHUCK_TASK_CHECKPOINT: "💾 I’m saving task progress…",
  CHUCK_TASK_BLOCK: "⛔ I’m recording what is blocking that task…",
  CHUCK_TASK_COMPLETE: "✅ I’m marking that task complete…",
  CHUCK_TASK_CANCEL: "⏹️ I’m cancelling that task…",
  CHUCK_TASK_RETRY: "🔄 I’m re-queuing that task…",
  CHUCK_TASK_SCHEDULE: "🗓️ I’m scheduling that task…",
};

export function isRiskyToolSlug(slug: string, args?: Record<string, unknown>): boolean {
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
  const parts = slug.split("_");
  const toolkit = parts[0] ? parts[0].charAt(0) + parts[0].slice(1).toLowerCase() : slug;
  const action = parts.slice(1).join(" ").toLowerCase() || "that task";
  return `⚙️ I’m using ${toolkit} to ${action}…`;
}
