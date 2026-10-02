export const E2B_BROWSER_ACTIONS = [
  "start", "stop", "status", "state", "session_acquire", "session_list", "session_release",
  "open", "snapshot", "find", "form_inspect", "health", "focus", "invoke", "fill", "click", "move", "drag", "type", "press",
  "select_option", "check", "uncheck", "hover", "wait", "screenshot", "screenshot_full", "screenshot_region",
  "screenshot_region_full", "windows", "display_info", "tabs", "tab_open", "tab_focus", "tab_close",
  "back", "forward", "refresh", "scroll", "upload_files", "upload", "downloads", "wait_download",
  "download_register", "download_get", "download_delete", "recording_start", "recording_stop",
  "recording_list", "recording_get", "recording_delete", "recording_download",
] as const;

export type E2BBrowserAction = typeof E2B_BROWSER_ACTIONS[number];

export type E2BBrowserNode = {
  nodeId: string;
  role: string;
  name: string;
  index: number;
  id?: string;
  nameAttr?: string;
  placeholder?: string;
  autocomplete?: string;
  inputType?: string;
  tagName?: string;
  frameIndex?: number;
  frameUrl?: string;
  observationId?: string;
  pageGeneration?: number;
  url: string;
  capturedAt: number;
};

export type E2BBrowserRecord = {
  sandboxId: string;
  /** RFC 7638 thumbprint of the Web Bot Auth key loaded at sandbox creation. */
  webBotAuthKeyId?: string;
  sessionId?: string;
  lastUrl?: string;
  title?: string;
  nodes?: E2BBrowserNode[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  observationId?: string;
  pageGeneration?: number;
  health?: Record<string, unknown>;
  checkpoint?: E2BBrowserCheckpoint;
};

export type E2BBrowserFormControl = {
  id?: string;
  role: string;
  type?: string;
  name: string;
  required: boolean;
  disabled: boolean;
  valuePresent?: boolean;
  valueLength?: number;
  checked?: boolean;
  selectedText?: string;
  options?: Array<{ label: string; value: string; disabled: boolean; selected: boolean }>;
  invalid?: boolean;
  validationMessage?: string;
  frameIndex?: number;
  frameUrl?: string;
};

export type E2BBrowserForm = {
  formId: string;
  name?: string;
  action?: string;
  method?: string;
  controls: E2BBrowserFormControl[];
  submitControls: Array<{ role: string; name: string; id?: string; disabled: boolean }>;
};

export type E2BBrowserCheckpoint = {
  action: string;
  url?: string;
  title?: string;
  observationId?: string;
  pageGeneration?: number;
  accessibilityHash?: string;
  verified?: boolean;
  updatedAt: number;
};

/** Owner-scoped file metadata. Bytes live in R2; this record contains no file content. */
export type E2BBrowserFileRecord = {
  id: string;
  key: string;
  name: string;
  contentType: string;
  size: number;
  kind: "download" | "recording";
  sourceId?: string;
  sandboxId: string;
  createdAt: number;
  expiresAt: number;
};

export type E2BCommandResult = {
  ok: boolean;
  url?: string;
  title?: string;
  loadState?: string;
  text?: string;
  pageContent?: string;
  pageContentTruncated?: boolean;
  matches?: Array<{ role: string; name: string; index: number; nodeId?: string; id?: string; nameAttr?: string; placeholder?: string; autocomplete?: string; inputType?: string; tagName?: string; frameIndex?: number; frameUrl?: string; observationId?: string; pageGeneration?: number }>;
  observationId?: string;
  pageGeneration?: number;
  accessibilityHash?: string;
  health?: Record<string, unknown>;
  forms?: E2BBrowserForm[];
  checkpoint?: E2BBrowserCheckpoint;
  formState?: { value?: string; valueLength?: number; checked?: boolean; selectedText?: string; controlRole?: string; required?: boolean; disabled?: boolean; invalid?: boolean; validationMessage?: string };
  downloads?: Array<{ id: string; name: string; state: string; size: number; createdAt: number; error?: string }>;
  download?: { id: string; name: string; state: string; size: number; createdAt: number; error?: string } | null;
  recordings?: Array<{ id: string; name: string; state: string; size: number; createdAt: number; error?: string }>;
  recording?: { id: string; name: string; state: string; size?: number; createdAt: number; error?: string };
  runtimeFilePath?: string;
  filePath?: string;
  size?: number;
  kind?: "download" | "recording";
  createdAt?: number;
  screenshot?: string;
  needsUserInteraction?: boolean;
  challenge?: { type: "captcha" | "two_factor" | "site_challenge"; detected: boolean };
  tabs?: Array<{ index: number; url: string; title: string; active: boolean }>;
  error?: string;
  [key: string]: unknown;
};
