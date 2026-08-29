import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { config } from "../config.js";
import { claimChannelInboundEvent, consumeChannelLinkCode, consumeChannelOAuthState, createChannelInboundEvent, createChannelOAuthState, getOutboxByProviderMessageId, hashCliSecret, saveChannelInstallation, updateChannelInboundEvent, updateOutbox } from "../store.js";
import { linkChannelIdentity } from "./identity.js";
import { ChannelGateway } from "./gateway.js";
import { ChannelVerificationError } from "./contracts.js";
import { normalizeSlackEvent, parseSlackInteraction, SlackAdapter, verifySlackSignature } from "./slack.js";
import { normalizeWhatsAppMessages, normalizeWhatsAppStatuses, verifyWhatsAppChallenge, verifyWhatsAppSignature, WhatsAppAdapter } from "./whatsapp.js";
import { normalizeSendblueMessage, normalizeSendblueStatus, SendblueAdapter, verifySendblueSignature } from "./sendblue.js";
import { ChannelDebouncer } from "./debounce.js";
import { logger } from "../logger.js";

interface ChannelRouteOptions {
  gateway: ChannelGateway;
  slack?: { adapter: SlackAdapter; signingSecret: string };
  whatsapp?: { adapter: WhatsAppAdapter; appSecret: string; verifyToken: string };
  sendblue?: { adapter: SendblueAdapter; webhookSecret: string; enqueue?: (eventId: string) => Promise<void> };
}

function errorStatus(error: unknown): 400 | 401 | 403 | 500 | 503 {
  if (error instanceof ChannelVerificationError) return error.statusCode;
  return 500;
}

export function registerChannelRoutes(app: Hono, options: ChannelRouteOptions): void {
  const { gateway } = options;

  if (options.slack) {
    const slack = options.slack;
    app.get("/slack/install", async (c) => {
      if (!config.slackClientId || !config.slackRedirectUri) return c.json({ ok: false, error: "Slack OAuth is not configured" }, 503);
      const code = String(c.req.query("code") ?? "").trim();
      if (!/^\d{6}$/.test(code)) return c.json({ ok: false, error: "A one-time Telegram Slack link code is required" }, 400);
      const claim = await consumeChannelLinkCode("slack", code);
      if (!claim) return c.json({ ok: false, error: "Invalid or expired Slack link code" }, 401);
      const state = randomBytes(24).toString("base64url");
      await createChannelOAuthState(claim.userId, hashCliSecret(state));
      const params = new URLSearchParams({ client_id: config.slackClientId, redirect_uri: config.slackRedirectUri, state, scope: "chat:write" });
      return c.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
    });

    app.get("/slack/oauth/callback", async (c) => {
      try {
        const state = String(c.req.query("state") ?? "");
        const stateRecord = await consumeChannelOAuthState(hashCliSecret(state));
        if (!stateRecord) return c.json({ ok: false, error: "Invalid or expired Slack OAuth state" }, 401);
        const code = String(c.req.query("code") ?? "");
        if (!code || !config.slackClientId || !config.slackClientSecret || !config.slackRedirectUri) return c.json({ ok: false, error: "Incomplete Slack OAuth configuration" }, 400);
        const response = await fetch("https://slack.com/api/oauth.v2.access", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: config.slackClientId, client_secret: config.slackClientSecret, redirect_uri: config.slackRedirectUri }) });
        const value = await response.json() as any;
        if (!response.ok || !value.ok || !value.team?.id || !value.access_token) return c.json({ ok: false, error: `Slack OAuth failed: ${value.error ?? response.statusText}` }, 502);
        const workspaceId = String(value.team.id);
        await saveChannelInstallation({ provider: "slack", workspaceId, botToken: String(value.access_token), appId: value.app_id ? String(value.app_id) : undefined, teamName: value.team.name ? String(value.team.name) : undefined, installedByUserId: stateRecord.userId, createdAt: Date.now(), updatedAt: Date.now() });
        const slackUserId = value.authed_user?.id ? String(value.authed_user.id) : "";
        if (slackUserId) await linkChannelIdentity(stateRecord.userId, { provider: "slack", externalUserId: slackUserId, workspaceId });
        return c.json({ ok: true, provider: "slack", workspaceId, linked: Boolean(slackUserId) });
      } catch (error) {
        logger.error({ err: error }, "Slack OAuth callback failed");
        return c.json({ ok: false, error: "Slack installation failed" }, errorStatus(error));
      }
    });

    app.post("/slack/events", async (c) => {
      const raw = await c.req.text();
      try {
        verifySlackSignature(raw, c.req.header(), slack.signingSecret);
        const payload = JSON.parse(raw) as any;
        if (payload.type === "url_verification") return c.json({ challenge: String(payload.challenge ?? "") });
        const message = normalizeSlackEvent(payload);
        if (!message) return c.json({ ok: true, ignored: true });
        // Slack requires a fast acknowledgement. Agent work is deliberately
        // detached from the HTTP acknowledgement after signature validation.
        void gateway.processInbound(message).catch((error) => logger.error({ err: error, eventId: message.providerEventId }, "Slack event processing failed"));
        return c.json({ ok: true });
      } catch (error) {
        logger.warn({ err: error }, "Rejected Slack event");
        return c.json({ ok: false, error: error instanceof ChannelVerificationError ? error.message : "invalid Slack event" }, errorStatus(error));
      }
    });

    app.post("/slack/interactions", async (c) => {
      const raw = await c.req.text();
      try {
        verifySlackSignature(raw, c.req.header(), slack.signingSecret);
        const parsed = parseSlackInteraction(raw);
        if (!parsed) return c.json({ ok: false, error: "invalid interaction payload" }, 400);
        void gateway.processInbound(parsed.message).then(async () => {
          if (parsed.interaction.messageTs && parsed.interaction.actionId.startsWith("chusky_approval_")) {
            await slack.adapter.edit({ provider: "slack", conversationId: parsed.interaction.channelId, workspaceId: parsed.interaction.workspaceId }, parsed.interaction.messageTs, "Approval handled by Chusky.");
          }
        }).catch((error) => logger.error({ err: error, eventId: parsed.message.providerEventId }, "Slack interaction processing failed"));
        return c.json({ ok: true });
      } catch (error) {
        logger.warn({ err: error }, "Rejected Slack interaction");
        return c.json({ ok: false, error: error instanceof ChannelVerificationError ? error.message : "invalid Slack interaction" }, errorStatus(error));
      }
    });
  }

  if (options.whatsapp) {
    const whatsapp = options.whatsapp;
    const debouncer = new ChannelDebouncer(900);
    app.get("/whatsapp/webhook", (c) => {
      try {
        const challenge = verifyWhatsAppChallenge(c.req.query("hub.mode"), c.req.query("hub.verify_token"), c.req.query("hub.challenge"), whatsapp.verifyToken);
        return c.text(challenge, 200);
      } catch (error) { return c.text("Forbidden", errorStatus(error)); }
    });
    app.post("/whatsapp/webhook", async (c) => {
      const raw = await c.req.text();
      try {
        verifyWhatsAppSignature(raw, c.req.header(), whatsapp.appSecret);
        const payload = JSON.parse(raw) as any;
        for (const status of normalizeWhatsAppStatuses(payload)) {
          const record = await getOutboxByProviderMessageId("whatsapp", status.providerMessageId);
          if (record) await updateOutbox(record.id, { providerStatus: status.status });
        }
        const messages = normalizeWhatsAppMessages(payload);
        if (!messages.length) return c.json({ ok: true, ignored: true });
        for (const message of messages) {
          const deliver = (queued: typeof message) => whatsapp.adapter.hydrateInbound(queued).then((hydrated) => gateway.processInbound(hydrated)).catch((error) => {
            logger.error({ err: error, eventId: message.providerEventId }, "WhatsApp media processing failed");
            return gateway.processInbound(queued).catch((fallbackError) => logger.error({ err: fallbackError, eventId: queued.providerEventId }, "WhatsApp fallback processing failed"));
          });
          if (message.text && !message.attachments.length) void debouncer.push(message, async (queued) => { await deliver(queued); });
          else void deliver(message);
        }
        return c.json({ ok: true });
      } catch (error) {
        logger.warn({ err: error }, "Rejected WhatsApp webhook");
        return c.json({ ok: false, error: error instanceof ChannelVerificationError ? error.message : "invalid WhatsApp event" }, errorStatus(error));
      }
    });
  }

  if (options.sendblue) {
    const sendblue = options.sendblue;
    app.post("/sendblue/webhook", async (c) => {
      const raw = await c.req.text();
      try {
        verifySendblueSignature(raw, c.req.header(), sendblue.webhookSecret);
        const payload = JSON.parse(raw) as any;
        const status = normalizeSendblueStatus(payload);
        if (status) {
          const record = await getOutboxByProviderMessageId("sendblue", status.providerMessageId);
          if (record) await updateOutbox(record.id, { providerStatus: status.status });
          return c.json({ ok: true, status: true });
        }
        const message = normalizeSendblueMessage(payload);
        if (!message) return c.json({ ok: true, ignored: true });
        const record = await createChannelInboundEvent(message);
        if (sendblue.enqueue && await claimChannelInboundEvent(record.eventId)) {
          const eventId = record.eventId;
          try {
            await sendblue.enqueue(eventId);
          } catch (error) {
            await updateChannelInboundEvent(eventId, { status: "received", error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
            throw error;
          }
          return c.json({ ok: true, queued: true }, 202);
        }
        if (!sendblue.enqueue) void sendblue.adapter.hydrateInbound(message).then((hydrated) => gateway.processInbound(hydrated)).catch((error) => logger.error({ err: error, eventId: message.providerEventId }, "Sendblue message processing failed"));
        return c.json({ ok: true, duplicate: record.status !== "received" });
      } catch (error) {
        logger.warn({ err: error }, "Rejected Sendblue webhook");
        return c.json({ ok: false, error: error instanceof ChannelVerificationError ? error.message : error instanceof SyntaxError ? "invalid Sendblue JSON" : "invalid Sendblue event" }, error instanceof SyntaxError ? 400 : errorStatus(error));
      }
    });
  }
}
