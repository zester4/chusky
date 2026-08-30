import { createHmac, timingSafeEqual } from "node:crypto";
import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import { ChannelVerificationError } from "./contracts.js";
import type { ChannelAdapter, ChannelAttachment, DeliveryReceipt, InboundMessage, OutboundMessage, ReplyTarget } from "./contracts.js";

const SLACK_MAX_AGE_SECONDS = 5 * 60;
const SLACK_MAX_FILE_BYTES = 25 * 1024 * 1024;
const SLACK_TRUSTED_HOSTS = new Set(["files.slack.com", "slack-files.com"]);
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function header(headers: Headers | Record<string, string | undefined>, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? headers.get(name.toLowerCase()) ?? "";
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return value ?? "";
}

export function verifySlackSignature(rawBody: string | Buffer, headers: Headers | Record<string, string | undefined>, signingSecret: string, nowMs = Date.now()): void {
  if (!signingSecret) throw new ChannelVerificationError("Slack signing secret is not configured");
  const timestamp = header(headers, "x-slack-request-timestamp");
  const signature = header(headers, "x-slack-signature");
  const seconds = Number(timestamp);
  if (!timestamp || !signature || !Number.isFinite(seconds) || Math.abs(nowMs - seconds * 1000) > SLACK_MAX_AGE_SECONDS * 1000) {
    throw new ChannelVerificationError("Invalid or stale Slack request signature");
  }
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody.toString()}`).digest("hex")}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new ChannelVerificationError("Invalid Slack request signature");
  }
}

function slackAttachments(event: any): ChannelAttachment[] {
  return (Array.isArray(event.files) ? event.files : []).slice(0, 10).map((file: any) => ({
    id: String(file.id ?? file.name ?? "file"),
    kind: String(file.mimetype ?? "").startsWith("image/") ? "image" : String(file.mimetype ?? "").startsWith("audio/") ? "audio" : String(file.mimetype ?? "").startsWith("video/") ? "video" : "document",
    mimeType: file.mimetype ? String(file.mimetype) : undefined,
    filename: file.name ? String(file.name).slice(0, 200) : undefined,
    sizeBytes: Number.isFinite(Number(file.size)) ? Number(file.size) : undefined,
    url: file.url_private_download || file.url_private ? String(file.url_private_download || file.url_private) : undefined,
  }));
}

export function normalizeSlackEvent(payload: any, receivedAt = Date.now()): InboundMessage | undefined {
  if (!payload || payload.type !== "event_callback" || !payload.event_id || !payload.team_id) return undefined;
  const event = payload.event;
  if (!event || !event.user || event.bot_id || event.subtype === "bot_message" || event.subtype === "message_changed" || event.subtype === "message_deleted") return undefined;
  if (event.type !== "message" && event.type !== "app_mention") return undefined;
  const channelId = String(event.channel ?? "").trim();
  if (!channelId) return undefined;
  const privateConversation = event.type === "message" && ["im", "mpim"].includes(String(event.channel_type ?? ""));
  const text = String(event.text ?? "").replace(/<@[A-Z0-9]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    provider: "slack",
    providerEventId: String(payload.event_id),
    providerUserId: String(event.user),
    providerWorkspaceId: String(payload.team_id),
    providerConversationId: channelId,
    providerThreadId: event.thread_ts ? String(event.thread_ts) : undefined,
    text: text || undefined,
    attachments: slackAttachments(event),
    receivedAt,
    scope: privateConversation ? "private" : "shared",
    displayName: event.username ? String(event.username).slice(0, 200) : undefined,
  };
}

export interface SlackInteraction {
  eventId: string;
  workspaceId: string;
  userId: string;
  channelId: string;
  messageTs?: string;
  responseUrl?: string;
  actionId: string;
  value?: string;
}

export function parseSlackInteraction(rawBody: string, receivedAt = Date.now()): { interaction: SlackInteraction; message: InboundMessage } | undefined {
  const params = new URLSearchParams(rawBody);
  const raw = params.get("payload");
  if (!raw) return undefined;
  let payload: any;
  try { payload = JSON.parse(raw); } catch { throw new ChannelVerificationError("Malformed Slack interaction payload", 400); }
  const action = Array.isArray(payload.actions) ? payload.actions[0] : undefined;
  const workspaceId = String(payload.team?.id ?? "").trim();
  const userId = String(payload.user?.id ?? "").trim();
  const channelId = String(payload.channel?.id ?? "").trim();
  const actionId = String(action?.action_id ?? "").trim();
  if (!workspaceId || !userId || !channelId || !actionId) throw new ChannelVerificationError("Incomplete Slack interaction payload", 400);
  const eventId = String(payload.trigger_id ?? `${workspaceId}:${channelId}:${payload.message?.ts ?? ""}:${actionId}`);
  const interaction: SlackInteraction = { eventId, workspaceId, userId, channelId, messageTs: payload.message?.ts ? String(payload.message.ts) : undefined, responseUrl: payload.response_url ? String(payload.response_url) : undefined, actionId, value: action?.value === undefined ? undefined : String(action.value) };
  return {
    interaction,
    message: {
      provider: "slack",
      providerEventId: `interaction:${eventId}`,
      providerUserId: userId,
      providerWorkspaceId: workspaceId,
      providerConversationId: channelId,
      providerThreadId: payload.message?.thread_ts ? String(payload.message.thread_ts) : undefined,
      attachments: [],
      interaction: { kind: actionId.startsWith("chusky_approval_") ? "approval" : "button", id: actionId, value: interaction.value },
      receivedAt,
      scope: "private",
    },
  };
}

export function approvalBlocks(approvalId: string, toolSlug: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Approval required*\nChusky wants to execute \`${toolSlug}\`.` } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Approve" }, style: "primary", action_id: "chusky_approval_approve", value: approvalId },
      { type: "button", text: { type: "plain_text", text: "Deny" }, style: "danger", action_id: "chusky_approval_deny", value: approvalId },
    ] },
  ];
}

export class SlackAdapter implements ChannelAdapter {
  readonly provider = "slack" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.slack;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly token: string | ((workspaceId?: string) => Promise<string | undefined>), fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private async api<T>(method: string, body: Record<string, unknown>, workspaceId?: string): Promise<T> {
    const token = typeof this.token === "function" ? await this.token(workspaceId) : this.token;
    if (!token) throw new Error("Slack bot token is not configured for this workspace");
    const response = await this.fetchImpl(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    const value = await response.json() as any;
    if (!response.ok || !value.ok) throw new Error(`Slack ${method} failed: ${value.error ?? response.statusText}`);
    return value as T;
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const response = await this.api<any>("chat.postMessage", { channel: message.target.conversationId, text: message.text ?? "", ...(message.target.threadId ? { thread_ts: message.target.threadId } : {}), ...(message.blocks?.length ? { blocks: message.blocks } : {}) }, message.target.workspaceId);
    return { providerMessageId: String(response.ts ?? ""), deliveredAt: Date.now(), metadata: { channelId: String(response.channel ?? message.target.conversationId) } };
  }

  async edit(target: ReplyTarget, providerMessageId: string, text: string, blocks?: unknown[]): Promise<DeliveryReceipt> {
    const response = await this.api<any>("chat.update", { channel: target.conversationId, ts: providerMessageId, text, ...(blocks?.length ? { blocks } : {}) }, target.workspaceId);
    return { providerMessageId: String(response.ts ?? providerMessageId), deliveredAt: Date.now() };
  }

  async typing(_target: ReplyTarget): Promise<void> {
    // Slack has no public bot typing endpoint. Deliberately do nothing.
  }

  /** Hydrate Slack private file URLs only from Slack-owned hosts, with a
   * bounded manual-redirect download. Tokens are never sent to redirects. */
  async hydrateInbound(message: InboundMessage): Promise<InboundMessage> {
    if (!message.attachments.length) return message;
    const attachments = await Promise.all(message.attachments.slice(0, 5).map(async (attachment) => {
      if (!attachment.url || attachment.url.startsWith("data:")) return attachment;
      const parsed = new URL(attachment.url);
      if (!SLACK_TRUSTED_HOSTS.has(parsed.hostname) && !parsed.hostname.endsWith(".slack.com")) throw new Error("Slack attachment host is not trusted");
      const token = typeof this.token === "function" ? await this.token(message.providerWorkspaceId) : this.token;
      if (!token) throw new Error("Slack bot token is not configured for file download");
      const response = await this.fetchImpl(attachment.url, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) throw new Error("Slack attachment redirect rejected");
      if (!response.ok) throw new Error(`Slack attachment download failed (${response.status})`);
      const declared = Number(response.headers.get("content-length") ?? attachment.sizeBytes ?? 0);
      if (declared > SLACK_MAX_FILE_BYTES) throw new Error("Slack attachment exceeds the 25 MB limit");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > SLACK_MAX_FILE_BYTES) throw new Error("Slack attachment exceeds the 25 MB limit");
      const mime = attachment.mimeType ?? "application/octet-stream";
      return { ...attachment, url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`, sizeBytes: bytes.byteLength };
    }));
    return { ...message, attachments };
  }
}
