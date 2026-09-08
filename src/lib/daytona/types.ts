export type DaytonaWorkspaceAction = "get" | "create" | "status" | "pause" | "archive" | "delete";

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
  autoPauseInterval?: number;
  networkBlockAll?: boolean;
  domainAllowList?: string;
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
