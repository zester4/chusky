import { safeDaytonaPath } from "./lib/daytona/index.js";

export type VideoDestination = "telegram" | "daytona" | "both";

export interface VideoStatusResponse {
  id?: unknown;
  status?: unknown;
  polling_url?: unknown;
  url?: unknown;
  video_url?: unknown;
  unsigned_urls?: unknown;
  data?: {
    id?: unknown;
    status?: unknown;
    url?: unknown;
    video_url?: unknown;
    unsigned_urls?: unknown;
  };
  error?: unknown;
}

export function normalizeVideoDestination(value: unknown): VideoDestination {
  return value === "daytona" || value === "both" ? value : "telegram";
}

export function resolveVideoWorkspacePath(destination: VideoDestination, value: unknown): string | undefined {
  if (destination === "telegram") return undefined;
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  return safeDaytonaPath(value, "workspacePath");
}

function stringUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function firstUrl(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = stringUrl(item);
      if (url) return url;
    }
  }
  return stringUrl(value);
}

export function videoPollingUrl(submitted: VideoStatusResponse, videoId: string): string {
  const pollingUrl = stringUrl(submitted.polling_url);
  if (pollingUrl) return pollingUrl;
  return `https://openrouter.ai/api/v1/videos/${encodeURIComponent(videoId)}`;
}

export function videoDownloadUrl(status: VideoStatusResponse, videoId: string): { url: string; authenticated: boolean } {
  const directUrl = firstUrl(status.unsigned_urls)
    ?? firstUrl(status.data?.unsigned_urls)
    ?? stringUrl(status.url)
    ?? stringUrl(status.video_url)
    ?? stringUrl(status.data?.url)
    ?? stringUrl(status.data?.video_url);
  // OpenRouter may return its own authenticated content endpoint inside
  // `unsigned_urls`. Only provider/storage URLs are truly unsigned.
  if (directUrl) return { url: directUrl, authenticated: directUrl.startsWith("https://openrouter.ai/api/") };
  return { url: `https://openrouter.ai/api/v1/videos/${encodeURIComponent(videoId)}/content?index=0`, authenticated: true };
}
