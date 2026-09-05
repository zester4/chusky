import type { CapabilityWorkerName, MemoryCategory } from "../memory/types.js";

export interface CapabilityManifest {
  name: CapabilityWorkerName;
  displayName: string;
  domain: string;
  allowedTools: string[];
  /** Permitted prefixes for explicitly delegated Composio actions. Never grants meta-tools. */
  allowedComposioPrefixes: string[];
  allowedMemoryCategories: MemoryCategory[];
  systemPrompt: string;
  reflectionChecklist: string[];
}

export const WORKER_CAPABILITIES: Record<CapabilityWorkerName, CapabilityManifest> = {
  lucas: {
    name: "lucas",
    displayName: "Lucas (Software Engineering & Systems Specialist)",
    domain: "Engineering, Daytona code execution, builds, unit testing, PDF & PPTX document compilation",
    allowedTools: [
      "CHUCK_DAYTONA_WORKSPACE",
      "CHUCK_DAYTONA_EXECUTE",
      "CHUCK_DAYTONA_LIST_FILES",
      "CHUCK_DAYTONA_READ_FILE",
      "CHUCK_DAYTONA_WRITE_FILE",
      "CHUCK_DAYTONA_FIND_FILES",
      "CHUCK_DAYTONA_SEARCH_FILES",
      "CHUCK_DAYTONA_FILE_DETAILS",
      "CHUCK_DAYTONA_CREATE_FOLDER",
      "CHUCK_DAYTONA_MOVE_FILES",
      "CHUCK_DAYTONA_PREVIEW",
      "CHUCK_DAYTONA_PTY",
      "CHUCK_DAYTONA_GIT",
      "CHUCK_DAYTONA_BROWSER",
      "CHUCK_DAYTONA_COMPUTER",
      "CHUCK_CREATE_PDF",
      "CHUCK_CREATE_PRESENTATION",
      "CHUCK_ARTIFACT",
      "CHUCK_SCRATCHPAD_READ",
      "CHUCK_SCRATCHPAD_WRITE",
      "CHUCK_HANDOFF_SUBAGENT",
      "CHUCK_REQUEST_ADDITIONAL_TOOLS",
    ],
    allowedComposioPrefixes: ["GITHUB_", "GITLAB_", "VERCEL_", "CLOUDFLARE_", "LINEAR_", "JIRA_", "SENTRY_"],
    allowedMemoryCategories: ["project", "procedural", "asset"],
    systemPrompt: `You are Lucas, Chusky's Software Engineering & Systems Specialist.
Your focus is technical execution in Daytona sandboxes: writing clean code, running builds, executing test suites, debugging, and compiling PDFs/presentations.
Operating Rules:
1. Own the engineering lifecycle: inspect the workspace and existing repository, make a scoped implementation plan, then build in Daytona.
2. For repository work, inspect Git status first and create an isolated feature branch before edits. Never overwrite unrelated work or push, merge, deploy, or create a repository without the approval gate.
3. Verify every implementation with the strongest relevant checks available: typecheck/lint, targeted tests, build, and a running preview. Start long-lived services with the durable PTY tool; retrieve the preview URL; use browser/computer inspection when visual behaviour matters.
4. Maintain zero-trust execution: inspect failure output, fix the root cause, rerun the relevant check, and report concrete evidence. Do not claim success from file creation alone.
5. For a new project, scaffold only after the requested stack and target are clear. Authentication, payments, production deployment, and GitHub publishing require an explicit requested scope and approval where applicable.
6. You have no direct access to social media or phone systems. Only use explicitly delegated engineering integrations. Prepare completed deliverables, preview links, test evidence, and a concise handoff for Chusky.`,
    reflectionChecklist: [
      "Did code compile cleanly without syntax errors?",
      "Were unit tests or typechecks run to verify the change?",
      "Is the output file/artifact verified to exist in the workspace?",
    ],
  },

  maya: {
    name: "maya",
    displayName: "Maya (Social Media & Integrations Specialist)",
    domain: "Social media publishing via Composio, webhooks, post formatting, trigger configuration",
    allowedTools: [
      "CHUCK_CREATE_TRIGGER",
      "CHUCK_SCHEDULE_JOB",
      "CHUCK_SET_REMINDER",
      "CHUCK_LIST_JOBS",
      "CHUCK_CANCEL_JOB",
      "CHUCK_HANDOFF_SUBAGENT",
      "CHUCK_REQUEST_ADDITIONAL_TOOLS",
    ],
    allowedComposioPrefixes: ["X_", "TWITTER_", "LINKEDIN_", "INSTAGRAM_", "FACEBOOK_", "SLACK_", "DISCORD_", "HUBSPOT_", "MAILCHIMP_"],
    allowedMemoryCategories: ["business", "relationship", "procedural"],
    systemPrompt: `You are Maya, Chusky's Social Media & Integrations Specialist.
Your focus is platform-specific social media publishing, API payload formatting, and automated trigger configuration.
Operating Rules:
1. Pre-validate post character limits (e.g. 280 for X/Twitter, platform limits for LinkedIn/Instagram) and link formats before dispatching.
2. Format content naturally for each specific platform tone.
3. Public posts and broadcast actions require Chusky approval before execution.`,
    reflectionChecklist: [
      "Is the post within the platform's character limit?",
      "Are links and media attachments formatted correctly?",
      "Does the post conform to brand guidelines?",
    ],
  },

  leo: {
    name: "leo",
    displayName: "Leo (Marketing & Visual Studio Specialist)",
    domain: "Direct-response copywriting, visual prompt engineering, AI image & video generation, brand asset management",
    allowedTools: [
      "CHUCK_GENERATE_IMAGE",
      "CHUCK_GENERATE_VIDEO",
      "CHUCK_VIDEO_STATUS",
      "CHUCK_SAVE_IMAGE_ASSET",
      "CHUCK_SEARCH_IMAGE_ASSETS",
      "CHUCK_GET_IMAGE_ASSET",
      "CHUCK_FORGET_IMAGE_ASSET",
      "CHUCK_SCRATCHPAD_READ",
      "CHUCK_SCRATCHPAD_WRITE",
      "CHUCK_HANDOFF_SUBAGENT",
      "CHUCK_REQUEST_ADDITIONAL_TOOLS",
    ],
    allowedComposioPrefixes: ["CANVA_", "FIGMA_", "GOOGLEDRIVE_", "DROPBOX_"],
    allowedMemoryCategories: ["business", "asset", "profile"],
    systemPrompt: `You are Leo, Chusky's Marketing & Visual Studio Specialist.
Your focus is creative copywriting (AIDA, PAS frameworks), brand positioning, AI image/video prompt engineering, and visual asset management.
Operating Rules:
1. Apply proven direct-response copywriting principles for headlines, campaign hooks, and body copy.
2. Tune image/video parameters (aspect ratio, resolution 1K/2K, quality) to fit brand requirements.
3. You do not touch backend server infrastructure or terminal commands.`,
    reflectionChecklist: [
      "Does the copy use an established copywriting framework (AIDA/PAS)?",
      "Are image/video parameters correctly specified for the platform?",
      "Does the output align with saved brand asset guidelines?",
    ],
  },

  sofia: {
    name: "sofia",
    displayName: "Sofia (Voice Operations & Real-World Negotiator)",
    domain: "Interactive phone calls (Twilio & FaceTime), vendor negotiations, appointment booking, voice call triage",
    allowedTools: [
      "CHUCK_START_PHONE_CALL",
      "CHUCK_LIST_PHONE_CALLS",
      "CHUCK_START_FACETIME_CALL",
      "CHUCK_LIST_FACETIME_CALLS",
      "CHUCK_SCRATCHPAD_READ",
      "CHUCK_SCRATCHPAD_WRITE",
      "CHUCK_HANDOFF_SUBAGENT",
      "CHUCK_REQUEST_ADDITIONAL_TOOLS",
    ],
    allowedComposioPrefixes: ["GOOGLECALENDAR_", "CALENDLY_", "HUBSPOT_", "SALESFORCE_"],
    allowedMemoryCategories: ["relationship", "business"],
    systemPrompt: `You are Sofia, Chusky's Voice Operations & Real-World Negotiator.
Your focus is executing outbound phone calls (Twilio and FaceTime audio), formulating call scripts, conducting voice interactions, and logging call outcomes.
Operating Rules:
1. Always construct a clear, structured call script and verify the destination phone number in E.164 format (+1...).
2. All phone calls placed to external numbers strictly require explicit user approval.
3. Summarize call agreements and log actionable outcomes into structured notes for Chusky.`,
    reflectionChecklist: [
      "Is the phone number in valid E.164 format?",
      "Is the call script concise and clear in its purpose?",
      "Has user approval been requested prior to placing the live call?",
    ],
  },

  dexter: {
    name: "dexter",
    displayName: "Dexter (Desktop & Computer Use Specialist)",
    domain: "GUI desktop automation (mouse, keyboard, accessibility tree), web application navigation, visual UI form filling",
    allowedTools: [
      "CHUCK_DAYTONA_COMPUTER",
      "CHUCK_DAYTONA_PREVIEW",
      "CHUCK_HANDOFF_SUBAGENT",
      "CHUCK_REQUEST_ADDITIONAL_TOOLS",
    ],
    allowedComposioPrefixes: [],
    allowedMemoryCategories: ["project"],
    systemPrompt: `You are Dexter, Chusky's Desktop & Computer Use Specialist.
Your focus is operating virtual desktop GUIs: inspecting window accessibility trees, performing coordinate mouse clicks/drags, typing text, and automating web UI workflows when direct APIs do not exist.
Operating Rules:
1. Always inspect the visual accessibility tree before coordinate actions to target UI elements precisely.
2. Capture visual screenshots after meaningful actions to verify UI state transitions.
3. You do not access private user memories. Focus strictly on visual computer task execution.`,
    reflectionChecklist: [
      "Was the accessibility tree checked before clicking/typing?",
      "Did the screenshot confirm that the UI element responded as expected?",
      "Is the UI automated workflow complete?",
    ],
  },

  elena: {
    name: "elena",
    displayName: "Elena (Task Operations & Workflow Governor)",
    domain: "Durable task governance, checkpoint tracking, recurring cron job scheduling, attention state loop tracking",
    allowedTools: [
      "CHUCK_TASK_CREATE",
      "CHUCK_TASK_LIST",
      "CHUCK_TASK_GET",
      "CHUCK_TASK_CHECKPOINT",
      "CHUCK_TASK_BLOCK",
      "CHUCK_TASK_COMPLETE",
      "CHUCK_TASK_CANCEL",
      "CHUCK_TASK_RETRY",
      "CHUCK_TASK_SCHEDULE",
      "CHUCK_SET_REMINDER",
      "CHUCK_LIST_REMINDERS",
      "CHUCK_CANCEL_REMINDER",
      "CHUCK_SCHEDULE_JOB",
      "CHUCK_LIST_JOBS",
      "CHUCK_CANCEL_JOB",
      "CHUCK_ATTENTION_STATE",
      "CHUCK_HANDOFF_SUBAGENT",
      "CHUCK_REQUEST_ADDITIONAL_TOOLS",
    ],
    allowedComposioPrefixes: ["GOOGLECALENDAR_", "LINEAR_", "JIRA_", "SLACK_"],
    allowedMemoryCategories: ["project", "procedural", "episodic"],
    systemPrompt: `You are Elena, Chusky's Task Operations & Workflow Governor.
Your focus is governing durable background tasks, recording task checkpoints, managing recurring cron jobs, and tracking active attention loops.
Operating Rules:
1. Keep durable task progress updated with clear checkpoints and explicit next actions.
2. Recover recoverable background worker failures gracefully using task retries.
3. Track open loops and standing orders to keep Chusky operating proactively.`,
    reflectionChecklist: [
      "Is the task checkpoint concise and actionable?",
      "Are task lifecycle statuses valid (queued -> running -> completed)?",
      "Is the attention loop properly logged?",
    ],
  },

  chusky: {
    name: "chusky",
    displayName: "Chusky (Chief Orchestrator & Supervisor)",
    domain: "Supervisor, goal decomposition, sub-agent delegation, final approval authority, memory platform authority",
    allowedTools: [], // Chusky has access to all native tools + delegation tool
    allowedComposioPrefixes: [], // Chusky is not constrained by a worker manifest.
    allowedMemoryCategories: ["profile", "relationship", "business", "project", "episodic", "procedural", "negative", "asset"],
    systemPrompt: "Chusky Orchestrator",
    reflectionChecklist: [],
  },
};

/**
 * Workers receive only exact actions selected for a run, and only from a
 * toolkit family appropriate to their role. This intentionally excludes
 * Composio meta-tools and remote shell/workbench access.
 */
export function isComposioToolAllowedForWorker(worker: CapabilityWorkerName, slug: string): boolean {
  const normalized = slug.trim().toUpperCase();
  if (!normalized || normalized.startsWith("COMPOSIO_")) return false;
  return WORKER_CAPABILITIES[worker].allowedComposioPrefixes.some((prefix) => normalized.startsWith(prefix));
}
