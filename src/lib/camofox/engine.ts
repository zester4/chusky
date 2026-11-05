//src/lib/camofox/engine.ts
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 300;
export const CAMOFOX_LIVE_VIEWER_TTL_SECONDS = 600;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".test", ".invalid"];

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

type CamofoxAuth = {
  principalId?: string | null;
  principalType?: string | null;
} | null | undefined;

export function getCamofoxUserId(auth: CamofoxAuth): string {
  const principalId = auth?.principalId?.trim();
  if (auth?.principalType !== "user" || !principalId) {
    throw new Error("Camofox requires an authenticated user session.");
  }
  if (principalId.length > 512 || hasControlCharacters(principalId)) {
    throw new Error("The authenticated user identity is invalid for Camofox.");
  }

  const digest = createHash("sha256")
    .update(`thinky:camofox:v1:${process.env.BETTER_AUTH_URL ?? "thinky"}:${principalId}`)
    .digest("hex");
  return `thinky_${digest}`;
}

export function validateCamofoxTargetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Camofox requires a valid HTTPS URL.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    isIP(hostname) ||
    hostname === "localhost" ||
    LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error("Camofox can only browse public HTTPS hostnames.");
  }

  return url.toString();
}

function getCamofoxConfig() {
  const baseUrlValue = process.env.CAMOFOX_BASE_URL?.trim();
  const accessKey = process.env.CAMOFOX_ACCESS_KEY?.trim();
  if (!baseUrlValue || !accessKey) {
    throw new Error("CAMOFOX_BASE_URL and CAMOFOX_ACCESS_KEY must be configured for the Eve service.");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new Error("CAMOFOX_BASE_URL must be a valid HTTPS origin.");
  }

  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
  const localHttpAllowed =
    process.env.NODE_ENV !== "production" && localHost && baseUrl.protocol === "http:";
  if (
    (baseUrl.protocol !== "https:" && !localHttpAllowed) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error("CAMOFOX_BASE_URL must be an HTTPS origin (local HTTP is allowed outside production).");
  }

  return { baseUrl: baseUrl.origin, accessKey };
}

export async function camofoxRequest(
  path: string,
  userId: string,
  signal: AbortSignal,
  operation: string,
  init: RequestInit = {},
  options: { retryUnavailable?: boolean } = {},
): Promise<Response> {
  const { baseUrl, accessKey } = getCamofoxConfig();
  const url = new URL(path, baseUrl);
  url.searchParams.set("userId", userId);

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, timeoutSignal]);
  const canRetry = options.retryUnavailable && (init.method ?? "GET").toUpperCase() === "GET";
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        headers: requestHeaders(init.headers, accessKey, Boolean(init.body)),
        redirect: "error",
        signal: requestSignal,
      });
    } catch {
      if (signal.aborted) {
        throw new Error(`Browser ${operation} was cancelled.`);
      }
      if (timeoutSignal.aborted) {
        throw new Error(
          `Browser ${operation} timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds. Check the tab state before retrying.`,
        );
      }
      throw new Error(`Browser ${operation} could not reach the configured browser service.`);
    }

    if (canRetry && attempt === 0 && [502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      continue;
    }
    if (!response.ok) {
      const availability = response.status >= 500 ? "is temporarily unavailable" : "failed";
      throw new Error(`Browser ${operation} ${availability} (HTTP ${response.status}).`);
    }
    return response;
  }
}

function requestHeaders(existing: HeadersInit | undefined, accessKey: string, hasBody: boolean): Headers {
  const headers = new Headers(existing);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${accessKey}`);
  if (hasBody) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

async function readLimitedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error("Camofox returned a response that exceeds the allowed size.");
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error("Camofox returned a response that exceeds the allowed size.");
    }
    chunks.push(value);
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readCamofoxJson(response: Response, operation: string): Promise<unknown> {
  const bytes = await readLimitedBody(response, MAX_JSON_RESPONSE_BYTES);
  if (bytes.byteLength === 0) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/application\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
    throw new Error(`Camofox ${operation} returned a non-JSON response.`);
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`Camofox ${operation} returned invalid JSON.`);
  }
}

export async function createCamofoxLiveViewerUrl(
  tabId: string,
  userId: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await camofoxRequest(
    "/live-viewer/links",
    userId,
    signal,
    "issue live viewer link",
    {
      method: "POST",
      body: camofoxPostBody(userId, {
        tabId,
        ttlSeconds: CAMOFOX_LIVE_VIEWER_TTL_SECONDS,
      }),
    },
  );
  const result = parseCamofoxResponse(
    z.object({ url: z.string().url() }),
    await readCamofoxJson(response, "issue live viewer link"),
    "issue live viewer link",
  );

  const viewerUrl = new URL(result.url);
  const localHttpAllowed =
    process.env.NODE_ENV !== "production" &&
    viewerUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(viewerUrl.hostname);
  if (
    (viewerUrl.protocol !== "https:" && !localHttpAllowed) ||
    viewerUrl.username ||
    viewerUrl.password ||
    !viewerUrl.searchParams.get("t")
  ) {
    throw new Error("Camofox returned an invalid signed live viewer URL.");
  }

  return viewerUrl.toString();
}

export async function readCamofoxScreenshot(
  response: Response,
): Promise<{ mimeType: string; bytes: number; screenshotBase64: string }> {
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!mimeType || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    throw new Error("Camofox returned an unsupported screenshot format.");
  }

  const bytes = await readLimitedBody(response, MAX_SCREENSHOT_BYTES);
  if (bytes.byteLength === 0) {
    throw new Error("Camofox returned an empty screenshot.");
  }
  const isPng =
    mimeType === "image/png" &&
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const isJpeg =
    mimeType === "image/jpeg" &&
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const isWebp =
    mimeType === "image/webp" &&
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  if (!isPng && !isJpeg && !isWebp) {
    throw new Error(`Camofox screenshot bytes do not match the declared ${mimeType} format.`);
  }

  return {
    mimeType,
    bytes: bytes.byteLength,
    screenshotBase64: Buffer.from(bytes).toString("base64"),
  };
}

export function parseCamofoxResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  operation: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Camofox returned an invalid response for ${operation}.`);
  }
  return parsed.data;
}

export const CamofoxTabIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "Invalid tab ID");

export const CamofoxTabSchema = z.object({
  tabId: CamofoxTabIdSchema,
  url: z.string().min(1).max(4096),
  title: z.string().max(4096).nullable().optional(),
});

export const CamofoxActionSchema = z.object({
  ok: z.boolean().optional(),
  url: z.string().min(1).max(4096).optional(),
});

export function camofoxPostBody(userId: string, body: Record<string, unknown>): string {
  return JSON.stringify({ ...body, userId });
}