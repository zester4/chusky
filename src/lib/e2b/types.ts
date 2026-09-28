export type E2BBrowserAction =
  | "start" | "stop" | "status" | "state" | "session_acquire" | "session_list" | "session_release"
  | "open" | "snapshot" | "find" | "focus" | "invoke" | "fill" | "click" | "move" | "drag"
  | "type" | "press" | "select_option" | "check" | "uncheck" | "hover" | "wait" | "screenshot"
  | "screenshot_full" | "screenshot_region" | "windows" | "display_info" | "tabs" | "tab_open"
  | "tab_focus" | "tab_close" | "back" | "forward" | "refresh" | "scroll";

export type E2BBrowserNode = {
  nodeId: string;
  role: string;
  name: string;
  index: number;
  url: string;
  capturedAt: number;
};

export type E2BBrowserRecord = {
  sandboxId: string;
  sessionId?: string;
  lastUrl?: string;
  title?: string;
  nodes?: E2BBrowserNode[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type E2BCommandResult = {
  ok: boolean;
  url?: string;
  title?: string;
  loadState?: string;
  text?: string;
  matches?: Array<{ role: string; name: string; index: number; nodeId?: string }>;
  screenshot?: string;
  needsUserInteraction?: boolean;
  challenge?: { type: "captcha" | "two_factor" | "site_challenge"; detected: boolean };
  tabs?: Array<{ index: number; url: string; title: string; active: boolean }>;
  error?: string;
  [key: string]: unknown;
};
