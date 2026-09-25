import test from "node:test";
import assert from "node:assert/strict";
import { buildMediaBridgeArguments } from "../src/mediaBridge.js";
import { executeMediaBridgeAction, prepareMediaBridgeApprovalSource, setAgentDependenciesForTests } from "../src/agent.js";

const file = { name: "brand.png", contentType: "image/png", data: Buffer.from("png-bytes") } as const;

test("media bridge injects an HTTPS image URL into an exact social action", () => {
  const result = buildMediaBridgeArguments({
    type: "object",
    properties: {
      text: { type: "string" },
      media_url: { type: "string", description: "Public image URL to attach" },
    },
  }, { text: "Launch" }, file, "https://cdn.example/chusky.png");
  assert.equal(result.mode, "url");
  assert.deepEqual(result.arguments, { text: "Launch", media_url: "https://cdn.example/chusky.png" });
});

test("media bridge injects binary bytes through an unambiguous upload schema", () => {
  const result = buildMediaBridgeArguments({
    type: "object",
    properties: {
      caption: { type: "string" },
      attachments: { type: "array", items: { type: "object", properties: { file_name: { type: "string" }, file_data: { type: "string" }, mime_type: { type: "string" } } } },
    },
  }, { caption: "Launch" }, file);
  assert.equal(result.mode, "binary");
  assert.deepEqual(result.arguments, {
    caption: "Launch",
    attachments: [{ file_name: "brand.png", file_data: Buffer.from("png-bytes").toString("base64"), mime_type: "image/png" }],
  });
});

test("media bridge refuses ambiguous URL fields and caller-supplied media", () => {
  assert.throws(() => buildMediaBridgeArguments({
    type: "object",
    properties: { image_url: { type: "string" }, media_url: { type: "string" } },
  }, {}, file, "https://cdn.example/chusky.png"), /multiple possible media URL fields/i);
  assert.throws(() => buildMediaBridgeArguments({
    type: "object",
    properties: { image_url: { type: "string" } },
  }, { image_url: "https://attacker.example/image" }, file, "https://cdn.example/chusky.png"), /Do not supply image_url/i);
});

test("media bridge rejects unsafe URLs and images outside its transfer bound", () => {
  const schema = { type: "object", properties: { image_url: { type: "string" } } };
  assert.throws(() => buildMediaBridgeArguments(schema, {}, file, "http://cdn.example/image.png"), /HTTPS media URL/i);
  assert.throws(() => buildMediaBridgeArguments(schema, {}, file, "https://user:pass@cdn.example/image.png"), /HTTPS media URL/i);
  assert.throws(() => buildMediaBridgeArguments(schema, {}, { ...file, data: Buffer.alloc(25 * 1024 * 1024 + 1) }, "https://cdn.example/image.png"), /25 MB/i);
});

test("approved current-image transfer resumes from its owner-scoped asset and confirms the exact provider action", async () => {
  const userId = 839101;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const saved: Array<{ owner: number; bytes: Buffer }> = [];
  const executed: Array<{ slug: string; args: Record<string, unknown>; account?: string }> = [];
  let providerSuccessful = true;
  const mediaBridgeStorage = {
    saveImageAsset: async (owner: number, input: any, bytes: Uint8Array) => {
      saved.push({ owner, bytes: Buffer.from(bytes) });
      return { id: "img_owner_839101", r2Key: "images/839101/image.png", name: input.name, contentType: input.contentType, size: bytes.byteLength } as any;
    },
    getImageAsset: async (owner: number, id: string) => owner === userId && id === "img_owner_839101"
      ? { id, r2Key: "images/839101/image.png", name: "brand.png", contentType: "image/png", size: imageBytes.length, downloadUrl: "https://expired.example/ignored" } as any
      : undefined,
    readR2Object: async (key: string) => {
      assert.equal(key, "images/839101/image.png");
      return Buffer.from(imageBytes);
    },
    signR2Download: async (key: string, ttl: number) => {
      assert.equal(key, "images/839101/image.png");
      assert.equal(ttl, 900);
      return "https://signed.example/private-image?token=short-lived";
    },
  };
  const session = {
    sessionId: "media-bridge-test-session",
    tools: async () => [{ type: "function", function: { name: "INSTAGRAM_CREATE_POST", description: "Create a post with image", parameters: { type: "object", properties: { caption: { type: "string" }, image_url: { type: "string", description: "Public image URL" } }, required: ["caption", "image_url"], additionalProperties: false } } }],
    execute: async (slug: string, args: Record<string, unknown>, options?: { account?: string }) => {
      executed.push({ slug, args, account: options?.account });
      return { successful: providerSuccessful, data: { mediaId: "provider-media-456", status: "published" } };
    },
  };
  setAgentDependenciesForTests({ composio: { create: async () => session, sessions: { use: async () => session } }, mediaBridgeStorage });
  try {
    const approvalArgs = await prepareMediaBridgeApprovalSource(userId, { source: "current", sourceIndex: 0, toolSlug: "INSTAGRAM_CREATE_POST", arguments: { caption: "Launch" }, account: "brand" }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] });
    assert.deepEqual(approvalArgs, { source: "asset", assetId: "img_owner_839101", toolSlug: "INSTAGRAM_CREATE_POST", arguments: { caption: "Launch" }, account: "brand" });
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.owner, userId);
    assert.deepEqual(saved[0]?.bytes, imageBytes);
    const directTools = await session.tools();
    const result = await executeMediaBridgeAction(userId, session, directTools, approvalArgs, {});
    assert.deepEqual(result, { providerActionSucceeded: true, mediaTransferred: true, toolSlug: "INSTAGRAM_CREATE_POST", source: "asset", mode: "url", assetId: "img_owner_839101", size: imageBytes.length, contentType: "image/png", mediaId: "provider-media-456", status: "published" });
    assert.equal(executed.length, 1);
    assert.equal(executed[0]?.slug, "INSTAGRAM_CREATE_POST");
    assert.equal(executed[0]?.account, "brand");
    assert.deepEqual(executed[0]?.args, { caption: "Launch", image_url: "https://signed.example/private-image?token=short-lived" });
    providerSuccessful = false;
    await assert.rejects(() => executeMediaBridgeAction(userId, session, directTools, approvalArgs, {}), /did not confirm.*succeeded/i);
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});
