import { z } from "zod";
import {
  CAMOFOX_LIVE_VIEWER_TTL_SECONDS,
  CamofoxActionSchema,
  CamofoxTabIdSchema,
  CamofoxTabSchema,
  camofoxPostBody,
  camofoxRequest,
  createCamofoxLiveViewerUrl,
  getCamofoxUserId,
  parseCamofoxResponse,
  readCamofoxJson,
  readCamofoxScreenshot,
  validateCamofoxTargetUrl,
} from "./engine.js";

const MACRO_NAMES = [
  "@google_search",
  "@youtube_search",
  "@amazon_search",
  "@reddit_search",
  "@reddit_subreddit",
  "@wikipedia_search",
  "@twitter_search",
  "@yelp_search",
  "@spotify_search",
  "@netflix_search",
  "@linkedin_search",
  "@instagram_search",
  "@tiktok_search",
  "@twitch_search",
  "@bestbuy_search",
  "@indeed_search",
  "@pubmed_search",
  "@zillow_search",
  "@npm_search",
  "@dockerhub_search",
  "@nhs_search",
  "@legislation_search",
  "@dailymed_search",
  "@huggingface_search",
  "@jsr_search",
  "@bing_news_search",
] as const;

const ClickInput = z.object({
  tabId: CamofoxTabIdSchema,
  ref: z.string().regex(/^e\d{1,8}$/).optional(),
  selector: z.string().trim().min(1).max(2048).optional(),
}).strict().refine((value) => Boolean(value.ref) !== Boolean(value.selector));
const TabInput = z.object({ tabId: CamofoxTabIdSchema }).strict();
const ExtractSchemaInput = z.object({
  type: z.literal("object"),
  properties: z.record(
    z.string().min(1).max(128),
    z.object({ "x-ref": z.string().regex(/^e\d{1,8}$/) }).passthrough(),
  ).superRefine((properties, context) => {
    if (Object.keys(properties).length < 1 || Object.keys(properties).length > 30) {
      context.addIssue({ code: "custom", message: "The extraction schema must have between 1 and 30 properties." });
    }
  }),
}).passthrough().superRefine((schema, context) => {
  if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > 16_384) {
    context.addIssue({ code: "custom", message: "The extraction schema must be 16 KiB or smaller." });
  }
});

function input<T>(schema: z.ZodType<T>, value: unknown, tool: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid arguments for ${tool}.`);
  return parsed.data;
}

function tabPath(tabId: string, suffix = ""): string {
  return `/tabs/${encodeURIComponent(tabId)}${suffix}`;
}

async function postJson(
  path: string,
  userId: string,
  signal: AbortSignal,
  operation: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await camofoxRequest(path, userId, signal, operation, {
    method: "POST",
    body: camofoxPostBody(userId, body),
  });
  return readCamofoxJson(response, operation);
}

export async function executeCamofoxTool(
  ownerId: number,
  slug: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1) {
    throw new Error("Camofox requires a valid authenticated owner.");
  }
  const userId = getCamofoxUserId({ principalType: "user", principalId: String(ownerId) });

  switch (slug) {
    case "CHUCK_CAMOFOX_CLICK": {
      const { tabId, ref, selector } = input(ClickInput, args, slug);
      const value = await postJson(tabPath(tabId, "/click"), userId, signal, "click", { ref, selector });
      const result = value === undefined
        ? { ok: true }
        : parseCamofoxResponse(CamofoxActionSchema, value, "click");
      if (result.ok === false) throw new Error("Camofox did not complete the click.");
      return { ok: true, ...(result.url ? { url: result.url } : {}) };
    }
    case "CHUCK_CAMOFOX_CLOSE": {
      const { tabId } = input(TabInput, args, slug);
      await camofoxRequest(tabPath(tabId), userId, signal, "close tab", { method: "DELETE" });
      return { ok: true };
    }
    case "CHUCK_CAMOFOX_DISMISS_OVERLAYS": {
      const { tabId, maxClicks } = input(z.object({
        tabId: CamofoxTabIdSchema,
        maxClicks: z.number().int().min(1).max(5).default(3),
      }).strict(), args, slug);
      let value: unknown;
      try {
        value = await postJson(tabPath(tabId, "/overlays/dismiss"), userId, signal, "overlay dismiss", { maxClicks });
      } catch (error) {
        if (error instanceof Error && error.message.includes("(HTTP 409)")) {
          throw new Error("A person is controlling this browser tab right now. Stop acting on the page and tell the user.");
        }
        throw error;
      }
      return parseCamofoxResponse(z.object({
        ok: z.literal(true),
        dismissed: z.array(z.object({ ref: z.string(), name: z.string() })),
        failed: z.array(z.object({ ref: z.string(), name: z.string(), reason: z.string() })),
      }), value, "overlay dismiss");
    }
    case "CHUCK_CAMOFOX_DOWNLOADS": {
      const { tabId } = input(TabInput, args, slug);
      const response = await camofoxRequest(tabPath(tabId, "/downloads"), userId, signal, "downloads");
      return parseCamofoxResponse(z.object({
        tabId: CamofoxTabIdSchema,
        downloads: z.array(z.unknown()).max(100),
      }), await readCamofoxJson(response, "downloads"), "downloads");
    }
    case "CHUCK_CAMOFOX_EXTRACT": {
      const { tabId, schema } = input(z.object({
        tabId: CamofoxTabIdSchema,
        schema: ExtractSchemaInput,
      }).strict(), args, slug);
      const value = await postJson(tabPath(tabId, "/extract"), userId, signal, "extract", { schema });
      const result = parseCamofoxResponse(z.object({
        ok: z.boolean(),
        data: z.record(z.string(), z.unknown()).optional(),
        error: z.string().optional(),
      }), value, "extract");
      if (!result.ok) throw new Error(result.error || "Camofox could not extract the requested fields.");
      if (!result.data) throw new Error("Camofox returned no extracted data.");
      return { ok: true, data: result.data };
    }
    case "CHUCK_CAMOFOX_HANDOFF": {
      const { tabId, action, reason, idleMinutes } = input(z.object({
        tabId: CamofoxTabIdSchema,
        action: z.enum(["start", "release", "status"]),
        reason: z.string().trim().min(1).max(200).optional(),
        idleMinutes: z.number().int().min(1).max(30).default(10),
      }).strict(), args, slug);
      const tab = encodeURIComponent(tabId);
      if (action === "status") {
        const response = await camofoxRequest(`/tabs/${tab}/control`, userId, signal, "handoff status");
        const status = parseCamofoxResponse(z.object({
          mode: z.enum(["agent", "human"]),
          until: z.string().optional(),
          reason: z.string().optional(),
        }), await readCamofoxJson(response, "handoff status"), "handoff status");
        return { ok: true, action, mode: status.mode, until: status.until ?? null, reason: status.reason ?? null, controlUrl: null };
      }
      if (action === "release") {
        const value = await postJson(`/tabs/${tab}/handoff/release`, userId, signal, "handoff release", {});
        parseCamofoxResponse(z.object({ ok: z.literal(true), mode: z.literal("agent") }), value, "handoff release");
        return { ok: true, action, mode: "agent", until: null, reason: null, controlUrl: null };
      }
      if (!reason) throw new Error("A reason is required to start a handoff, so the user knows what to do.");
      let started: { ok: true; mode: "human"; until: string; reason: string };
      try {
        started = parseCamofoxResponse(z.object({
          ok: z.literal(true),
          mode: z.literal("human"),
          until: z.string(),
          reason: z.string(),
        }), await postJson(`/tabs/${tab}/handoff`, userId, signal, "handoff start", {
          reason,
          idleMs: idleMinutes * 60 * 1000,
        }), "handoff start");
      } catch (error) {
        if (error instanceof Error && error.message.includes("(HTTP 409)")) {
          throw new Error("The handoff could not start because the tab is already under a handoff.");
        }
        throw error;
      }

      let controlUrl: string;
      try {
        const value = await postJson("/live-viewer/links", userId, signal, "issue control link", {
          tabId,
          control: true,
          ttlSeconds: 60 * 60,
        });
        const link = parseCamofoxResponse(z.object({ url: z.string().url() }), value, "issue control link");
        controlUrl = checkedControlUrl(link.url);
      } catch (error) {
        try {
          await postJson(`/tabs/${tab}/handoff/release`, userId, signal, "handoff release after failed link", {});
        } catch {
          throw new Error("Camofox could not issue the private control link and could not release the handoff.");
        }
        if (error instanceof Error && error.message.includes("(HTTP 409)")) {
          throw new Error("The handoff could not start because the tab is already under a handoff.");
        }
        throw error;
      }
      return { ok: true, action, mode: started.mode, until: started.until, reason: started.reason, controlUrl };
    }
    case "CHUCK_CAMOFOX_HISTORY": {
      const { tabId, action } = input(z.object({
        tabId: CamofoxTabIdSchema,
        action: z.enum(["back", "forward", "refresh"]),
      }).strict(), args, slug);
      const result = parseCamofoxResponse(z.object({
        ok: z.literal(true),
        url: z.string().min(1).max(4096).optional(),
      }), await postJson(tabPath(tabId, `/${action}`), userId, signal, action, {}), action);
      return { ok: true, ...(result.url ? { url: result.url } : {}) };
    }
    case "CHUCK_CAMOFOX_LINKS": {
      const { tabId, limit, offset } = input(z.object({
        tabId: CamofoxTabIdSchema,
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).max(100_000).default(0),
      }).strict(), args, slug);
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const response = await camofoxRequest(tabPath(tabId, `/links?${query}`), userId, signal, "links");
      return parseCamofoxResponse(z.object({
        links: z.array(z.object({
          url: z.string().url().max(4096),
          text: z.string().max(4096).nullable().optional(),
        })).max(500),
        pagination: z.object({
          total: z.number().int().nonnegative(),
          offset: z.number().int().nonnegative(),
          limit: z.number().int().positive(),
          hasMore: z.boolean(),
        }),
      }), await readCamofoxJson(response, "links"), "links");
    }
    case "CHUCK_CAMOFOX_LIST_TABS": {
      input(z.object({}).strict(), args, slug);
      const response = await camofoxRequest("/tabs", userId, signal, "list tabs");
      return parseCamofoxResponse(z.object({ tabs: z.array(CamofoxTabSchema).max(1000) }),
        await readCamofoxJson(response, "list tabs"), "list tabs");
    }
    case "CHUCK_CAMOFOX_LIVE_VIEWER": {
      const { tabId } = input(TabInput, args, slug);
      return {
        url: await createCamofoxLiveViewerUrl(tabId, userId, signal),
        expiresInSeconds: CAMOFOX_LIVE_VIEWER_TTL_SECONDS,
      };
    }
    case "CHUCK_CAMOFOX_NAVIGATE": {
      const { tabId, url, macro, query } = input(z.object({
        tabId: CamofoxTabIdSchema,
        url: z.string().url().optional(),
        macro: z.enum(MACRO_NAMES).optional(),
        query: z.string().trim().min(1).max(500).optional(),
      }).strict().refine((value) => {
        const usingUrl = value.url !== undefined;
        const usingMacro = value.macro !== undefined && value.query !== undefined;
        const paired = (value.macro === undefined) === (value.query === undefined);
        return usingUrl !== usingMacro && paired;
      }), args, slug);
      const targetUrl = url ? validateCamofoxTargetUrl(url) : undefined;
      const value = await postJson(tabPath(tabId, "/navigate"), userId, signal, "navigate", { url: targetUrl, macro, query });
      const result = value === undefined ? { ok: true } : parseCamofoxResponse(CamofoxActionSchema, value, "navigate");
      if (result.ok === false) throw new Error("Camofox did not complete navigation.");
      return { ok: true, ...(result.url ? { url: result.url } : {}) };
    }
    case "CHUCK_CAMOFOX_OPEN": {
      const { url, sessionKey } = input(z.object({
        url: z.string().url(),
        sessionKey: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/).default("main"),
      }).strict(), args, slug);
      const targetUrl = validateCamofoxTargetUrl(url);
      const tab = parseCamofoxResponse(CamofoxTabSchema, await postJson("/tabs", userId, signal, "open tab", {
        sessionKey,
        url: targetUrl,
      }), "open tab");
      try {
        return {
          ...tab,
          liveViewerUrl: await createCamofoxLiveViewerUrl(tab.tabId, userId, signal),
          liveViewerExpiresInSeconds: CAMOFOX_LIVE_VIEWER_TTL_SECONDS,
        };
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          ...tab,
          liveViewerError: error instanceof Error ? error.message : "The live viewer link could not be issued.",
        };
      }
    }
    case "CHUCK_CAMOFOX_PAGE_STATE": {
      const { tabId } = input(TabInput, args, slug);
      const params = new URLSearchParams({ userId });
      const response = await camofoxRequest(tabPath(tabId, `/state?${params}`), userId, signal, "page state");
      return parseCamofoxResponse(z.object({
        ok: z.literal(true),
        url: z.string(),
        title: z.string(),
        state: z.object({
          kind: z.enum(["captcha", "block", "two_factor", "login_wall", "consent", "no_results", "ok"]),
          reasons: z.array(z.string()),
        }),
        overlayRefs: z.array(z.string()),
        refsCount: z.number().int().nonnegative(),
      }), await readCamofoxJson(response, "page state"), "page state");
    }
    case "CHUCK_CAMOFOX_SCREENSHOT": {
      const { tabId } = input(TabInput, args, slug);
      const response = await camofoxRequest(tabPath(tabId, "/screenshot"), userId, signal, "capture screenshot", {}, { retryUnavailable: true });
      const screenshot = await readCamofoxScreenshot(response);
      return {
        ok: true,
        mimeType: screenshot.mimeType,
        bytes: screenshot.bytes,
        __browserScreenshot: true,
        base64: screenshot.screenshotBase64,
        mediaType: screenshot.mimeType,
      };
    }
    case "CHUCK_CAMOFOX_SCROLL": {
      const { tabId, direction, amount } = input(z.object({
        tabId: CamofoxTabIdSchema,
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().int().min(1).max(5000).default(600),
      }).strict(), args, slug);
      const value = await postJson(tabPath(tabId, "/scroll"), userId, signal, "scroll", { direction, amount });
      if (value !== undefined) {
        const result = parseCamofoxResponse(z.object({ ok: z.boolean().optional() }), value, "scroll");
        if (result.ok === false) throw new Error("Camofox did not complete the scroll.");
      }
      return { ok: true };
    }
    case "CHUCK_CAMOFOX_SNAPSHOT": {
      const { tabId, offset } = input(z.object({
        tabId: CamofoxTabIdSchema,
        offset: z.number().int().min(0).max(100_000).optional(),
      }).strict(), args, slug);
      const path = tabPath(tabId, "/snapshot");
      const response = await camofoxRequest(offset === undefined ? path : `${path}?offset=${offset}`, userId, signal, "read snapshot");
      return parseCamofoxResponse(z.object({
        url: z.string().min(1).max(4096),
        snapshot: z.string().max(1_500_000),
        refsCount: z.number().int().nonnegative().optional(),
        truncated: z.boolean().optional(),
      }), await readCamofoxJson(response, "read snapshot"), "read snapshot");
    }
    case "CHUCK_CAMOFOX_TYPE": {
      const { tabId, text, ref, selector, pressEnter } = input(z.object({
        tabId: CamofoxTabIdSchema,
        text: z.string().max(10_000),
        ref: z.string().regex(/^e\d{1,8}$/).optional(),
        selector: z.string().trim().min(1).max(2048).optional(),
        pressEnter: z.boolean().optional(),
      }).strict().refine((value) => Boolean(value.ref) !== Boolean(value.selector)), args, slug);
      const value = await postJson(tabPath(tabId, "/type"), userId, signal, "type text", { text, ref, selector, pressEnter });
      if (value !== undefined) {
        const result = parseCamofoxResponse(z.object({ ok: z.boolean().optional() }), value, "type text");
        if (result.ok === false) throw new Error("Camofox did not complete the typing action.");
      }
      return { ok: true };
    }
    case "CHUCK_CAMOFOX_WAIT": {
      const { tabId, timeout, waitForNetwork, dismissConsent } = input(z.object({
        tabId: CamofoxTabIdSchema,
        timeout: z.number().int().min(500).max(15_000).default(10_000),
        waitForNetwork: z.boolean().default(true),
        dismissConsent: z.boolean().default(false),
      }).strict(), args, slug);
      const result = parseCamofoxResponse(z.object({
        ok: z.boolean(),
        ready: z.boolean(),
        error: z.string().optional(),
      }), await postJson(tabPath(tabId, "/wait"), userId, signal, "wait", {
        timeout,
        waitForNetwork,
        dismissConsent,
      }), "wait");
      if (!result.ok) throw new Error(result.error || "Camofox could not wait for the page.");
      return { ok: true, ready: result.ready };
    }
    default:
      throw new Error(`Unsupported Camofox tool: ${slug}`);
  }
}

function checkedControlUrl(value: string): string {
  const url = new URL(value);
  const localHttpAllowed =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttpAllowed) ||
    url.username ||
    url.password ||
    !url.searchParams.get("t")
  ) {
    throw new Error("Camofox returned an invalid live viewer URL.");
  }
  return url.toString();
}
