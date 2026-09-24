export type DaytonaWorkspaceAction = "get" | "create" | "status" | "pause" | "archive" | "delete";

export type DaytonaSandboxAction = "status" | "health" | "metrics" | "paths" | "fork" | "start" | "stop" | "pause" | "resize" | "lifecycle" | "wait_started" | "wait_stopped";

export interface DaytonaWorkspaceInfo {
  id: string;
  name: string;
  state?: string;
  sandboxClass?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  warmPoolId?: string;
  daemonVersion?: string;
  autoPauseInterval?: number;
  networkBlockAll?: boolean;
  domainAllowList?: string;
  capabilities?: {
    computerUse: boolean;
    processSessions: boolean;
    codeInterpreter: boolean;
    lsp: boolean;
    streamingFiles: boolean;
    volumes: boolean;
  };
}

export interface DaytonaSandboxMetrics {
  sandboxId: string;
  timestamp?: string;
  cpuUsedPct?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  diskUsedBytes?: number;
  diskTotalBytes?: number;
}

export interface DaytonaCommandResult {
  sandboxId: string;
  command: string;
  cwd?: string;
  exitCode: number;
  output: string;
  truncated: boolean;
  timedOut?: boolean;
  timeoutSeconds?: number;
}

export interface DaytonaFileInfo {
  name: string;
  path: string;
  size?: number;
  isDir?: boolean;
  modifiedAt?: string;
}

export interface DaytonaPreviewResult {
  sandboxId: string;
  port: number;
  url: string;
  expiresAt?: number;
}

export interface DaytonaAppResult {
  sandboxId: string;
  id: string;
  framework: "vite-react" | "nextjs";
  path: string;
  port: number;
  status: "scaffolded" | "verified" | "running" | "ready_for_review" | "ready_to_publish" | "stopped" | "failed";
  branch?: string;
  verification?: {
    status: "passed" | "failed" | "pending";
    checks: Array<{ name: string; status: string; output: string; completedAt: number }>;
    visual?: { status: "captured" | "passed" | "failed"; summary?: string; capturedAt: number; reviewedAt?: number };
  };
  release?: { status: "not_requested" | "awaiting_approval" | "published"; requestedAt?: number; target?: string };
  ptySessionId?: string;
  lastOutput?: string;
  url?: string;
  expiresAt?: number;
  output?: string;
}

export interface DaytonaSnapshotResult {
  sandboxId: string;
  name: string;
  created: boolean;
}

export interface DaytonaScreenshotResult {
  sandboxId: string;
  mediaType: "image/png" | "image/jpeg";
  base64: string;
  sizeBytes?: number;
}

export interface DaytonaPtyResult {
  sandboxId: string;
  sessionId: string;
  output?: string;
  sessions?: unknown[];
  exitCode?: number;
  created?: boolean;
  killed?: boolean;
}

export interface DaytonaSessionResult {
  sandboxId: string;
  sessionId?: string;
  commandId?: string;
  created?: boolean;
  deleted?: boolean;
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  sessions?: unknown[];
  session?: unknown;
  streamed?: boolean;
}

export interface DaytonaVolumeResult {
  id?: string;
  name?: string;
  action: string;
  mountPath?: string;
  subpath?: string;
  volumes?: unknown[];
  deleted?: boolean;
}

export interface DaytonaBrowserSessionResult {
  sandboxId: string;
  sessionId?: string;
  action: string;
  sessions?: unknown[];
  expiresAt?: number;
  currentOrigin?: string;
  released?: boolean;
  requestedUrl?: string;
  observedUrl?: string;
  title?: string;
  loadState?: "settled" | "unknown";
  observationMethod?: "address_bar" | "requested_only" | "unavailable";
  stable?: boolean;
  file?: DaytonaFileInfo;
  files?: DaytonaFileInfo[];
}

export interface DaytonaCodeResult {
  sandboxId: string;
  contextId?: string;
  created?: boolean;
  deleted?: boolean;
  /** A transport drop has ambiguous execution semantics; inspect before replaying code. */
  executed?: boolean;
  retryable?: boolean;
  nextAction?: string;
  stdout?: string;
  stderr?: string;
  error?: unknown;
  contexts?: unknown[];
}

export interface DaytonaGitResult {
  sandboxId: string;
  path: string;
  action: string;
  result?: unknown;
}

export interface DaytonaArtifactDelivery {
  id: string;
  name: string;
  type: string;
  path: string;
  contentType: string;
  size: number;
  data: Buffer;
}
