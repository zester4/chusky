import assert from "node:assert/strict";
import test from "node:test";
import { normalizePhotonMessage, photonMessageFromEvent, PhotonAdapter } from "../src/channels/photon.js";

const projectId = "pho_prj_test";

function message(overrides: Record<string, unknown> = {}): any {
  return {
    id: "pho_msg_in",
    projectId,
    platform: "imessage",
    status: "received",
    createdAt: "2026-10-18T10:00:00.000Z",
    sentBy: { id: "pho_usr_human", kind: "human", handle: "+14155550123" },
    receivedBy: { id: "pho_usr_agent", kind: "agent", handle: "+14155550188" },
    space: { id: "pho_spc_direct", kind: "direct", participantIds: ["pho_usr_human", "pho_usr_agent"] },
    content: { type: "text", format: "plain", text: "Hello from iMessage" },
    ...overrides,
  };
}

test("Photon Beta runtime package loads through the documented ESM entry point", async () => {
  const importer = new Function("name", "return import(name)") as (name: string) => Promise<{ Photon: new (options: Record<string, unknown>) => unknown }>;
  const runtime = await importer("@photon-ai/api");
  assert.equal(typeof runtime.Photon, "function");
});

test("Photon Beta message normalization preserves project, agent, space, and private scope", async () => {
  const normalized = await normalizePhotonMessage(message(), { projectId, defaultScope: "shared" });
  assert.equal(normalized?.provider, "photon_imessage");
  assert.equal(normalized?.providerWorkspaceId, projectId);
  assert.equal(normalized?.providerAgentId, "pho_usr_agent");
  assert.equal(normalized?.providerConversationId, "pho_spc_direct");
  assert.equal(normalized?.providerReplyToId, undefined);
  assert.equal(normalized?.scope, "private");
  assert.equal(normalized?.text, "Hello from iMessage");
});

test("Photon Beta group messages use the configured shared scope and platform namespaces", async () => {
  const normalized = await normalizePhotonMessage(message({
    id: "pho_msg_group",
    platform: "whatsapp_business",
    receivedBy: { id: "pho_usr_agent", kind: "agent", handle: "business-agent" },
    space: { id: "pho_spc_group", kind: "group", participantIds: ["pho_usr_human", "pho_usr_agent", "pho_usr_other"] },
    content: { type: "group", parts: [{ type: "text", format: "plain", text: "First" }, { type: "text", format: "plain", text: "Second" }] },
  }), { projectId, defaultScope: "shared" });
  assert.equal(normalized?.provider, "photon_whatsapp");
  assert.equal(normalized?.scope, "shared");
  assert.equal(normalized?.text, "First\n\nSecond");
  assert.deepEqual(normalized?.providerParticipantIds, ["pho_usr_human", "pho_usr_agent", "pho_usr_other"]);
});

test("Photon normalization fails closed for outbound, wrong-project, unsupported, and untrusted messages", async () => {
  assert.equal(await normalizePhotonMessage(message({ status: "sent" }), { projectId, defaultScope: "shared" }), undefined);
  assert.equal(await normalizePhotonMessage(message({ projectId: "pho_prj_other" }), { projectId, defaultScope: "shared" }), undefined);
  assert.equal(await normalizePhotonMessage(message({ platform: "discord" }), { projectId, defaultScope: "shared" }), undefined);
  assert.equal(await normalizePhotonMessage(message({ sentBy: { id: "pho_usr_bot", kind: "agent", handle: "bot" } }), { projectId, defaultScope: "shared" }), undefined);
});

test("Photon attachments are bounded and never hydrate an oversized object", async () => {
  const normalized = await normalizePhotonMessage(message({
    content: { type: "attachment", attachmentId: "pho_att_large", contentType: "image/png", sizeBytes: 13 * 1024 * 1024 },
  }), { projectId, defaultScope: "shared", readAttachment: async () => ({ bytes: Buffer.from("must-not-be-read"), mimeType: "image/png" }) });
  assert.equal(normalized?.attachments[0]?.mediaError, "too_large");
  assert.equal(normalized?.attachments[0]?.url, undefined);
});

test("Photon events only expose received message objects", () => {
  const raw = message();
  assert.deepEqual(photonMessageFromEvent({ type: "message.received", data: { object: raw } }), raw);
  assert.equal(photonMessageFromEvent({ type: "message.sent", data: { object: raw } }), undefined);
  assert.equal(photonMessageFromEvent({ type: "message.received", data: {} }), undefined);
});

test("Photon adapter sends with the incoming space, receiving agent, parent, and idempotency key", async () => {
  const sent: any[] = [];
  const client = {
    projects: {
      sendMessage: async (input: any) => { sent.push(input); return { id: "pho_msg_out" }; },
      setSpaceTyping: async () => undefined,
    },
  } as any;
  const adapter = new PhotonAdapter("photon_imessage", client);
  const receipt = await adapter.send({
    accountId: "account_1",
    userId: 1,
    target: {
      provider: "photon_imessage",
      conversationId: "pho_spc_direct",
      metadata: { photonProjectId: projectId, photonAgentId: "pho_usr_agent", photonParentMessageId: "pho_msg_in" },
    },
    text: "Hello from Chusky",
    idempotencyKey: "photon-test-1",
  });
  assert.equal(receipt.providerMessageId, "pho_msg_out");
  assert.deepEqual(sent[0], {
    path: { id: projectId },
    headers: { "idempotency-key": "photon-test-1" },
    body: {
      spaceId: "pho_spc_direct",
      senderId: "pho_usr_agent",
      parentMessageId: "pho_msg_in",
      content: { type: "text", format: "plain", text: "Hello from Chusky" },
    },
  });
});

test("Photon adapter uploads outbound media with a separate stable idempotency key", async () => {
  const uploads: any[] = [];
  const sends: any[] = [];
  const client = {
    projects: {
      uploadAttachment: async (input: any) => { uploads.push(input); return { id: "pho_att_1" }; },
      sendMessage: async (input: any) => { sends.push(input); return { id: "pho_msg_media" }; },
    },
  } as any;
  const adapter = new PhotonAdapter("photon_telegram", client);
  await adapter.send({
    accountId: "account_1",
    userId: 1,
    target: {
      provider: "photon_telegram",
      conversationId: "pho_spc_telegram",
      metadata: { photonProjectId: projectId, photonAgentId: "pho_usr_agent" },
    },
    attachments: [{ id: "inline", kind: "image", mimeType: "image/png", url: "data:image/png;base64,aGVsbG8=" }],
    idempotencyKey: "photon-media-1",
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].headers["idempotency-key"], "photon-media-1:attachment:0");
  assert.equal(uploads[0].headers["content-type"], "image/png");
  assert.deepEqual(sends[0].body.content, { type: "attachment", attachmentId: "pho_att_1" });
});
