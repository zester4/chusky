//src/policy.ts
import { composioMetadataPolicy } from "./composioRisk.js";

// Routine communications and content publishing are autonomous. Keep the
// approval boundary for destructive, financial, permission-changing, and
// deployment actions that can cause material or irreversible harm.
export const RISKY_TOOL_PATTERN = /(^|_)(DELETE|REMOVE|DESTROY|ERASE|PURGE|PAYMENT|CHARGE|TRANSFER|REFUND|PURCHASE|CHECKOUT|PLACE_ORDER|CREATE_ORDER|ADD_PAYMENT_METHOD|SUBSCRIBE|INVITE|REVOKE|GRANT|UPDATE_PERMISSION|CHANGE_ROLE|UPDATE_ROLE|ADD_MEMBER|REMOVE_MEMBER|MERGE|DEPLOY)(_|$)|(^|_)(GIT|GITHUB|GITLAB|BITBUCKET)_?PUSH(_|$)/i;
const COMPOSIO_READ_ONLY_PATTERN = /(^|_)(GET|LIST|SEARCH|FETCH|READ|LOOKUP|CHECK|VERIFY|DESCRIBE|FIND|RETRIEVE|COUNT|VIEW|PREVIEW|VALIDATE)(_|$)/i;
const COMPOSIO_WRITE_PATTERN = /(^|_)(CREATE|UPDATE|SET|ADD|SEND|POST|PUBLISH|WRITE|UPLOAD|MOVE|ARCHIVE|CLOSE|ENABLE|DISABLE|CHANGE|MODIFY|SUBSCRIBE|UNSUBSCRIBE)(_|$)/i;
const COMPOSIO_AUTONOMOUS_PATTERN = /(^|_)(SEND_EMAIL|SEND_CAMPAIGN|POST_MESSAGE|PUBLISH_POST|CREATE_DRAFT|UPDATE_DRAFT|CREATE_ISSUE|CREATE_NOTE|ADD_COMMENT)(_|$)/i;
const KNOWN_COMPOSIO_TOOLKIT_PATTERN = /^(GMAIL|GOOGLECALENDAR|CALENDLY|SLACK|X|NEWSLETTER|HUBSPOT|SALESFORCE|PIPEDRIVE|NOTION|ZENDESK|INTERCOM|OUTLOOK|MICROSOFT|LINKEDIN|TRELLO|ASANA|LINEAR|JIRA|GITHUB|GITLAB|DROPBOX|GOOGLEDRIVE|SHOPIFY|WOOCOMMERCE|STRIPE|TWILIO|SENDGRID|MAILCHIMP|TAVILY|EXA|FIRECRAWL)_/i;

export type ToolApprovalPolicy = "private" | "approval_required";

const PRIVATE_NATIVE_TOOLS = new Set([
  "CHUCK_SEARCH_SKILLS", "CHUCK_LIST_SKILL_FILES", "CHUCK_READ_SKILL_FILE", "CHUCK_LIST_CONNECTED_ACCOUNTS",
  "CHUCK_TOOL_PREFLIGHT", "CHUCK_INTEGRATION_HEALTH", "CHUCK_ARTIFACT_QA", "CHUCK_TOOL_RECOVERY",
  // Explicitly requested owner image publishing runs in the same turn. The
  // bridge still enforces ownership, validation, and the exact action schema.
  "CHUCK_MEDIA_BRIDGE",
  "CHUCK_ARTIFACT", "CHUCK_CREATE_PDF", "CHUCK_CREATE_PRESENTATION", "CHUCK_CANCEL_JOB", "CHUCK_CANCEL_REMINDER", "CHUCK_PAUSE_REMINDER", "CHUCK_RESUME_REMINDER", "CHUCK_RUN_REMINDER_NOW",
  "CHUCK_EMAIL_ARTIFACT",
  "CHUCK_CREATE_DOCUMENT", "CHUCK_CREATE_SPREADSHEET", "CHUCK_CREATE_TRIGGER", "CHUCK_UPDATE_MEMORY",
  "CHUCK_START_PHONE_CALL", "CHUCK_LIST_PHONE_CALLS", "CHUCK_ATTENTION_PULSE", "CHUCK_VIDEO_STATUS",
  // Meeting participation is available only after the user's explicit join
  // request and uses a visible bot identity; leave/status/list are owner-scoped.
  "CHUCK_MEETING_JOIN", "CHUCK_MEETING_LIST", "CHUCK_MEETING_STATUS", "CHUCK_MEETING_LEAVE", "CHUCK_MEETING_PROFILE_GET",
  // These meeting tools are narrowly scoped by the active owned meeting and
  // its enabled representative profile. Contact capture stores only details
  // shared for an agreed next step; follow-up scheduling binds one contact to
  // the exact email action already granted by the owner.
  "CHUCK_MEETING_CONTEXT_LOOKUP", "CHUCK_MEETING_CONTACT_CAPTURE", "CHUCK_MEETING_CONTACTS_LIST", "CHUCK_MEETING_FOLLOWUP_SCHEDULE",
  "CHUCK_ATTENTION_STATE",
  // Autonomy controls inspect owner-scoped state, run bounded read-only
  // reconciliation, or start an internal durable mission. Provider side
  // effects remain governed by the normal tool approval boundary.
  "CHUCK_AUTONOMY_STATUS", "CHUCK_AUTONOMY_RECONCILE", "CHUCK_AUTONOMY_PLAYBOOK",
  "CHUCK_GENERATE_IMAGE", "CHUCK_GENERATE_VIDEO",
  "CHUCK_LIST_JOBS", "CHUCK_LIST_REMINDERS", "CHUCK_SAVE_MEMORY",
  "CHUCK_SCHEDULE_JOB", "CHUCK_PAUSE_JOB", "CHUCK_RESUME_JOB", "CHUCK_RUN_JOB_NOW", "CHUCK_SCRATCHPAD_READ",
  "CHUCK_SCRATCHPAD_WRITE", "CHUCK_SEARCH_MEMORY", "CHUCK_SET_REMINDER",
  "CHUCK_TASK_BLOCK", "CHUCK_TASK_CANCEL", "CHUCK_TASK_CHECKPOINT",
  "CHUCK_TASK_COMPLETE", "CHUCK_TASK_CREATE", "CHUCK_TASK_GET",
  "CHUCK_TASK_LIST", "CHUCK_TASK_RETRY", "CHUCK_TASK_SCHEDULE",
  "CHUCK_SAVE_IMAGE_ASSET", "CHUCK_SEARCH_IMAGE_ASSETS",
  "CHUCK_GET_IMAGE_ASSET",
  "CHUCK_LIST_SUBAGENTS", "CHUCK_GET_SUBAGENT_STATUS", "CHUCK_CANCEL_SUBAGENT",
  "CHUCK_DELEGATE_SUBAGENT", "CHUCK_HANDOFF_SUBAGENT", "CHUCK_REQUEST_ADDITIONAL_TOOLS",
  "CHUCK_PLAN_DELEGATION",
  "CHUCK_RESOLVE_SUBAGENT_TOOL_REQUEST",
  "CHUCK_REVIEW_SUBAGENT_ACTION",
  "CHUCK_VAULT_SAVE", "CHUCK_VAULT_LIST", "CHUCK_VAULT_STATUS", "CHUCK_VAULT_LOGIN", "CHUCK_VAULT_LOGOUT",
  "CHUCK_DAYTONA_BROWSER", "CHUCK_DAYTONA_COMPUTER", "CHUCK_BROWSER_PLAN", "CHUCK_BROWSER_SESSION_HEALTH", "CHUCK_BROWSER_PLAYBOOK_SAVE", "CHUCK_BROWSER_PLAYBOOK_LIST", "CHUCK_BROWSER_VERIFY", "CHUCK_BROWSER_AUDIT_LIST",
  "CHUCK_DAYTONA_BROWSER_HANDOFF", "CHUCK_BROWSER_HANDOFF_STATUS", "CHUCK_BROWSER_HANDOFF_COMPLETE",
  "CHUCK_SHOPPING_START", "CHUCK_SHOPPING_LIST", "CHUCK_SHOPPING_SELECT_RETAILER", "CHUCK_SHOPPING_UPDATE", "CHUCK_SHOPPING_CANCEL", "CHUCK_SHOPPING_PAUSE", "CHUCK_SHOPPING_RESUME", "CHUCK_SHOPPING_SAVE_SITE", "CHUCK_SHOPPING_LIST_SITES",
  "CHUCK_TASK_WAIT",
  "CHUCK_MISSION_START", "CHUCK_MISSION_LIST", "CHUCK_MISSION_GET", "CHUCK_MISSION_CHECKPOINT",
  "CHUCK_MISSION_PAUSE", "CHUCK_MISSION_RESUME", "CHUCK_MISSION_CANCEL", "CHUCK_MISSION_BLOCK", "CHUCK_MISSION_COMPLETE", "CHUCK_MISSION_WAIT_EVENT", "CHUCK_MISSION_STEP_COMPLETE", "CHUCK_MISSION_REPLAN",
  "CHUCK_MISSION_PROOF", "CHUCK_MISSION_EVIDENCE", "CHUCK_MISSION_VERIFY", "CHUCK_MISSION_COMPENSATE", "CHUCK_MISSION_REPAIR",
  "CHUCK_DAYTONA_APP", "CHUCK_DAYTONA_CREATE_FOLDER", "CHUCK_DAYTONA_CREATE_SNAPSHOT", "CHUCK_DAYTONA_SANDBOX", "CHUCK_DAYTONA_VOLUME", "CHUCK_DAYTONA_SESSION", "CHUCK_DAYTONA_CODE", "CHUCK_DAYTONA_LSP",
  "CHUCK_DAYTONA_EXECUTE", "CHUCK_DAYTONA_FILE_DETAILS", "CHUCK_DAYTONA_FIND_FILES", "CHUCK_DAYTONA_REPLACE_FILES",
  "CHUCK_DAYTONA_LIST_FILES", "CHUCK_DAYTONA_PAUSE", "CHUCK_DAYTONA_PREVIEW",
  "CHUCK_DAYTONA_PTY", "CHUCK_DAYTONA_READ_FILE", "CHUCK_DAYTONA_SEARCH_FILES",
  "CHUCK_DAYTONA_WORKSPACE", "CHUCK_DAYTONA_WRITE_FILE", "CHUCK_DAYTONA_COMPUTER",
  "CHUCK_GET_IMAGE_ASSET", "CHUCK_SAVE_IMAGE_ASSET", "CHUCK_SEARCH_IMAGE_ASSETS",
  "CHUCK_MEETING_CONTEXT_PREPARE", "CHUCK_MEETING_PREPARATION_JOIN", "CHUCK_MEETING_PREPARATION_LIST",
  "CHUCK_MEETING_TRANSCRIPT_SEARCH", "CHUCK_MEETING_PROFILE_GET",
]);

// Removing durable data or altering an already-authorized control boundary
// remains approval-gated. Ordinary task, reminder, memory, browser, and
// communication work is autonomous.
const APPROVAL_NATIVE_TOOLS = new Set([
  "CHUCK_FORGET_MEMORY", "CHUCK_FORGET_IMAGE_ASSET", "CHUCK_SCRATCHPAD_CLEAR", "CHUCK_DAYTONA_SET_FILE_PERMISSIONS",
  "CHUCK_BROWSER_PLAYBOOK_REMOVE", "CHUCK_MEETING_CONTACT_DELETE", "CHUCK_MEETING_TRANSCRIPT_DELETE",
  "CHUCK_SHOPPING_REMOVE_SITE", "CHUCK_BROWSER_SESSION_REVOKE", "CHUCK_MEETING_PROFILE_UPDATE",
]);

/**
 * Mission bookkeeping changes only the owner's bounded, durable workflow
 * state. These controls must remain usable inside strict worker contracts;
 * approvals belong at the external/high-impact action boundary, not around
 * proof, evidence, checkpoints, or recovery metadata.
 */
const AUTONOMOUS_CONTROL_TOOLS = new Set([
  // User-authorized image publishing is intentionally not an approval loop.
  "CHUCK_MEDIA_BRIDGE",
  "CHUCK_AUTONOMY_STATUS", "CHUCK_AUTONOMY_RECONCILE", "CHUCK_AUTONOMY_PLAYBOOK",
  "CHUCK_MISSION_START", "CHUCK_MISSION_LIST", "CHUCK_MISSION_GET", "CHUCK_MISSION_PROOF",
  "CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_WAIT_EVENT", "CHUCK_MISSION_STEP_COMPLETE",
  "CHUCK_MISSION_REPLAN", "CHUCK_MISSION_PAUSE", "CHUCK_MISSION_RESUME", "CHUCK_MISSION_CANCEL",
  "CHUCK_MISSION_BLOCK", "CHUCK_MISSION_COMPLETE", "CHUCK_MISSION_EVIDENCE",
  "CHUCK_MISSION_VERIFY", "CHUCK_MISSION_COMPENSATE", "CHUCK_MISSION_REPAIR",
]);

const PRIVATE_COMPOSIO_META_TOOLS = new Set([
  "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_SEARCH_TOOL",
  "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_SEARCH_WEB",
  "COMPOSIO_SEARCH_FETCH_URL_CONTENT", "COMPOSIO_GET_TOOL_SCHEMAS",
]);

function composioActionPolicy(slug: string): ToolApprovalPolicy {
  const metadataPolicy = composioMetadataPolicy(slug);
  if (metadataPolicy) return metadataPolicy;
  if (!slug || RISKY_TOOL_PATTERN.test(slug)) return "approval_required";
  if (COMPOSIO_READ_ONLY_PATTERN.test(slug) || COMPOSIO_AUTONOMOUS_PATTERN.test(slug)) return "private";
  // Ordinary provider writes (CRM updates, drafts, notes, calendar changes,
  // routine messages, and similar reversible work) are autonomous. The
  // high-impact pattern above still gates money, purchases, deletion,
  // permissions, and Git/deploy operations. Unknown
  // write-shaped actions remain fail-closed; an unclassified read/utility
  // slug keeps the legacy autonomous behavior used by native test adapters.
  if (COMPOSIO_WRITE_PATTERN.test(slug)) {
    return KNOWN_COMPOSIO_TOOLKIT_PATTERN.test(slug) ? "private" : "approval_required";
  }
  return "private";
}

/**
 * The explicit registry protects Chusky-native contracts. Composio provider
 * tools remain classified by their externally-visible action name because the
 * catalogue is dynamic; unknown write-shaped actions fail closed until
 * provider risk metadata is available at this boundary. New CHUCK_* tools
 * fail closed until they are deliberately added here.
 */
export function toolApprovalPolicy(slug: string, args: Record<string, unknown> = {}): ToolApprovalPolicy {
  if (slug === "CHUCK_DAYTONA_BROWSER") {
    if (["checkout", "place_order", "purchase", "change_address", "add_payment_method", "unknown"].includes(String(args.vaultAction ?? ""))) return "approval_required";
    return "private";
  }
  if (slug === "CHUCK_DAYTONA_GIT") {
    // Daytona is Chusky's private workspace; only pushing leaves it.
    return String(args.action ?? "") === "push" ? "approval_required" : "private";
  }
  if (["CHUCK_DAYTONA_DELETE_FILE", "CHUCK_DAYTONA_DELETE_WORKSPACE"].includes(slug)) return "approval_required";
  if (slug === "CHUCK_DAYTONA_VOLUME" && String(args.action ?? "") === "delete") return "approval_required";
  if (slug === "CHUCK_ARTIFACT" && String(args.action ?? "") === "delete" && args.removeFile === true) return "approval_required";
  if (slug === "CHUCK_DAYTONA_SET_FILE_PERMISSIONS") return "approval_required";
  if (slug.startsWith("CHUCK_DAYTONA_")) return "private";
  if (APPROVAL_NATIVE_TOOLS.has(slug)) return "approval_required";
  if (PRIVATE_NATIVE_TOOLS.has(slug) || PRIVATE_COMPOSIO_META_TOOLS.has(slug)) return "private";
  if (slug === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    // Batch execution stays autonomous for routine communication/content
    // actions and pauses only when a nested action is materially risky.
    const nested = Array.isArray(args.tools) ? args.tools : [];
    const hasSideEffect = nested.some((item) => {
      const name = item && typeof item === "object" ? String((item as Record<string, unknown>).tool_slug ?? (item as Record<string, unknown>).name ?? "") : "";
      return composioActionPolicy(name) === "approval_required";
    });
    return hasSideEffect ? "approval_required" : "private";
  }
  if (slug === "COMPOSIO_EXECUTE_TOOL") {
    const nestedSlug = String(args.tool_slug ?? args.slug ?? "");
    return composioActionPolicy(nestedSlug);
  }
  if (slug.startsWith("CHUCK_")) return "approval_required";
  return composioActionPolicy(slug);
}

const STATUSES: Record<string, string> = {
  CHUCK_SEARCH_SKILLS: "🧭 I’m bringing in the relevant guidance…",
  CHUCK_TOOL_PREFLIGHT: "🧪 I’m checking the tool and its arguments…",
  CHUCK_INTEGRATION_HEALTH: "🔌 I’m checking the connected app status…",
  CHUCK_ARTIFACT_QA: "📄 I’m independently checking the rendered file…",
  CHUCK_TOOL_RECOVERY: "🛠️ I’m checking the saved execution outcome…",
  CHUCK_FILE_BRIDGE: "📎 I’m preparing the approved file transfer…",
  CHUCK_MEDIA_BRIDGE: "🖼️ I’m transferring your image…",
  CHUCK_LIST_SKILL_FILES: "🧭 I’m checking the supporting guidance…",
  CHUCK_READ_SKILL_FILE: "📖 I’m reviewing the relevant guidance…",
  CHUCK_START_PHONE_CALL: "📞 I’m preparing that phone call…",
  CHUCK_LIST_PHONE_CALLS: "📞 I’m checking my phone-call history…",
  CHUCK_LIST_CONNECTED_ACCOUNTS: "🔌 I’m checking your connected apps…",
  CHUCK_MEETING_JOIN: "🎥 I’m joining the meeting...",
  CHUCK_MEETING_PREPARATION_LIST: "🗓️ I’m checking the prepared calendar meetings…",
  CHUCK_MEETING_PREPARATION_JOIN: "🎥 I’m preparing to join that calendar meeting…",
  CHUCK_MEETING_LIST: "🎥 I’m checking my meeting...",
  CHUCK_MEETING_STATUS: "🎥 I’m checking that meeting’s status…",
  CHUCK_MEETING_LEAVE: "🎥 I’m leaving the meeting...",
  CHUCK_ATTENTION_STATE: "🧠 I’m updating the private attention state…",
  COMPOSIO_MANAGE_CONNECTIONS: "🔗 I’m opening the connection screen…",
  COMPOSIO_REMOTE_BASH_TOOL: "🖥️ I’m running that command…",
  COMPOSIO_REMOTE_WORKBENCH: "🛠️ I’m working in my remote workspace…",
  COMPOSIO_SEARCH_TOOL: "🔎 I’m finding the right connected capability…",
  COMPOSIO_SEARCH_TOOLS: "🔎 I’m finding the right connected capability…",
  COMPOSIO_SEARCH_WEB: "🌐 I’m searching the live web…",
  COMPOSIO_SEARCH_FETCH_URL_CONTENT: "🔗 I’m reading that URL…",
  COMPOSIO_GET_TOOL_SCHEMAS: "🧩 I’m checking how that capability works…",
  COMPOSIO_EXECUTE_TOOL: "⚡ I’m carrying that out through the connected app…",
  COMPOSIO_MULTI_EXECUTE_TOOL: "⚡ I’m carrying those steps out through the connected apps…",
  CHUCK_GENERATE_IMAGE: "🎨 I’m creating your image…",
  CHUCK_GENERATE_VIDEO: "🎬 I’m creating your video…",
  CHUCK_CREATE_TRIGGER: "🔔 I’m setting up that automation…",
  CHUCK_DAYTONA_WORKSPACE: "🖥️ I’m opening my private computer workspace…",
  CHUCK_DAYTONA_SANDBOX: "🧭 I’m checking the private Daytona sandbox…",
  CHUCK_DAYTONA_EXECUTE: "🖥️ I’m working in my private computer workspace…",
  CHUCK_DAYTONA_LIST_FILES: "📁 I’m checking my workspace files…",
  CHUCK_DAYTONA_READ_FILE: "📄 I’m opening that workspace file…",
  CHUCK_DAYTONA_WRITE_FILE: "📝 I’m saving that in my workspace…",
  CHUCK_DAYTONA_REPLACE_FILES: "📝 I’m updating my workspace files…",
  CHUCK_DAYTONA_SET_FILE_PERMISSIONS: "🔐 I’m changing workspace file permissions…",
  CHUCK_DAYTONA_FIND_FILES: "🔍 I’m finding that file in my workspace…",
  CHUCK_DAYTONA_SEARCH_FILES: "🔍 I’m searching my workspace files…",
  CHUCK_DAYTONA_FILE_DETAILS: "📄 I’m checking that file…",
  CHUCK_DAYTONA_CREATE_FOLDER: "📁 I’m organizing my workspace…",
  CHUCK_DAYTONA_MOVE_FILES: "↔️ I’m organizing my workspace…",
  CHUCK_DAYTONA_DELETE_FILE: "🗑️ I’m removing that file…",
  CHUCK_DAYTONA_DELETE_WORKSPACE: "🗑️ I’m removing my computer workspace…",
  CHUCK_DAYTONA_PREVIEW: "🌐 I’m opening the preview…",
  CHUCK_DAYTONA_APP: "🚀 I’m building and running the app…",
  CHUCK_DAYTONA_CREATE_SNAPSHOT: "📦 I’m saving a restore point…",
  CHUCK_DAYTONA_COMPUTER: "🖥️ I’m using my private computer…",
  CHUCK_DAYTONA_PAUSE: "⏸️ I’m putting my computer workspace on standby…",
  CHUCK_DAYTONA_PTY: "⌨️ I’m working in your persistent terminal…",
  CHUCK_DAYTONA_SESSION: "⌨️ I’m using your durable Daytona process session…",
  CHUCK_DAYTONA_CODE: "🐍 I’m running code in your isolated Daytona interpreter…",
  CHUCK_DAYTONA_LSP: "🧩 I’m inspecting the workspace with Daytona code intelligence…",
  CHUCK_DAYTONA_GIT: "🔀 I’m working with the repository…",
  CHUCK_DAYTONA_BROWSER: "🌐 I’m browsing with my private computer workspace…",
  CHUCK_VAULT_SAVE: "🔐 I’m opening a private encrypted website-login form…",
  CHUCK_VAULT_LIST: "🔐 I’m checking the connected websites…",
  CHUCK_VAULT_STATUS: "🔐 I’m checking my secure browser session…",
  CHUCK_VAULT_LOGIN: "🔐 I’m signing in through my encrypted website identity…",
  CHUCK_VAULT_LOGOUT: "🔐 I’m ending Chusky’s saved browser session…",
  CHUCK_DAYTONA_BROWSER_HANDOFF: "🔐 I’m preparing a private browser handoff…",
  CHUCK_BROWSER_HANDOFF_STATUS: "🔐 I’m checking the private browser handoff…",
  CHUCK_BROWSER_HANDOFF_COMPLETE: "🔐 I’m verifying the private browser handoff…",
  CHUCK_SHOPPING_START: "🛒 I’m setting up your shopping plan…",
  CHUCK_SHOPPING_LIST: "🛒 I’m checking your shopping plans…",
  CHUCK_SHOPPING_SELECT_RETAILER: "🛒 I’m selecting that retailer…",
  CHUCK_SHOPPING_UPDATE: "🛒 I’m updating your shopping plan…",
  CHUCK_SHOPPING_CANCEL: "🛒 I’m cancelling that shopping plan…",
  CHUCK_SHOPPING_PAUSE: "🛒 I’m preserving your shopping session while you complete that website step…",
  CHUCK_SHOPPING_RESUME: "🛒 I’m resuming your retained shopping browser…",
  CHUCK_SHOPPING_SAVE_SITE: "🛒 I’m saving that shopping site for you…",
  CHUCK_SHOPPING_LIST_SITES: "🛒 I’m checking your saved shopping sites…",
  CHUCK_SHOPPING_REMOVE_SITE: "🛒 I’m removing that saved shopping site…",
  CHUCK_ARTIFACT: "📦 I’m preparing your deliverable…",
  CHUCK_EMAIL_ARTIFACT: "✉️ I’m attaching the deliverable to email…",
  CHUCK_CREATE_PDF: "📄 I’m building and checking your PDF…",
  CHUCK_CREATE_PRESENTATION: "📊 I’m building and checking your presentation…",
  CHUCK_TASK_CREATE: "📌 I’m setting up a durable task…",
  CHUCK_TASK_LIST: "📋 I’m checking the tasks…",
  CHUCK_TASK_GET: "📋 I’m checking the task…",
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
  CHUCK_PAUSE_REMINDER: "⏸️ I’m pausing that reminder…",
  CHUCK_RESUME_REMINDER: "▶️ I’m resuming that reminder…",
  CHUCK_RUN_REMINDER_NOW: "▶️ I’m running that reminder now…",
  CHUCK_SCHEDULE_JOB: "🗓️ I’m scheduling that recurring task…",
  CHUCK_LIST_JOBS: "🗓️ I’m checking your scheduled tasks…",
  CHUCK_PAUSE_JOB: "⏸️ I’m pausing that recurring task…",
  CHUCK_RESUME_JOB: "▶️ I’m resuming that recurring task…",
  CHUCK_RUN_JOB_NOW: "▶️ I’m starting that recurring task now…",
  CHUCK_CANCEL_JOB: "🗓️ I’m cancelling that scheduled task…",
  CHUCK_DELEGATE_SUBAGENT: "🤖 I’m delegating to a domain specialist…",
  CHUCK_LIST_SUBAGENTS: "🤖 I’m checking your worker agents…",
  CHUCK_GET_SUBAGENT_STATUS: "🔍 I’m fetching that delegation status…",
  CHUCK_CANCEL_SUBAGENT: "🛑 I’m cancelling that worker delegation…",
  CHUCK_HANDOFF_SUBAGENT: "🤝 I’m handing off to a specialist…",
  CHUCK_PLAN_DELEGATION: "🧭 I’m mapping that work to the right specialists…",
  CHUCK_REQUEST_ADDITIONAL_TOOLS: "🧩 A specialist is requesting an additional capability…",
  CHUCK_RESOLVE_SUBAGENT_TOOL_REQUEST: "🧩 I’m resuming that specialist with the verified capability…",
};

export function isRiskyToolSlug(slug: string, args?: Record<string, unknown>): boolean {
  return toolApprovalPolicy(slug, args) === "approval_required";
}

/**
 * Shared approval decision for execution paths that can add a stricter
 * per-run policy. Explicit run policies may tighten ordinary actions, but
 * cannot turn owner-scoped autonomy/mission bookkeeping into an approval
 * loop. High-impact actions always retain the central policy boundary.
 */
export function requiresToolApproval(slug: string, args: Record<string, unknown> = {}, forceApproval = false): boolean {
  if (isRiskyToolSlug(slug, args)) return true;
  if (AUTONOMOUS_CONTROL_TOOLS.has(slug)) return false;
  return forceApproval;
}

export function isReadOnlyToolSlug(slug: string): boolean {
  if (slug === "CHUCK_ATTENTION_STATE" || slug === "CHUCK_DAYTONA_FILE_DETAILS") return true;
  if (slug.includes("READ") || slug.includes("LIST") || slug.includes("SEARCH") || slug.includes("FIND") || slug.includes("STATUS") || slug.includes("GET")) {
    return !slug.includes("WRITE") && !slug.includes("CREATE") && !slug.includes("DELETE") && !slug.includes("CANCEL") && !slug.includes("START");
  }
  return false;
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

/**
 * Human-facing phases for the live Telegram progress message. These describe
 * the work Chusky is doing without exposing the model loop, prompt, or tool
 * registry to the user.
 */
export type HumanProgressPhase = "understanding" | "preparing" | "finalizing";

export function humanProgressStatus(phase: HumanProgressPhase): string {
  switch (phase) {
    case "understanding":
      return "🧠 I’m understanding what you need…";
    case "preparing":
      return "🧰 I’m lining up the best way to help…";
    case "finalizing":
      return "✍️ I’m pulling everything together…";
  }
}
