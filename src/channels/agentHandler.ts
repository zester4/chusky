import { runAgent, ApprovalRequiredError, transcribeAudio } from "../agent.js";
import {
  addUsage,
  appendChannelConversationMessages,
  appendMessages,
  claimApproval,
  getApproval,
  getChannelConversation,
  getSession,
  setApprovalStatus,
} from "../store.js";
import { approvalBlocks } from "./slack.js";
import type { ChannelMessageHandler } from "./gateway.js";
import type { ChuskyConversation, InboundMessage, OutboundMessage } from "./contracts.js";
import type { ContentPart } from "../types.js";
import { notifyTriggerApproval } from "../triggerWorkflow.js";
import { persistSendblueMedia } from "./sendblueMedia.js";

function reply(conversation: ChuskyConversation, text: string, idempotencySeed: string, extra: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    accountId: conversation.accountId,
    userId: conversation.userId,
    target: conversation.replyTarget,
    text,
    idempotencyKey: `chusky:${conversation.accountId}:${conversation.provider}:${idempotencySeed}`,
    kind: "message",
    ...extra,
  };
}

async function privateOrSharedHistory(conversation: ChuskyConversation) {
  if (conversation.scope === "private") {
    const session = await getSession(conversation.userId);
    return { history: session.history, model: session.model };
  }
  const stored = await getChannelConversation(conversation.conversationId);
  const session = await getSession(conversation.userId);
  return { history: stored?.history ?? [], model: session.model };
}

async function saveConversation(conversation: ChuskyConversation, message: InboundMessage, text: string, response: string): Promise<void> {
  const messages = [{ role: "user" as const, content: text }, { role: "assistant" as const, content: response }];
  if (conversation.scope === "private") await appendMessages(conversation.userId, messages);
  else await appendChannelConversationMessages({ id: conversation.conversationId, accountId: conversation.accountId, userId: conversation.userId, provider: conversation.provider, scope: conversation.scope, messages });
}

function dataUrlBytes(url: string): { mimeType: string; bytes: Buffer; dataUrl: string } | undefined {
  const match = url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return undefined;
  return { mimeType: match[1], bytes: Buffer.from(match[2], "base64"), dataUrl: url };
}

async function buildAgentInput(message: InboundMessage): Promise<{ input: string | ContentPart[]; historyLabel: string }> {
  const attachments = message.attachments.slice(0, 5);
  if (!attachments.length) return { input: message.text ?? "", historyLabel: message.text ?? "" };
  const parts: ContentPart[] = [{ type: "text", text: message.text || "Please analyze the attached media." }];
  const labels: string[] = [];
  for (const attachment of attachments) {
    const decoded = attachment.url ? dataUrlBytes(attachment.url) : undefined;
    if (!decoded) continue;
    labels.push(attachment.filename ?? attachment.kind);
    if (attachment.kind === "image") parts.push({ type: "image_url", image_url: { url: decoded.dataUrl } });
    else if (attachment.kind === "video") parts.push({ type: "video_url", video_url: { url: decoded.dataUrl } });
    else if (attachment.kind === "document") parts.push({ type: "file", file: { filename: attachment.filename ?? "document", file_data: decoded.dataUrl } });
    else if (attachment.kind === "audio") {
      const extension = decoded.mimeType.split("/")[1] === "mpeg" ? "mp3" : decoded.mimeType.split("/")[1] || "ogg";
      const transcript = await transcribeAudio(decoded.bytes, extension);
      parts[0] = { type: "text", text: `${message.text ?? ""}\n\nTranscript of ${attachment.filename ?? "voice message"}:\n${transcript}`.trim() };
    }
  }
  if (parts.length === 1 && labels.length === 0) return { input: message.text ?? "", historyLabel: message.text ?? "" };
  return { input: parts, historyLabel: `${message.text ?? "[Attachment]"}\nAttached: ${labels.join(", ")}` };
}

async function handleApproval(message: InboundMessage, conversation: ChuskyConversation): Promise<OutboundMessage> {
  const approvalId = message.interaction?.value;
  const action = message.interaction?.id.endsWith("deny") ? "deny" : "approve";
  if (!approvalId) return reply(conversation, "I couldn’t identify that approval request.", message.providerEventId);
  const approval = await getApproval(conversation.userId, approvalId);
  if (!approval || approval.expiresAt <= Date.now() || approval.status !== "pending") return reply(conversation, "That approval has expired or was already handled.", message.providerEventId);
  if (action === "deny") {
    if (!(await setApprovalStatus(conversation.userId, approvalId, "denied"))) return reply(conversation, "That approval could not be denied safely.", message.providerEventId);
    if (approval.triggerEventId) await notifyTriggerApproval(approval.id, false, approval.triggerEventId);
    return reply(conversation, "❌ Denied. I did not run the requested action.", message.providerEventId, { kind: "approval", correlationId: approvalId });
  }
  if (!(await claimApproval(conversation.userId, approvalId))) return reply(conversation, "That approval was already claimed by another request.", message.providerEventId);
  if (approval.triggerEventId) {
    await notifyTriggerApproval(approval.id, true, approval.triggerEventId);
    return reply(conversation, "✅ Approved. Chusky is resuming the triggered workflow.", message.providerEventId, { kind: "approval", correlationId: approvalId });
  }
  try {
    const result = await runAgent(conversation.userId, approval.request, approval.history, approval.model, undefined, undefined, undefined, approvalId, { accountId: conversation.accountId, provider: conversation.provider, conversationId: conversation.conversationId });
    await saveConversation(conversation, message, approval.request, result.text);
    if (result.cost) await addUsage(conversation.userId, result.cost);
    const attachments = conversation.provider === "sendblue" ? await persistSendblueMedia(conversation.userId, result.generatedImages, result.generatedFiles) : [];
    return reply(conversation, result.text, message.providerEventId, { kind: "approval", correlationId: approvalId, ...(attachments.length ? { attachments } : {}) });
  } catch (error) {
    return reply(conversation, `I approved the action, but it failed before completion: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000), message.providerEventId, { kind: "approval", correlationId: approvalId });
  }
}

export function createAgentChannelHandler(): ChannelMessageHandler {
  return async (message, conversation) => {
    if (message.interaction?.kind === "approval") return handleApproval(message, conversation);
    const text = message.text?.trim();
    if (!text && !message.attachments.length) return reply(conversation, "I received that, but there was no text or supported attachment to work with.", message.providerEventId);
    if (message.attachments.length && message.attachments.some((attachment) => !attachment.url)) return reply(conversation, "I received the attachment, but the channel could not provide its media bytes safely.", message.providerEventId);
    const { history, model } = await privateOrSharedHistory(conversation);
    try {
      const prepared = await buildAgentInput(message);
      const result = await runAgent(conversation.userId, prepared.input, history, model, undefined, undefined, undefined, undefined, { accountId: conversation.accountId, provider: conversation.provider, conversationId: conversation.conversationId });
      await saveConversation(conversation, message, prepared.historyLabel, result.text);
      if (result.cost) await addUsage(conversation.userId, result.cost);
      const attachments = conversation.provider === "sendblue" ? await persistSendblueMedia(conversation.userId, result.generatedImages, result.generatedFiles) : [];
      return reply(conversation, result.text, message.providerEventId, { kind: "message", ...(attachments.length ? { attachments } : {}) });
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        const blocks = conversation.provider === "slack" ? approvalBlocks(error.approvalId, error.toolSlug) : undefined;
        const interactive = conversation.provider === "whatsapp" ? { kind: "buttons" as const, body: `Approval required before I can run ${error.toolSlug}.`, buttons: [{ id: `chusky_approval_approve:${error.approvalId}`, title: "Approve" }, { id: `chusky_approval_deny:${error.approvalId}`, title: "Deny" }] } : undefined;
        return reply(conversation, `Approval required before I can run ${error.toolSlug}. Approval ID: ${error.approvalId}`, message.providerEventId, { blocks, interactive, kind: "approval", correlationId: error.approvalId });
      }
      throw error;
    }
  };
}
