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
