//agent/tools/camofox_pay_arm.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  CamofoxTabIdSchema,
  camofoxPostBody,
  camofoxRequest,
  getCamofoxUserId,
  parseCamofoxResponse,
  readCamofoxJson,
} from "../lib/camofox.js";

const ArmOutputSchema = z.object({
  ok: z.literal(true),
  attachmentId: z.string(),
  tabId: z.string(),
});

export default defineTool({
  description:
    "Pay on a checkout page in this browser tab with the user's own saved card. Call this on the checkout page, before the page sends its payment, and give the merchant name, the most the user can be charged in minor units (2306 is $23.06), and the currency. The card number never reaches you. When the page sends its payment, it is paused until the user approves on their own device. Then call camofox_pay_status and send its approvalUrl to the user, unchanged. Only pay when the user has asked you to buy something.",
  inputSchema: z.object({
    tabId: CamofoxTabIdSchema,
    merchant: z.string().trim().min(1).max(120).describe("Store name, shown on the approval screen."),
    amount: z.number().int().positive().describe("The most the user can be charged, in minor units (cents)."),
    currency: z.string().regex(/^[a-z]{3}$/).describe("Lowercase ISO 4217 code, e.g. usd."),
    checkoutOrigin: z
      .string()
      .url()
      .optional()
      .describe("The https origin of the checkout page, e.g. https://shop.example.com. No path."),
    cardId: z.string().optional().describe("Which stored card to use. Omit for the first card."),
  }),
  outputSchema: ArmOutputSchema,
  async execute({ tabId, merchant, amount, currency, checkoutOrigin, cardId }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const response = await camofoxRequest(
      `/agentcard/tabs/${encodeURIComponent(tabId)}/payment`,
      userId,
      ctx.abortSignal,
      "payment arm",
      {
        method: "POST",
        body: camofoxPostBody(userId, { merchant, amount, currency, checkoutOrigin, cardId }),
      },
    );
    const body = parseCamofoxResponse(
      ArmOutputSchema.omit({ ok: true }).extend({ tabId: z.string() }),
      await readCamofoxJson(response, "payment arm"),
      "payment arm",
    );
    return { ok: true as const, attachmentId: body.attachmentId, tabId };
  },
});



//agent/tools/camofox_pay_status.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  CamofoxTabIdSchema,
  camofoxRequest,
  getCamofoxUserId,
  parseCamofoxResponse,
  readCamofoxJson,
} from "../lib/camofox.js";

const StatusSchema = z.object({
  attachmentId: z.string(),
  phase: z.enum(["idle", "pending", "completed"]),
  approvalUrl: z.string().nullable(),
  purchaseId: z.string().nullable(),
  results: z.array(z.record(z.unknown())),
});

export default defineTool({
  description:
    "Read the state of a payment on a tab. When approvalUrl is set, a card request is waiting for the user: send that link to the user in chat, unchanged, and tell them to approve it on their device. phase 'completed' means the request has been answered; check results for what happened. Do not retry a payment that the results show as approved or submitted.",
  inputSchema: z.object({
    tabId: CamofoxTabIdSchema,
    attachmentId: z.string().min(1).describe("From camofox_pay_arm."),
  }),
  outputSchema: StatusSchema,
  async execute({ tabId, attachmentId }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const query = new URLSearchParams({ userId });
    const response = await camofoxRequest(
      `/agentcard/tabs/${encodeURIComponent(tabId)}/payment/${encodeURIComponent(attachmentId)}?${query}`,
      userId,
      ctx.abortSignal,
      "payment status",
    );
    return parseCamofoxResponse(
      StatusSchema,
      await readCamofoxJson(response, "payment status"),
      "payment status",
    );
  },
});


//agent/tools/camofox_pay_disarm.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  CamofoxTabIdSchema,
  camofoxRequest,
  getCamofoxUserId,
  readCamofoxJson,
} from "../lib/camofox.js";

export default defineTool({
  description:
    "Stop paying on a tab. Call it when the checkout is finished, or when the user cancels. Any card request still waiting for approval is cancelled.",
  inputSchema: z.object({
    tabId: CamofoxTabIdSchema,
    attachmentId: z.string().min(1).describe("From camofox_pay_arm."),
  }),
  outputSchema: z.object({ ok: z.literal(true), disarmed: z.boolean() }),
  async execute({ tabId, attachmentId }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const query = new URLSearchParams({ userId });
    const response = await camofoxRequest(
      `/agentcard/tabs/${encodeURIComponent(tabId)}/payment/${encodeURIComponent(attachmentId)}?${query}`,
      userId,
      ctx.abortSignal,
      "payment disarm",
      { method: "DELETE" },
    );
    await readCamofoxJson(response, "payment disarm");
    return { ok: true as const, disarmed: true };
  },
});

//agent/tools/agentcard_enrol.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  camofoxPostBody,
  camofoxRequest,
  getCamofoxUserId,
  readCamofoxJson,
} from "../lib/camofox.js";

export default defineTool({
  description:
    "Start storing the user's own card with AgentCard. If a card is already stored, this returns has_card and nothing else is needed. Otherwise it returns a vault link: send that link to the user in chat, unchanged. The user enters the card on AgentCard's page, not in this chat. Never ask the user for a card number. Use addAnother to add a second card.",
  inputSchema: z.object({
    addAnother: z.boolean().optional().describe("true to add a second card for this user."),
  }),
  outputSchema: z.object({}).passthrough(),
  async execute({ addAnother }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const response = await camofoxRequest(
      `/agentcard/vault/enrol`,
      userId,
      ctx.abortSignal,
      "agentcard enrol",
      { method: "POST", body: camofoxPostBody(userId, { addAnother: addAnother === true }) },
    );
    return readCamofoxJson(response, "agentcard enrol");
  },
});

//agent/tools/agentcard_cards.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { camofoxRequest, getCamofoxUserId, readCamofoxJson } from "../lib/camofox.js";

export default defineTool({
  description:
    "List the cards the user has stored with AgentCard: brand, last four digits and expiry. Card numbers are never returned. Use it before a purchase to check that a card is on file.",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  async execute(_input, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const query = new URLSearchParams({ userId });
    const response = await camofoxRequest(
      `/agentcard/vault/cards?${query}`,
      userId,
      ctx.abortSignal,
      "agentcard cards",
    );
    return readCamofoxJson(response, "agentcard cards");
  },
});

//agent/tools/agentcard_buy.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  camofoxPostBody,
  camofoxRequest,
  getCamofoxUserId,
  readCamofoxJson,
} from "../lib/camofox.js";

export default defineTool({
  description:
    "Shop for the user at real stores through AgentCard: products, food delivery, table reservations and flights. Pass the user's words in ask. Pass product_id or store_id only when the user picked one from an earlier result. Set confirm to true only when the user has said yes to the cart or asks to check out. The reply contains links for the user: send each link to the user exactly as given. Never change, shorten or summarise a link. A product with action 'reserve' is a table, and one with 'book' is a flight. The user approves the payment on their own device.",
  inputSchema: z.object({
    ask: z.string().trim().min(1).max(2000).describe("What the user said, in their own words."),
    threadId: z.string().max(128).optional().describe("The chat, so one purchase stays in one chat."),
    confirm: z.boolean().optional().describe("true only when the user said yes to the cart."),
    new_order: z.boolean().optional().describe("true only when the user drops the cart to start a new order."),
    product_id: z.string().nullable().optional().describe("The product the user picked from the last result."),
    store_id: z.string().nullable().optional().describe("The store the user picked from the last result."),
  }),
  outputSchema: z.object({}).passthrough(),
  async execute({ ask, threadId, confirm, new_order, product_id, store_id }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const response = await camofoxRequest(
      `/agentcard/commerce/buy`,
      userId,
      ctx.abortSignal,
      "agentcard buy",
      {
        method: "POST",
        body: camofoxPostBody(userId, {
          ask,
          threadId,
          confirm: confirm === true,
          new_order: new_order === true,
          product_id: product_id ?? null,
          store_id: store_id ?? null,
        }),
      },
    );
    return readCamofoxJson(response, "agentcard buy");
  },
});

//agent/tools/agentcard_merchants.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { camofoxRequest, getCamofoxUserId, readCamofoxJson } from "../lib/camofox.js";

export default defineTool({
  description:
    "Check whether AgentCard can pay at a store before sending the user there. supported: true means a real purchase went through; false means it cannot pay there; null means nothing recent settles it. link_status (direct merchants such as DoorDash) shows whether the user still has to connect; if so, the next agentcard_buy reply contains the sign-in link.",
  inputSchema: z.object({
    kind: z.string().regex(/^[a-z_]{1,32}$/).optional().describe("e.g. catalog or direct."),
    q: z.string().max(100).optional().describe("Part of a store name or domain."),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional().describe("next_cursor from the previous page."),
  }),
  outputSchema: z.object({}).passthrough(),
  async execute({ kind, q, limit, cursor }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const query = new URLSearchParams({ userId });
    if (kind) query.set("kind", kind);
    if (q) query.set("q", q);
    if (limit !== undefined) query.set("limit", String(limit));
    if (cursor) query.set("cursor", cursor);
    const response = await camofoxRequest(
      `/agentcard/merchants?${query}`,
      userId,
      ctx.abortSignal,
      "agentcard merchants",
    );
    return readCamofoxJson(response, "agentcard merchants");
  },
});

//agent/tools/agentcard_presets.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  camofoxPostBody,
  camofoxRequest,
  getCamofoxUserId,
  readCamofoxJson,
} from "../lib/camofox.js";

const RulesSchema = z.object({
  perDayCents: z.number().int().positive().optional(),
  perWeekCents: z.number().int().positive().optional(),
  perMonthCents: z.number().int().positive().optional(),
  totalCents: z.number().int().positive().optional(),
  onlyMerchants: z.array(z.string()).min(1).max(20).optional(),
  categories: z
    .array(z.enum(["meals", "groceries", "travel", "software", "ai", "wellness", "retail"]))
    .min(1)
    .max(20)
    .optional(),
  currencies: z.array(z.string().regex(/^[a-z]{3}$/)).min(1).max(20).optional(),
  onlyDays: z.string().max(64).optional(),
  onlyHours: z.string().regex(/^\d{1,2}-\d{1,2}$/).optional(),
  timezone: z.string().optional(),
  mode: z.enum(["strict", "watch"]).optional(),
});

export default defineTool({
  description:
    "Manage the user's spending rules with AgentCard. action 'list' shows their rules. 'set' creates or changes a rule named by label, with money in cents; use it when the user sets a limit or allowed merchants. 'attach' applies a rule to one of their cards. AgentCard enforces the rules before any approval, so they protect the user even if an agent makes a mistake.",
  inputSchema: z.object({
    action: z.enum(["list", "set", "attach"]),
    label: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
      .optional()
      .describe("Required for set and attach."),
    rules: RulesSchema.optional().describe("Required for set. At least one rule."),
    cardId: z.string().optional().describe("For attach. Omit for the first card."),
  }),
  outputSchema: z.object({}).passthrough(),
  async execute({ action, label, rules, cardId }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    if (action === "list") {
      const query = new URLSearchParams({ userId });
      return readCamofoxJson(
        await camofoxRequest(`/agentcard/presets?${query}`, userId, ctx.abortSignal, "agentcard presets"),
        "agentcard presets",
      );
    }
    if (!label) throw new Error("label is required for " + action + ".");
    if (action === "set") {
      if (!rules) throw new Error("rules is required for set.");
      const response = await camofoxRequest(
        `/agentcard/presets/${encodeURIComponent(label)}`,
        userId,
        ctx.abortSignal,
        "agentcard preset set",
        { method: "PUT", body: camofoxPostBody(userId, { rules }) },
      );
      return readCamofoxJson(response, "agentcard preset set");
    }
    const response = await camofoxRequest(
      `/agentcard/presets/${encodeURIComponent(label)}/attach`,
      userId,
      ctx.abortSignal,
      "agentcard preset attach",
      { method: "POST", body: camofoxPostBody(userId, { cardId }) },
    );
    return readCamofoxJson(response, "agentcard preset attach");
  },
});

//agent/tools/camofox_handoff.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  CamofoxTabIdSchema,
  camofoxPostBody,
  camofoxRequest,
  getCamofoxUserId,
  parseCamofoxResponse,
  readCamofoxJson,
} from "../lib/camofox.js";

const DEFAULT_IDLE_MINUTES = 10;
// Lifetime of the control link. The server also ends control when the
// handoff ends, so this only needs to outlast a handoff.
const CONTROL_LINK_TTL_SECONDS = 60 * 60;

const StatusSchema = z.object({
  mode: z.enum(["agent", "human"]),
  until: z.string().optional(),
  reason: z.string().optional(),
});

const HandoffOutputSchema = z.object({
  ok: z.literal(true),
  action: z.enum(["start", "release", "status"]),
  mode: z.enum(["agent", "human"]),
  until: z.string().nullable(),
  reason: z.string().nullable(),
  // Present only after "start". Send this link to the user, and only to them.
  controlUrl: z.string().nullable(),
});

const HandoffStartResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.literal("human"),
  until: z.string(),
  reason: z.string(),
});

const ReleaseResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.literal("agent"),
});

const LinkResponseSchema = z.object({
  url: z.string().url(),
});

/**
 * Accept only an https viewer link, or a local http link outside production.
 * The link is a bearer credential, so anything else is refused.
 */
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

function isConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("(HTTP 409)");
}

export default defineTool({
  description:
    "Hand the browser tab to the user so they can act on it, for example to sign in, enter a code, or solve a check. Use action 'start' with a short reason the user will understand. It returns controlUrl: send that link to the user in chat, and only to them. While the handoff is active, other browser actions on this tab are refused, so do not act on the page; wait for the user. The user returns control with the Done button on the link. Use action 'release' to return control yourself once the user says they are finished, or if the handoff is no longer needed. Use action 'status' to check whether the user still holds the tab. A handoff ends on its own after the idle time with no input from the user. Never ask the user to type a password into the chat: have them type it into the live view instead.",
  inputSchema: z.object({
    tabId: CamofoxTabIdSchema,
    action: z.enum(["start", "release", "status"]),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Required for start. Shown to the user, for example 'Sign in to your bank'."),
    idleMinutes: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(DEFAULT_IDLE_MINUTES)
      .describe("Minutes with no input from the user before control returns to the agent."),
  }),
  outputSchema: HandoffOutputSchema,
  async execute({ tabId, action, reason, idleMinutes }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const tab = encodeURIComponent(tabId);
    const idleMs = idleMinutes * 60 * 1000;

    if (action === "status") {
      const response = await camofoxRequest(
        `/tabs/${tab}/control`,
        userId,
        ctx.abortSignal,
        "handoff status",
      );
      const status = parseCamofoxResponse(
        StatusSchema,
        await readCamofoxJson(response, "handoff status"),
        "handoff status",
      );
      return {
        ok: true as const,
        action,
        mode: status.mode,
        until: status.until ?? null,
        reason: status.reason ?? null,
        controlUrl: null,
      };
    }

    if (action === "release") {
      const response = await camofoxRequest(
        `/tabs/${tab}/handoff/release`,
        userId,
        ctx.abortSignal,
        "handoff release",
        { method: "POST", body: camofoxPostBody(userId, {}) },
      );
      parseCamofoxResponse(
        ReleaseResponseSchema,
        await readCamofoxJson(response, "handoff release"),
        "handoff release",
      );
      return {
        ok: true as const,
        action,
        mode: "agent" as const,
        until: null,
        reason: null,
        controlUrl: null,
      };
    }

    // start
    if (!reason) {
      throw new Error("A reason is required to start a handoff, so the user knows what to do.");
    }

    const started = await camofoxRequest(
      `/tabs/${tab}/handoff`,
      userId,
      ctx.abortSignal,
      "handoff start",
      {
        method: "POST",
        body: camofoxPostBody(userId, { reason, idleMs }),
      },
    ).then((response) =>
      readCamofoxJson(response, "handoff start").then((value) =>
        parseCamofoxResponse(HandoffStartResponseSchema, value, "handoff start"),
      ),
    ).catch((error: unknown) => {
      if (isConflict(error)) {
        throw new Error("The handoff could not start because the tab is already under a handoff.");
      }
      throw error;
    });

    // Issue the control link. If this fails, release the handoff so the agent
    // is not left blocked on a tab nobody can reach.
    let controlUrl: string;
    try {
      const linkResponse = await camofoxRequest(
        "/live-viewer/links",
        userId,
        ctx.abortSignal,
        "issue control link",
        {
          method: "POST",
          body: camofoxPostBody(userId, {
            tabId,
            control: true,
            ttlSeconds: CONTROL_LINK_TTL_SECONDS,
          }),
        },
      );
      const link = parseCamofoxResponse(
        LinkResponseSchema,
        await readCamofoxJson(linkResponse, "issue control link"),
        "issue control link",
      );
      controlUrl = checkedControlUrl(link.url);
    } catch (error) {
      await camofoxRequest(
        `/tabs/${tab}/handoff/release`,
        userId,
        ctx.abortSignal,
        "handoff release after failed link",
        { method: "POST", body: camofoxPostBody(userId, {}) },
      ).catch(() => undefined);
      if (isConflict(error)) {
        throw new Error("The handoff could not start because the tab is already under a handoff.");
      }
      throw error;
    }

    return {
      ok: true as const,
      action,
      mode: started.mode,
      until: started.until,
      reason: started.reason,
      controlUrl,
    };
  },
});