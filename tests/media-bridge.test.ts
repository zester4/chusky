import test from "node:test";
import assert from "node:assert/strict";
import { buildComposioFileUploadArguments, buildMediaBridgeArguments, composioFileUploadValidationSchema, hasComposioFileUploadField, hasMediaUrlField } from "../src/mediaBridge.js";
import { validateToolArgumentsAgainstSchema } from "../src/agentTools.js";
import { executeMediaBridgeAction, setAgentDependenciesForTests } from "../src/agent.js";

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

test("media bridge recognizes Composio file-uploadable fields and injects staged references", () => {
  const schema = { type: "object", required: ["attachment"], properties: {
    recipient_email: { type: "string" },
    attachment: { type: "string", file_uploadable: true },
  }, additionalProperties: false };
  assert.equal(hasComposioFileUploadField(schema), true);
  const uploaded = { name: "brand.png", mimetype: "image/png", s3key: "staged/opaque-key" };
  const args = buildComposioFileUploadArguments(schema, { recipient_email: "team@example.com" }, uploaded);
  assert.deepEqual(args, { recipient_email: "team@example.com", attachment: uploaded });
  validateToolArgumentsAgainstSchema("GMAIL_SEND_EMAIL", args, composioFileUploadValidationSchema(schema));
  assert.throws(() => buildComposioFileUploadArguments(schema, { attachment: "caller-value" }, uploaded), /Do not supply attachment/i);
});

test("media bridge refuses ambiguous URL fields and caller-supplied media", () => {
  assert.equal(hasMediaUrlField({ type: "object", properties: { redirect_url: { type: "string" }, profile_url: { type: "string" } } }), false);
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

test("owner-requested current-image transfer executes immediately and confirms the exact provider action", async () => {
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
    const directTools = await session.tools();
    const requestArgs = { source: "current", sourceIndex: 0, toolSlug: "INSTAGRAM_CREATE_POST", arguments: { caption: "Launch" }, account: "brand" };
    const runtime = { currentImages: [{ data: imageBytes, mediaType: "image/png" }] };
    const result = await executeMediaBridgeAction(userId, session, directTools, requestArgs, runtime);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.owner, userId);
    assert.deepEqual(saved[0]?.bytes, imageBytes);
    assert.deepEqual(result, { providerActionSucceeded: true, mediaTransferred: true, toolSlug: "INSTAGRAM_CREATE_POST", source: "current", mode: "url", assetId: "img_owner_839101", size: imageBytes.length, contentType: "image/png", mediaId: "provider-media-456", status: "published" });
    assert.equal(executed.length, 1);
    assert.equal(executed[0]?.slug, "INSTAGRAM_CREATE_POST");
    assert.equal(executed[0]?.account, "brand");
    assert.deepEqual(executed[0]?.args, { caption: "Launch", image_url: "https://signed.example/private-image?token=short-lived" });
    providerSuccessful = false;
    await assert.rejects(() => executeMediaBridgeAction(userId, session, directTools, requestArgs, runtime), /did not confirm.*succeeded/i);
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("media bridge resolves an exact discovered action through Composio schema meta-tools", async () => {
  const userId = 839102;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const schema = { type: "object", properties: { commentary: { type: "string" }, image_url: { type: "string", description: "Public image URL" } } };
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const session = {
    sessionId: "media-bridge-meta-session",
    tools: async () => [{ type: "function", function: { name: "COMPOSIO_GET_TOOL_SCHEMAS", parameters: { type: "object" } } }],
    execute: async (slug: string, args: Record<string, unknown>) => {
      calls.push({ slug, args });
      if (slug === "COMPOSIO_GET_TOOL_SCHEMAS") return { data: { toolSchemas: { INSTAGRAM_CREATE_POST: { toolSlug: "INSTAGRAM_CREATE_POST", inputSchema: schema } } }, error: null };
      return { successful: true, data: { id: "urn:li:share:confirmed" } };
    },
  };
  const mediaBridgeStorage = {
    saveImageAsset: async (owner: number, input: any, bytes: Uint8Array) => ({ id: `img_owner_${owner}`, r2Key: "images/owner/image.png", name: input.name, contentType: input.contentType, size: bytes.byteLength }) as any,
    getImageAsset: async () => undefined,
    readR2Object: async () => Buffer.from(imageBytes),
    signR2Download: async () => "https://signed.example/private-image",
  };
  setAgentDependenciesForTests({ composio: { create: async () => session, sessions: { use: async () => session } }, mediaBridgeStorage });
  try {
    const result = await executeMediaBridgeAction(userId, session, await session.tools(), {
      source: "current", toolSlug: "INSTAGRAM_CREATE_POST", arguments: { commentary: "Hello" },
    }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] });
    assert.equal(result.providerActionSucceeded, true);
    assert.equal(result.toolSlug, "INSTAGRAM_CREATE_POST");
    assert.deepEqual(calls[0], { slug: "COMPOSIO_GET_TOOL_SCHEMAS", args: { tool_slugs: ["INSTAGRAM_CREATE_POST"] } });
    assert.equal(calls[1]?.slug, "INSTAGRAM_CREATE_POST");
    assert.deepEqual(calls[1]?.args.image_url, "https://signed.example/private-image");
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("Instagram stages image bytes then publishes the returned container using the exact discovered schema", async () => {
  const userId = 839104;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const actionSchema = { type: "object", required: ["image_file"], properties: {
    caption: { type: "string" }, image_file: { type: "string", file_uploadable: true },
  }, additionalProperties: false };
  const publishSchema = { type: "object", required: ["creation_id"], properties: { creation_id: { type: "string" } }, additionalProperties: false };
  const uploaded: Array<{ file: File; toolSlug: string; toolkitSlug: string }> = [];
  const executions: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const session = {
    sessionId: "media-bridge-staged-session",
    tools: async () => [
      { type: "function", function: { name: "INSTAGRAM_POST_IG_USER_MEDIA", parameters: actionSchema } },
      { type: "function", function: { name: "COMPOSIO_GET_TOOL_SCHEMAS", parameters: { type: "object" } } },
    ],
    execute: async (slug: string, args: Record<string, unknown>) => {
      executions.push({ slug, args });
      if (slug === "COMPOSIO_GET_TOOL_SCHEMAS") return { data: { toolSchemas: {
        INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: { toolSlug: "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", inputSchema: publishSchema },
      } }, error: null };
      if (slug === "INSTAGRAM_POST_IG_USER_MEDIA") return { successful: true, data: { id: "instagram-container-1" } };
      return { successful: true, data: { id: "instagram-published-1" } };
    },
  };
  const mediaBridgeStorage = {
    saveImageAsset: async (owner: number, input: any, bytes: Uint8Array) => ({ id: `img_owner_${owner}`, r2Key: "images/owner/image.png", name: input.name, contentType: input.contentType, size: bytes.byteLength }) as any,
    getImageAsset: async () => undefined,
    readR2Object: async () => Buffer.from(imageBytes),
    signR2Download: async () => "https://signed.example/private-image",
  };
  const composioClient = {
    tools: { getRawComposioToolBySlug: async (slug: string) => ({ slug, toolkit: { slug: "instagram" } }) },
    files: { upload: async (params: { file: File; toolSlug: string; toolkitSlug: string }) => {
      uploaded.push(params);
      return { name: params.file.name, mimetype: params.file.type, s3key: "staged/instagram-image" };
    } },
  };
  setAgentDependenciesForTests({ composio: { ...composioClient, create: async () => session, sessions: { use: async () => session } }, mediaBridgeStorage });
  try {
    const result = await executeMediaBridgeAction(userId, session, await session.tools(), {
      source: "current", toolSlug: "INSTAGRAM_POST_IG_USER_MEDIA", arguments: { caption: "A launch" },
    }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] });
    assert.equal(result.mode, "composio_file");
    assert.equal(result.providerActionSucceeded, true);
    assert.equal(result.id, "instagram-published-1");
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0]?.file.name, "chusky-image-1.png");
    assert.equal(uploaded[0]?.file.type, "image/png");
    assert.equal(uploaded[0]?.toolSlug, "INSTAGRAM_POST_IG_USER_MEDIA");
    assert.equal(uploaded[0]?.toolkitSlug, "instagram");
    assert.deepEqual(executions, [
      { slug: "INSTAGRAM_POST_IG_USER_MEDIA", args: {
        caption: "A launch", image_file: { name: "chusky-image-1.png", mimetype: "image/png", s3key: "staged/instagram-image" },
      } },
      { slug: "COMPOSIO_GET_TOOL_SCHEMAS", args: { tool_slugs: ["INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH"] } },
      { slug: "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", args: { creation_id: "instagram-container-1" } },
    ]);
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("X image publishing stages media through the exact upload action before creating a post", async () => {
  const userId = 839105;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const postSchema = { type: "object", required: ["text", "media_media_ids"], properties: {
    text: { type: "string" }, media_media_ids: { type: "array", items: { type: "string" } },
  }, additionalProperties: false };
  const uploadSchema = { type: "object", required: ["media", "media_type", "media_category"], properties: {
    media: { type: "string", file_uploadable: true },
    media_type: { type: "string" },
    media_category: { type: "string", enum: ["tweet_image"] },
  }, additionalProperties: false };
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const session = {
    sessionId: "media-bridge-twitter-session",
    tools: async () => [{ type: "function", function: { name: "COMPOSIO_GET_TOOL_SCHEMAS", parameters: { type: "object" } } }],
    execute: async (slug: string, args: Record<string, unknown>) => {
      calls.push({ slug, args });
      if (slug === "COMPOSIO_GET_TOOL_SCHEMAS") {
        const requested = (args.tool_slugs as string[])[0];
        return { data: { toolSchemas: { [requested!]: { toolSlug: requested, inputSchema: requested === "TWITTER_UPLOAD_MEDIA" ? uploadSchema : postSchema } } }, error: null };
      }
      if (slug === "TWITTER_UPLOAD_MEDIA") return { successful: true, data: { media_id_string: "x-media-123" } };
      return { successful: true, data: { id: "x-post-456" } };
    },
  };
  const mediaBridgeStorage = {
    saveImageAsset: async (owner: number, input: any, bytes: Uint8Array) => ({ id: `img_owner_${owner}`, r2Key: "images/owner/image.png", name: input.name, contentType: input.contentType, size: bytes.byteLength }) as any,
    getImageAsset: async () => undefined,
    readR2Object: async () => Buffer.from(imageBytes),
    signR2Download: async () => "https://signed.example/private-image",
  };
  const composioClient = {
    tools: { getRawComposioToolBySlug: async (slug: string) => ({ slug, toolkit: { slug: "twitter" } }) },
    files: { upload: async (params: { file: File; toolSlug: string; toolkitSlug: string }) => {
    assert.equal(params.toolSlug, "TWITTER_UPLOAD_MEDIA");
    assert.equal(params.toolkitSlug, "twitter");
    return { name: params.file.name, mimetype: params.file.type, s3key: "staged/x-image" };
  } } };
  setAgentDependenciesForTests({ composio: { ...composioClient, create: async () => session, sessions: { use: async () => session } }, mediaBridgeStorage });
  try {
    const result = await executeMediaBridgeAction(userId, session, await session.tools(), {
      source: "current", toolSlug: "TWITTER_CREATION_OF_A_POST", arguments: { text: "A launch" },
    }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] });
    assert.equal(result.providerActionSucceeded, true);
    assert.equal(result.id, "x-post-456");
    assert.deepEqual(calls.map(({ slug }) => slug), [
      "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_GET_TOOL_SCHEMAS", "TWITTER_UPLOAD_MEDIA", "TWITTER_CREATION_OF_A_POST",
    ]);
    assert.deepEqual(calls[2]?.args, {
      media: { name: "chusky-image-1.png", mimetype: "image/png", s3key: "staged/x-image" },
      media_type: "image/png",
      media_category: "tweet_image",
    });
    assert.deepEqual(calls[3]?.args, { text: "A launch", media_media_ids: ["x-media-123"] });
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("LinkedIn image publishing initializes, uploads, and posts the exact returned image URN", async () => {
  const userId = 839103;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const postSchema = { type: "object", required: ["author", "commentary", "images"], properties: {
    author: { type: "string" }, commentary: { type: "string" }, images: { type: "array", items: { type: "string" } },
  }, additionalProperties: false };
  const initSchema = { type: "object", required: ["owner"], properties: { owner: { type: "string" } }, additionalProperties: false };
  const actions: Array<{ slug: string; args: Record<string, unknown> }> = [];
  let uploaded: { url: string; method: string; contentType: string; bytes: Buffer } | undefined;
  const session = {
    sessionId: "media-bridge-linkedin-session",
    tools: async () => [{ type: "function", function: { name: "COMPOSIO_GET_TOOL_SCHEMAS", parameters: { type: "object" } } }],
    search: async () => ({ toolSchemas: { LINKEDIN_INITIALIZE_IMAGE_UPLOAD: { toolSlug: "LINKEDIN_INITIALIZE_IMAGE_UPLOAD", inputSchema: initSchema } } }),
    execute: async (slug: string, args: Record<string, unknown>) => {
      actions.push({ slug, args });
      if (slug === "COMPOSIO_GET_TOOL_SCHEMAS") return { data: { toolSchemas: { LINKEDIN_CREATE_LINKED_IN_POST: { toolSlug: slug === "COMPOSIO_GET_TOOL_SCHEMAS" ? "LINKEDIN_CREATE_LINKED_IN_POST" : slug, inputSchema: postSchema } } }, error: null };
      if (slug === "LINKEDIN_INITIALIZE_IMAGE_UPLOAD") return { successful: true, data: { uploadUrl: "https://www.linkedin.com/dms-uploads/upload-token", image: "urn:li:image:abc123" } };
      return { successful: true, data: { id: "urn:li:share:confirmed" } };
    },
  };
  const mediaBridgeStorage = {
    saveImageAsset: async (owner: number, input: any, bytes: Uint8Array) => ({ id: `img_owner_${owner}`, r2Key: "images/owner/image.png", name: input.name, contentType: input.contentType, size: bytes.byteLength }) as any,
    getImageAsset: async () => undefined,
    readR2Object: async () => Buffer.from(imageBytes),
    signR2Download: async () => "https://signed.example/private-image",
  };
  setAgentDependenciesForTests({
    composio: { create: async () => session, sessions: { use: async () => session } },
    mediaBridgeStorage,
    mediaBridgeFetch: async (url: string | URL | Request, init?: RequestInit) => {
      uploaded = { url: String(url), method: String(init?.method), contentType: new Headers(init?.headers).get("content-type") ?? "", bytes: Buffer.from(init?.body as Uint8Array) };
      return new Response(null, { status: 201 });
    },
  } as any);
  try {
    const result = await executeMediaBridgeAction(userId, session, await session.tools(), {
      source: "current", toolSlug: "LINKEDIN_CREATE_LINKED_IN_POST",
      arguments: { author: "urn:li:person:owner", commentary: "Hello from Chusky" },
    }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] });
    assert.equal(result.providerActionSucceeded, true);
    assert.equal(uploaded?.url, "https://www.linkedin.com/dms-uploads/upload-token");
    assert.equal(uploaded?.method, "PUT");
    assert.equal(uploaded?.contentType, "image/png");
    assert.deepEqual(uploaded?.bytes, imageBytes);
    assert.deepEqual(actions.map(({ slug }) => slug), ["COMPOSIO_GET_TOOL_SCHEMAS", "LINKEDIN_INITIALIZE_IMAGE_UPLOAD", "LINKEDIN_CREATE_LINKED_IN_POST"]);
    assert.deepEqual(actions[1]?.args, { owner: "urn:li:person:owner" });
    assert.deepEqual(actions[2]?.args, { author: "urn:li:person:owner", commentary: "Hello from Chusky", images: ["urn:li:image:abc123"] });
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});
