import test from "node:test";
import assert from "node:assert/strict";
import { assertComposioImageUploadField, buildComposioFileUploadArguments, buildMediaBridgeArguments, composioFileUploadValidationSchema, findPendingImageRetryRequest, findPendingSavedImagePostRetry, hasComposioFileUploadField, hasMediaUrlField, mediaActionPreflightSchema, selectRequestedImage, selectRetrievedImageForAction } from "../src/mediaBridge.js";
import { validateToolArgumentsAgainstSchema } from "../src/agentTools.js";
import { dispatchComposioActionWithImageContext, executeMediaBridgeAction, setAgentDependenciesForTests } from "../src/agent.js";

const file = { name: "brand.png", contentType: "image/png", data: Buffer.from("png-bytes") } as const;

test("ordinary image-action wording selects an available image but leaves unrelated messages alone", () => {
  assert.deepEqual(selectRequestedImage("Post this photo to LinkedIn", { currentCount: 1, generatedCount: 0 }), { source: "current", sourceIndex: 0 });
  assert.deepEqual(selectRequestedImage("Post to LinkedIn: Launching our new range", { currentCount: 1, generatedCount: 0 }), { source: "current", sourceIndex: 0 });
  assert.deepEqual(selectRequestedImage("Generate a banner image and email it to the team", { currentCount: 0, generatedCount: 1 }), { source: "generated", sourceIndex: 0 });
  assert.equal(selectRequestedImage("Email me the meeting notes", { currentCount: 1, generatedCount: 0 }), undefined);
  assert.equal(selectRequestedImage("send it", { currentCount: 0, generatedCount: 0 }), undefined);
  assert.equal(selectRequestedImage("send it", { currentCount: 0, generatedCount: 0, savedAssets: [] }), undefined);
  assert.deepEqual(selectRequestedImage("send it", { currentCount: 1, generatedCount: 0 }), { source: "current", sourceIndex: 0 });
  assert.deepEqual(selectRequestedImage("Don't forget to attach this photo to the email", { currentCount: 1, generatedCount: 0 }), { source: "current", sourceIndex: 0 });
  assert.match((selectRequestedImage("send this photo", { currentCount: 0, generatedCount: 0 }) as any)?.reason ?? "", /not available in this run/);
  assert.equal(selectRequestedImage("Post this image without attaching it", { currentCount: 1, generatedCount: 0 }), undefined);
  assert.deepEqual(selectRequestedImage("Post it", { currentCount: 1, generatedCount: 1 }), { ambiguous: true, reason: "Both a sent image and a generated image are available. Ask which one to use before posting or sending." });
  assert.deepEqual(selectRequestedImage("Post my latest image", { currentCount: 0, generatedCount: 0, savedAssets: [
    { id: "older", name: "older.png", createdAt: 10 }, { id: "newer", name: "newer.png", createdAt: 20 },
  ] }), { source: "asset", assetId: "newer" });
  assert.deepEqual(selectRequestedImage("Post the generated image from last week", { currentCount: 1, generatedCount: 0, savedAssets: [
    { id: "sent", name: "sent.png", createdAt: 30 }, { id: "generated", name: "generated.png", tags: ["generated"], createdAt: 20 },
  ] }), { source: "asset", assetId: "generated" });
});

test("a single image retrieved in this run resolves a referential post request", () => {
  assert.deepEqual(selectRetrievedImageForAction("Post it now", ["img_selected"]), { source: "asset", assetId: "img_selected" });
  assert.deepEqual(selectRetrievedImageForAction("Share that image", ["img_selected"]), { source: "asset", assetId: "img_selected" });
  assert.deepEqual(selectRetrievedImageForAction("Post it now", ["img_selected", "img_other"]), {
    ambiguous: true,
    reason: "More than one saved image was retrieved for this action. Ask which one to use before posting or sending.",
  });
  assert.equal(selectRetrievedImageForAction("What does it show?", ["img_selected"]), undefined);
  assert.equal(selectRetrievedImageForAction("Post it without the image", ["img_selected"]), undefined);
});

test("caption-only Instagram image actions cannot fall through when image selection is missing", async () => {
  let providerCalls = 0;
  const input = {
    userId: 839099,
    sessionObj: { execute: async () => { providerCalls++; return { successful: true }; } },
    availableTools: [],
    invokedSlug: "COMPOSIO_MULTI_EXECUTE_TOOL",
    invokedArguments: { tools: [{
      tool_slug: "INSTAGRAM_POST_IG_USER_MEDIA",
      arguments: { ig_user_id: "owner", caption: "Grateful for today." },
    }] },
    selection: undefined,
    runtime: {},
  };
  await assert.rejects(() => dispatchComposioActionWithImageContext(input), /requires an image or video.*no provider action was attempted/i);
  assert.equal(providerCalls, 0);
});

test("an image reattached after a failed requested post resumes only that pending image action", () => {
  const originalRequest = "Publish my gratitude caption to LinkedIn with the generated image.";
  const assistantRetry = "I couldn't post it because the image wasn't available. Please reattach the image here and I can try again with it.";
  const attachedPrompt = "Inspect the attached image and respond helpfully to the user.";
  assert.equal(findPendingImageRetryRequest([
    { role: "user", content: originalRequest },
    { role: "assistant", content: assistantRetry },
  ], attachedPrompt, 1), originalRequest);
  assert.equal(findPendingImageRetryRequest([
    { role: "user", content: originalRequest },
    { role: "assistant", content: "I couldn't post it because the image is unavailable. Please attach the image so I can continue the LinkedIn post." },
  ], attachedPrompt, 1), originalRequest, "a clear missing-image continuation does not depend on the exact phrase 'try again'");
  assert.equal(findPendingImageRetryRequest([
    { role: "user", content: originalRequest },
    { role: "assistant", content: "I couldn’t post it: LinkedIn’s image-upload flow didn’t recognize the saved image, and no LinkedIn action was attempted. Nothing new was published. Please attach the image here once more, and I’ll use it with a fresh gratitude caption." },
  ], attachedPrompt, 1), originalRequest, "the screenshot's exact 'once more' wording resumes the still-pending post");
  assert.equal(findPendingImageRetryRequest([
    { role: "user", content: originalRequest },
    { role: "assistant", content: "Please attach an image and I can describe it for you." },
  ], attachedPrompt, 1), undefined, "an image request for description is not a posting retry");

  assert.equal(findPendingImageRetryRequest([
    { role: "user", content: originalRequest },
    { role: "assistant", content: assistantRetry },
    { role: "user", content: "[Attachment]\nAttached: image" },
    { role: "assistant", content: assistantRetry },
  ], attachedPrompt, 1), originalRequest, "a repeated attachment failure keeps the original user request as the retry intent");

  assert.equal(findPendingImageRetryRequest([
    { role: "user", content: originalRequest },
    { role: "assistant", content: assistantRetry },
  ], "Don't post it; just describe the image.", 1), undefined, "a cancellation overrides the previous request");
  assert.equal(findPendingImageRetryRequest([
    { role: "user", content: originalRequest },
    { role: "assistant", content: assistantRetry },
  ], "What is the weather today?", 0), undefined, "an unrelated follow-up does not inherit the post request");
  assert.equal(findPendingImageRetryRequest([
    { role: "user", content: originalRequest },
    { role: "assistant", content: "The image was posted successfully." },
  ], attachedPrompt, 1), undefined, "a completed action does not create a retry continuation");
});

test("a retry after a failed image post selects the matching private inbound asset", () => {
  const at = Date.now() - 5 * 60_000;
  const attached = { role: "user" as const, content: "[Image attached] I am sending you the image use different text and post it", createdAt: at };
  const failed = { role: "assistant" as const, content: "Instagram did not receive the image. No post was made.", createdAt: at + 1000 };
  const assets = [
    { id: "older", name: "older.jpg", tags: ["telegram", "uploaded-image"], createdAt: at - 60 * 60_000 },
    { id: "attached", name: "telegram-photo.jpg", tags: ["telegram", "uploaded-image"], createdAt: at + 3000 },
    { id: "generated", name: "generated.png", tags: ["generated"], createdAt: at + 5000 },
  ];
  assert.deepEqual(findPendingSavedImagePostRetry([attached, failed], "Tried to fix, try again", assets), {
    request: attached.content, selection: { source: "asset", assetId: "attached" },
  });
  assert.deepEqual(findPendingSavedImagePostRetry([attached, failed,
    { role: "user", content: "I tried the fix one more time so try again", createdAt: at + 2000 },
    { role: "assistant", content: "The upload failed. No post was created.", createdAt: at + 3000 },
  ], "Try again", assets)?.selection, { source: "asset", assetId: "attached" });
  assert.equal(findPendingSavedImagePostRetry([attached, failed], "What happened?", assets), undefined);
  assert.equal(findPendingSavedImagePostRetry([attached,
    { role: "assistant", content: "The post may already be live. Check Instagram before retrying.", createdAt: at + 1000 },
  ], "Try again", assets), undefined);
  assert.equal(findPendingSavedImagePostRetry([attached, failed,
    { role: "user", content: "Show me the weather", createdAt: at + 2000 },
    failed,
  ], "Try again", assets), undefined);
  assert.deepEqual(findPendingSavedImagePostRetry([attached, failed], "Try again", [assets[1]!,
    { id: "another", name: "another.jpg", tags: ["uploaded-image"], createdAt: at + 2000 },
  ])?.selection, { ambiguous: true, reason: "Several saved images match the earlier post. Ask which image to use before publishing." });
});

test("ordinary Composio email action automatically receives the explicitly requested current image", async () => {
  const userId = 839100;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const emailSchema = { type: "object", required: ["recipient_email", "subject", "body", "attachment"], properties: {
    recipient_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
    attachment: { type: "string", file_uploadable: true },
  }, additionalProperties: false };
  const calls: Array<{ slug: string; args: Record<string, unknown>; account?: string }> = [];
  const uploaded: Array<{ file: File; toolSlug: string; toolkitSlug: string }> = [];
  const session = {
    search: async () => ({ toolSchemas: { GMAIL_SEND_EMAIL: { toolSlug: "GMAIL_SEND_EMAIL", inputSchema: emailSchema } } }),
    execute: async (slug: string, args: Record<string, unknown>, options?: { account?: string }) => {
      calls.push({ slug, args, ...(options?.account ? { account: options.account } : {}) });
      return { successful: true, data: { id: "gmail-message-auto-image", status: "sent" } };
    },
  };
  const composioClient = {
    tools: { getRawComposioToolBySlug: async (slug: string) => ({ slug, toolkit: { slug: "gmail" } }) },
    files: { upload: async (params: { file: File; toolSlug: string; toolkitSlug: string }) => {
      uploaded.push(params);
      return { name: params.file.name, mimetype: params.file.type, s3key: "staged/auto-image" };
    } },
  };
  setAgentDependenciesForTests({
    composio: { ...composioClient, create: async () => session, sessions: { use: async () => session } },
    mediaBridgeStorage: {
      saveImageAsset: async () => { throw new Error("FileUploadable actions should not create an R2 transfer asset"); },
      getImageAsset: async () => undefined,
      readR2Object: async () => Buffer.from(imageBytes),
      signR2Download: async () => "https://unused.example/image",
    } as any,
  });
  try {
    const selection = selectRequestedImage("Email this photo to the team with a short note", { currentCount: 1, generatedCount: 0 });
    const result = await dispatchComposioActionWithImageContext({
      userId,
      sessionObj: session,
      availableTools: [{ type: "function", function: { name: "GMAIL_SEND_EMAIL", parameters: emailSchema } }],
      invokedSlug: "GMAIL_SEND_EMAIL",
      invokedArguments: { recipient_email: "team@example.com", subject: "Launch", body: "For context." },
      selection,
      runtime: { currentImages: [{ data: imageBytes, mediaType: "image/png" }] },
      allowedToolSlugs: new Set(["GMAIL_SEND_EMAIL"]),
    });
    assert.equal((result as any).providerActionSucceeded, true);
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0]?.toolSlug, "GMAIL_SEND_EMAIL");
    assert.equal(uploaded[0]?.toolkitSlug, "gmail");
    assert.deepEqual(calls, [{ slug: "GMAIL_SEND_EMAIL", args: {
      recipient_email: "team@example.com", subject: "Launch", body: "For context.",
      attachment: { name: "chusky-image-1.png", mimetype: "image/png", s3key: "staged/auto-image" },
    } }]);

    const wrapped = await dispatchComposioActionWithImageContext({
      userId,
      sessionObj: session,
      availableTools: [{ type: "function", function: { name: "COMPOSIO_EXECUTE_TOOL", parameters: { type: "object" } } }],
      invokedSlug: "COMPOSIO_EXECUTE_TOOL",
      invokedArguments: { tool_slug: "GMAIL_SEND_EMAIL", account: "work", arguments: {
        recipient_email: "team@example.com", subject: "Launch", body: "Sent through discovered action.",
      } },
      selection,
      runtime: { currentImages: [{ data: imageBytes, mediaType: "image/png" }] },
    });
    assert.equal((wrapped as any).providerActionSucceeded, true);
    assert.deepEqual(calls[1], { slug: "GMAIL_SEND_EMAIL", account: "work", args: {
      recipient_email: "team@example.com", subject: "Launch", body: "Sent through discovered action.",
      attachment: { name: "chusky-image-1.png", mimetype: "image/png", s3key: "staged/auto-image" },
    } });
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("image ambiguity does not block a preparatory read action", async () => {
  const result = await dispatchComposioActionWithImageContext({
    userId: 839111,
    sessionObj: { execute: async () => { throw new Error("a search should use normal dispatch"); } },
    availableTools: [],
    invokedSlug: "GMAIL_SEARCH_EMAILS",
    invokedArguments: { query: "latest messages" },
    selection: { ambiguous: true, reason: "Ask which image to use." },
    runtime: { currentImages: [{ data: Buffer.from("png"), mediaType: "image/png" }, { data: Buffer.from("png"), mediaType: "image/png" }] },
  });
  assert.equal(result, undefined);
});

test("image requests fail closed when Composio groups multiple actions", async () => {
  const selection = selectRequestedImage("Post this image and email it to the team", { currentCount: 1, generatedCount: 0 });
  await assert.rejects(() => dispatchComposioActionWithImageContext({
    userId: 839109,
    sessionObj: { execute: async () => { throw new Error("no batched provider action should run"); } },
    availableTools: [],
    invokedSlug: "COMPOSIO_MULTI_EXECUTE_TOOL",
    invokedArguments: { tools: [
      { tool_slug: "LINKEDIN_CREATE_LINKED_IN_POST", arguments: { commentary: "Launch" } },
      { tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "team@example.com" } },
    ] },
    selection,
    runtime: { currentImages: [{ data: Buffer.from("png"), mediaType: "image/png" }] },
  }), /grouped several actions together.*no batched actions were attempted/i);
});

test("URL-based actions reuse the saved asset for a generated image", async () => {
  const userId = 839110;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const session = {
    tools: async () => [{ type: "function", function: { name: "INSTAGRAM_CREATE_POST", parameters: { type: "object", properties: {
      caption: { type: "string" }, image_url: { type: "string", description: "Public image URL" },
    } } } }],
    execute: async (slug: string, args: Record<string, unknown>) => {
      calls.push({ slug, args });
      return { successful: true, data: { id: "ig-post-asset" } };
    },
  };
  let saves = 0;
  setAgentDependenciesForTests({
    composio: { create: async () => session, sessions: { use: async () => session } },
    mediaBridgeStorage: {
      saveImageAsset: async () => { saves += 1; throw new Error("generated image already has an owner asset"); },
      getImageAsset: async (owner: number, id: string) => owner === userId && id === "img_generated_1"
        ? { id, r2Key: "images/owner/generated.png", name: "generated-launch.png", contentType: "image/png", size: imageBytes.length } as any
        : undefined,
      readR2Object: async () => Buffer.from(imageBytes),
      signR2Download: async (key: string, ttl: number) => {
        assert.equal(key, "images/owner/generated.png");
        assert.equal(ttl, 900);
        return "https://signed.example/generated.png";
      },
    } as any,
  });
  try {
    const result = await dispatchComposioActionWithImageContext({
      userId,
      sessionObj: session,
      availableTools: await session.tools(),
      invokedSlug: "INSTAGRAM_CREATE_POST",
      invokedArguments: { caption: "Launch" },
      selection: { source: "generated", sourceIndex: 0 },
      runtime: { generatedImages: [{ data: imageBytes, mediaType: "image/png", assetId: "img_generated_1" }] },
    }) as Record<string, unknown>;
    assert.equal("assetId" in result, false, "the model-facing receipt must not reveal a private image asset ID");
    assert.equal(saves, 0);
    assert.deepEqual(calls, [{ slug: "INSTAGRAM_CREATE_POST", args: { caption: "Launch", image_url: "https://signed.example/generated.png" } }]);
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

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

test("image upload selects a unique image field when an action also accepts video", () => {
  const schema = { type: "object", required: ["image_url"], properties: {
    image_url: { type: "string", file_uploadable: true },
    video_url: { type: "string", file_uploadable: true },
  } };
  const uploaded = { name: "brand.png", mimetype: "image/png", s3key: "staged/brand" };
  assert.doesNotThrow(() => assertComposioImageUploadField(schema));
  assert.deepEqual(buildComposioFileUploadArguments(schema, {}, uploaded, true), { image_url: uploaded });
  assert.throws(() => buildComposioFileUploadArguments(schema, {}, uploaded), /exactly one schema-declared file upload field/i);
  assert.throws(() => assertComposioImageUploadField({ type: "object", properties: {
    image_file: { type: "string", file_uploadable: true },
    photo_file: { type: "string", file_uploadable: true },
  } }), /unambiguous schema-declared image upload field/i);
  const instagramSchema = { type: "object", properties: {
    image_file: { type: "string", file_uploadable: true },
    alternate_image_file: { type: "string", file_uploadable: true },
  } };
  assert.deepEqual(buildComposioFileUploadArguments(instagramSchema, {}, uploaded, true, "image_file"), { image_file: uploaded });
  assert.throws(() => assertComposioImageUploadField(instagramSchema, "missing_image_file"), /does not expose the required image upload field/i);
  assert.throws(() => assertComposioImageUploadField({ type: "object", properties: {
    video_url: { type: "string", file_uploadable: true },
  } }), /no schema-declared image upload field/i);
  assert.deepEqual(buildComposioFileUploadArguments({ type: "object", properties: {
    media_content: { type: "string", file_uploadable: true, description: "Photo upload" },
    alternate_file: { type: "string", file_uploadable: true, description: "Video upload" },
  } }, {}, uploaded, true), { media_content: uploaded });
});

test("media preflight defers only the required image field while validating normal action arguments", () => {
  const schema = { type: "object", required: ["recipient_email", "subject", "body", "attachment"], properties: {
    recipient_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
    attachment: { type: "string", file_uploadable: true },
  }, additionalProperties: false };
  const relaxed = mediaActionPreflightSchema("GMAIL_SEND_EMAIL", schema);
  assert.deepEqual((relaxed as any).required, ["recipient_email", "subject", "body"]);
  assert.doesNotThrow(() => validateToolArgumentsAgainstSchema("GMAIL_SEND_EMAIL", {
    recipient_email: "team@example.com", subject: "Launch", body: "See attached.",
  }, relaxed));
  assert.throws(() => validateToolArgumentsAgainstSchema("GMAIL_SEND_EMAIL", {
    recipient_email: "team@example.com", body: "See attached.",
  }, relaxed), /subject/);
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

test("Gmail attachment actions receive a staged Composio file reference through the bridge", async () => {
  const userId = 839106;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const emailSchema = { type: "object", required: ["recipient_email", "subject", "body", "attachment"], properties: {
    recipient_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
    attachment: { type: "string", file_uploadable: true },
  }, additionalProperties: false };
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const session = {
    sessionId: "media-bridge-gmail-session",
    tools: async () => [{ type: "function", function: { name: "GMAIL_SEND_EMAIL", parameters: emailSchema } }],
    execute: async (slug: string, args: Record<string, unknown>) => {
      calls.push({ slug, args });
      return { successful: true, data: { id: "gmail-message-1", status: "sent" } };
    },
  };
  const mediaBridgeStorage = {
    saveImageAsset: async (owner: number, input: any, bytes: Uint8Array) => ({ id: `img_owner_${owner}`, r2Key: "images/owner/image.png", name: input.name, contentType: input.contentType, size: bytes.byteLength }) as any,
    getImageAsset: async () => undefined,
    readR2Object: async () => Buffer.from(imageBytes),
    signR2Download: async () => "https://signed.example/private-image",
  };
  const uploaded: Array<{ file: File; toolSlug: string; toolkitSlug: string }> = [];
  const composioClient = {
    tools: { getRawComposioToolBySlug: async (slug: string) => ({ slug, toolkit: { slug: "gmail" } }) },
    files: { upload: async (params: { file: File; toolSlug: string; toolkitSlug: string }) => {
      uploaded.push(params);
      return { name: params.file.name, mimetype: params.file.type, s3key: "staged/gmail-image" };
    } },
  };
  setAgentDependenciesForTests({ composio: { ...composioClient, create: async () => session, sessions: { use: async () => session } }, mediaBridgeStorage });
  try {
    const result = await executeMediaBridgeAction(userId, session, await session.tools(), {
      source: "current", toolSlug: "GMAIL_SEND_EMAIL", arguments: {
        recipient_email: "team@example.com", subject: "Launch", body: "See attached image.",
      },
    }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] });
    assert.equal(result.providerActionSucceeded, true);
    assert.equal(result.mode, "composio_file");
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0]?.toolkitSlug, "gmail");
    assert.deepEqual(calls, [{ slug: "GMAIL_SEND_EMAIL", args: {
      recipient_email: "team@example.com", subject: "Launch", body: "See attached image.",
      attachment: { name: "chusky-image-1.png", mimetype: "image/png", s3key: "staged/gmail-image" },
    } }]);
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
    search: async () => ({ toolSchemas: { INSTAGRAM_CREATE_POST: { toolSlug: "INSTAGRAM_CREATE_POST", schemaRef: { tool: "COMPOSIO_GET_TOOL_SCHEMAS", args: { toolSlugs: ["INSTAGRAM_CREATE_POST"] } } } } }),
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
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { slug: "COMPOSIO_GET_TOOL_SCHEMAS", args: { tool_slugs: ["INSTAGRAM_CREATE_POST"] } });
    assert.equal(calls[1]?.slug, "INSTAGRAM_CREATE_POST");
    assert.deepEqual(calls[1]?.args.image_url, "https://signed.example/private-image");
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("Instagram uses the current owner schema to stage image_file, publish, and verify the image", async () => {
  const userId = 839104;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const actionSchema = { type: "object", required: ["ig_user_id"], properties: {
    ig_user_id: { type: "string" }, caption: { type: "string" },
    image_url: { type: "string", pattern: "^https?://" },
    video_url: { type: "string", pattern: "^https?://" },
    image_file: { type: "object", required: ["name", "mimetype", "s3key"], file_uploadable: true, properties: {
      name: { type: "string" }, mimetype: { type: "string" }, s3key: { type: "string" },
    } },
    video_file: { type: "object", required: ["name", "mimetype", "s3key"], file_uploadable: true, properties: {
      name: { type: "string" }, mimetype: { type: "string" }, s3key: { type: "string" },
    } },
  }, additionalProperties: false };
  const staleActionSchema = { type: "object", required: ["ig_user_id"], properties: {
    ig_user_id: { type: "string" }, caption: { type: "string" },
    first_file: { type: "object", file_uploadable: true }, second_file: { type: "object", file_uploadable: true },
  }, additionalProperties: false };
  const publishSchema = { type: "object", required: ["creation_id"], properties: { creation_id: { type: "string" } }, additionalProperties: false };
  const verifySchema = { type: "object", required: ["ig_media_id"], properties: {
    ig_media_id: { type: "string" }, fields: { type: "string" },
  }, additionalProperties: true };
  const uploaded: Array<{ file: File; toolSlug: string; toolkitSlug: string }> = [];
  const executions: Array<{ slug: string; args: Record<string, unknown> }> = [];
  let publishedMediaType = "IMAGE";
  const session = {
    sessionId: "media-bridge-staged-session",
    tools: async () => [
      { type: "function", function: { name: "INSTAGRAM_POST_IG_USER_MEDIA", parameters: staleActionSchema } },
      { type: "function", function: { name: "COMPOSIO_GET_TOOL_SCHEMAS", parameters: { type: "object" } } },
    ],
    search: async ({ query }: { query: string }) => {
      const slug = query.match(/INSTAGRAM_[A-Z_]+/)?.[0];
      const inputSchema = slug === "INSTAGRAM_POST_IG_USER_MEDIA" ? actionSchema
        : slug === "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH" ? publishSchema
          : verifySchema;
      return { toolSchemas: { [slug!]: { toolSlug: slug, inputSchema } } };
    },
    execute: async (slug: string, args: Record<string, unknown>) => {
      executions.push({ slug, args });
      if (slug === "COMPOSIO_GET_TOOL_SCHEMAS") return { data: { toolSchemas: {
        INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: { toolSlug: "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", inputSchema: publishSchema },
      } }, error: null };
      if (slug === "INSTAGRAM_POST_IG_USER_MEDIA") return { successful: true, data: { id: "instagram-container-1" } };
      if (slug === "INSTAGRAM_GET_IG_MEDIA") return { successful: true, data: { id: "instagram-published-1", media_type: publishedMediaType, media_url: "https://instagram.example/image.jpg" } };
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
    const availableTools = await session.tools();
    assert.throws(() => assertComposioImageUploadField(staleActionSchema), /unambiguous schema-declared image upload field/i);
    const result = await dispatchComposioActionWithImageContext({
      userId,
      sessionObj: session,
      availableTools,
      invokedSlug: "COMPOSIO_MULTI_EXECUTE_TOOL",
      invokedArguments: { tools: [{
        tool_slug: "INSTAGRAM_POST_IG_USER_MEDIA",
        arguments: { ig_user_id: "instagram-owner", caption: "A launch" },
      }] },
      selection: { source: "current", sourceIndex: 0 },
      runtime: { currentImages: [{ data: imageBytes, mediaType: "image/png" }] },
    });
    assert.ok(result && typeof result === "object");
    const receipt = result as Record<string, unknown>;
    assert.equal(receipt.mode, "composio_file");
    assert.equal(receipt.providerActionSucceeded, true);
    assert.equal(receipt.id, "instagram-published-1");
    assert.equal(receipt.providerMediaVerified, true);
    assert.equal(receipt.verifiedMediaType, "IMAGE");
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0]?.file.name, "chusky-image-1.png");
    assert.equal(uploaded[0]?.file.type, "image/png");
    assert.equal(uploaded[0]?.toolSlug, "INSTAGRAM_POST_IG_USER_MEDIA");
    assert.equal(uploaded[0]?.toolkitSlug, "instagram");
    assert.deepEqual(executions, [
      { slug: "INSTAGRAM_POST_IG_USER_MEDIA", args: {
        ig_user_id: "instagram-owner", caption: "A launch", image_file: { name: "chusky-image-1.png", mimetype: "image/png", s3key: "staged/instagram-image" },
      } },
      { slug: "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", args: { creation_id: "instagram-container-1" } },
      { slug: "INSTAGRAM_GET_IG_MEDIA", args: { ig_media_id: "instagram-published-1", fields: "id,media_type,media_url" } },
    ]);

    publishedMediaType = "VIDEO";
    await assert.rejects(() => executeMediaBridgeAction(userId, session, availableTools, {
      source: "current", toolSlug: "INSTAGRAM_POST_IG_USER_MEDIA", arguments: { ig_user_id: "instagram-owner", caption: "A launch" },
    }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] }), /may already be live; check Instagram before retrying/i);
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("Instagram rejects ambiguous upload fields before staging or calling the provider", async () => {
  const userId = 839114;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const actionSchema = { type: "object", properties: {
    caption: { type: "string" }, first_upload: { type: "string", file_uploadable: true }, second_upload: { type: "string", file_uploadable: true },
  } };
  let stagedUploads = 0;
  let providerCalls = 0;
  const session = {
    sessionId: "media-bridge-ambiguous-instagram-session",
    tools: async () => [{ type: "function", function: { name: "INSTAGRAM_POST_IG_USER_MEDIA", parameters: actionSchema } }],
    execute: async () => { providerCalls += 1; return { successful: true, data: {} }; },
  };
  const composioClient = {
    tools: { getRawComposioToolBySlug: async (slug: string) => ({ slug, toolkit: { slug: "instagram" } }) },
    files: { upload: async () => { stagedUploads += 1; return { name: "image.png", mimetype: "image/png", s3key: "staged/image" }; } },
  };
  setAgentDependenciesForTests({ composio: { ...composioClient, create: async () => session, sessions: { use: async () => session } } });
  try {
    const availableTools = await session.tools();
    await assert.rejects(() => executeMediaBridgeAction(userId, session, availableTools, {
      source: "current", toolSlug: "INSTAGRAM_POST_IG_USER_MEDIA", arguments: { caption: "A launch" },
    }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] }), /does not expose the required image upload field/i);
    assert.equal(stagedUploads, 0);
    assert.equal(providerCalls, 0);
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
    search: async ({ query }: { query: string }) => {
      const slug = query.match(/TWITTER_[A-Z_]+/)?.[0];
      const inputSchema = slug === "TWITTER_UPLOAD_MEDIA" ? uploadSchema : postSchema;
      return { toolSchemas: { [slug!]: { toolSlug: slug, inputSchema } } };
    },
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
      "TWITTER_UPLOAD_MEDIA", "TWITTER_CREATION_OF_A_POST",
    ]);
    assert.deepEqual(calls[0]?.args, {
      media: { name: "chusky-image-1.png", mimetype: "image/png", s3key: "staged/x-image" },
      media_type: "image/png",
      media_category: "tweet_image",
    });
    assert.deepEqual(calls[1]?.args, { text: "A launch", media_media_ids: ["x-media-123"] });
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("Facebook Page photo publishing discovers the exact upload action before creating the post", async () => {
  const userId = 839107;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const postSchema = { type: "object", required: ["page_id", "message", "photo_id"], properties: {
    page_id: { type: "string" }, message: { type: "string" }, photo_id: { type: "string" },
  }, additionalProperties: false };
  const uploadSchema = { type: "object", required: ["page_id", "photo"], properties: {
    page_id: { type: "string" }, photo: { type: "string", file_uploadable: true },
  }, additionalProperties: false };
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const session = {
    sessionId: "media-bridge-facebook-session",
    tools: async () => [
      { type: "function", function: { name: "FACEBOOK_CREATE_PHOTO_POST", parameters: postSchema } },
      { type: "function", function: { name: "COMPOSIO_GET_TOOL_SCHEMAS", parameters: { type: "object" } } },
    ],
    search: async ({ query }: { query: string }) => {
      assert.match(query, /FACEBOOK_UPLOAD_PHOTO/);
      return { toolSchemas: { FACEBOOK_UPLOAD_PHOTO: { toolSlug: "FACEBOOK_UPLOAD_PHOTO", inputSchema: uploadSchema } } };
    },
    execute: async (slug: string, args: Record<string, unknown>) => {
      calls.push({ slug, args });
      if (slug === "FACEBOOK_UPLOAD_PHOTO") return { successful: true, data: { id: "facebook-photo-1" } };
      return { successful: true, data: { id: "facebook-post-1" } };
    },
  };
  const mediaBridgeStorage = {
    saveImageAsset: async (owner: number, input: any, bytes: Uint8Array) => ({ id: `img_owner_${owner}`, r2Key: "images/owner/image.png", name: input.name, contentType: input.contentType, size: bytes.byteLength }) as any,
    getImageAsset: async () => undefined,
    readR2Object: async () => Buffer.from(imageBytes),
    signR2Download: async () => "https://signed.example/private-image",
  };
  const uploaded: Array<{ file: File; toolSlug: string; toolkitSlug: string }> = [];
  const composioClient = {
    tools: { getRawComposioToolBySlug: async (slug: string) => ({ slug, toolkit: { slug: "facebook" } }) },
    files: { upload: async (params: { file: File; toolSlug: string; toolkitSlug: string }) => {
      uploaded.push(params);
      return { name: params.file.name, mimetype: params.file.type, s3key: "staged/facebook-image" };
    } },
  };
  setAgentDependenciesForTests({ composio: { ...composioClient, create: async () => session, sessions: { use: async () => session } }, mediaBridgeStorage });
  try {
    const result = await executeMediaBridgeAction(userId, session, await session.tools(), {
      source: "current", toolSlug: "FACEBOOK_CREATE_PHOTO_POST", arguments: { page_id: "page-1", message: "Launch" },
    }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] });
    assert.equal(result.providerActionSucceeded, true);
    assert.equal(result.mode, "facebook_upload");
    assert.equal(result.id, "facebook-post-1");
    assert.equal(uploaded[0]?.toolkitSlug, "facebook");
    assert.deepEqual(calls, [
      { slug: "FACEBOOK_UPLOAD_PHOTO", args: { page_id: "page-1", photo: { name: "chusky-image-1.png", mimetype: "image/png", s3key: "staged/facebook-image" } } },
      { slug: "FACEBOOK_CREATE_PHOTO_POST", args: { page_id: "page-1", message: "Launch", photo_id: "facebook-photo-1" } },
    ]);
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
  const initSchema = { type: "object", required: ["owner_urn"], properties: { owner_urn: { type: "string" } }, additionalProperties: false };
  const actions: Array<{ slug: string; args: Record<string, unknown> }> = [];
  let uploaded: { url: string; method: string; contentType: string; bytes: Buffer } | undefined;
  const session = {
    sessionId: "media-bridge-linkedin-session",
    tools: async () => [{ type: "function", function: { name: "COMPOSIO_GET_TOOL_SCHEMAS", parameters: { type: "object" } } }],
    search: async ({ query }: { query: string }) => {
      const slug = query.match(/LINKEDIN_[A-Z_]+/)?.[0] ?? (query.includes("Register or initialize an image upload") ? "LINKEDIN_REGISTER_IMAGE_UPLOAD" : undefined);
      const inputSchema = slug === "LINKEDIN_REGISTER_IMAGE_UPLOAD" ? initSchema : postSchema;
      return { toolSchemas: { [slug!]: { toolSlug: slug, inputSchema } } };
    },
    execute: async (slug: string, args: Record<string, unknown>) => {
      actions.push({ slug, args });
      if (slug === "COMPOSIO_GET_TOOL_SCHEMAS") return { data: { toolSchemas: { LINKEDIN_CREATE_LINKED_IN_POST: { toolSlug: slug === "COMPOSIO_GET_TOOL_SCHEMAS" ? "LINKEDIN_CREATE_LINKED_IN_POST" : slug, inputSchema: postSchema } } }, error: null };
      if (slug === "LINKEDIN_REGISTER_IMAGE_UPLOAD") return { successful: true, data: { upload_url: "https://www.linkedin.com/dms-uploads/upload-token", asset_urn: "urn:li:image:abc123" } };
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
    assert.deepEqual(actions.map(({ slug }) => slug), ["LINKEDIN_REGISTER_IMAGE_UPLOAD", "LINKEDIN_CREATE_LINKED_IN_POST"]);
    assert.deepEqual(actions[0]?.args, { owner_urn: "urn:li:person:owner" });
    assert.deepEqual(actions[1]?.args, { author: "urn:li:person:owner", commentary: "Hello from Chusky", images: ["urn:li:image:abc123"] });
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("LinkedIn image publishing upgrades a legacy ToolRouter schema to Composio's current owner-scoped definition", async () => {
  const userId = 839108;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const legacyPostSchema = { type: "object", required: ["author", "commentary"], properties: {
    author: { type: "string" }, commentary: { type: "string" },
  }, additionalProperties: false };
  const currentPostSchema = { type: "object", required: ["author", "commentary", "images"], properties: {
    author: { type: "string" }, commentary: { type: "string" }, images: { type: "array", items: { type: "string" } },
  }, additionalProperties: false };
  const initSchema = { type: "object", required: ["owner"], properties: { owner: { type: "string" } }, additionalProperties: false };
  const directCalls: Array<{ slug: string; body: Record<string, unknown> }> = [];
  const rawLookups: Array<{ slug: string; options: Record<string, unknown> }> = [];
  let uploaded: Buffer | undefined;
  const session = {
    sessionId: "media-bridge-linkedin-legacy-session",
    tools: async () => [{ type: "function", function: { name: "LINKEDIN_CREATE_LINKED_IN_POST", parameters: legacyPostSchema } }],
    execute: async () => { throw new Error("legacy ToolRouter action must not execute"); },
  };
  const composioClient = {
    connectedAccounts: {
      list: async () => [{ id: "ca_linkedin_owner", alias: "brand", status: "ACTIVE", toolkit: { slug: "linkedin" } }],
    },
    tools: {
      getRawComposioToolBySlug: async (slug: string, options: Record<string, unknown>) => {
        rawLookups.push({ slug, options });
        return { slug, version: "20260915_00", toolkit: { slug: "linkedin" }, inputParameters: slug === "LINKEDIN_INITIALIZE_IMAGE_UPLOAD" ? initSchema : currentPostSchema };
      },
      execute: async (slug: string, body: Record<string, unknown>) => {
        directCalls.push({ slug, body });
        if (slug === "LINKEDIN_INITIALIZE_IMAGE_UPLOAD") return { successful: true, data: { upload_url: "https://www.linkedin.com/dms-uploads/upload-token", image: "urn:li:image:current-123" } };
        return { successful: true, data: { id: "urn:li:share:current" } };
      },
    },
  };
  const mediaBridgeStorage = {
    saveImageAsset: async (owner: number, input: any, bytes: Uint8Array) => ({ id: `img_owner_${owner}`, r2Key: "images/owner/image.png", name: input.name, contentType: input.contentType, size: bytes.byteLength }) as any,
    getImageAsset: async () => undefined,
    readR2Object: async () => Buffer.from(imageBytes),
    signR2Download: async () => "https://signed.example/private-image",
  };
  setAgentDependenciesForTests({
    composio: { ...composioClient, create: async () => session, sessions: { use: async () => session } },
    mediaBridgeStorage,
    mediaBridgeFetch: async (_url: string | URL | Request, init?: RequestInit) => {
      uploaded = Buffer.from(init?.body as Uint8Array);
      return new Response(null, { status: 201 });
    },
  } as any);
  try {
    const result = await executeMediaBridgeAction(userId, session, await session.tools(), {
      source: "current", toolSlug: "LINKEDIN_CREATE_LINKED_IN_POST", account: "brand",
      arguments: { author: "urn:li:person:owner", commentary: "Current schema launch" },
    }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] });
    assert.equal(result.providerActionSucceeded, true);
    assert.equal(result.mode, "linkedin_upload");
    assert.deepEqual(uploaded, imageBytes);
    assert.deepEqual(rawLookups, [
      { slug: "LINKEDIN_CREATE_LINKED_IN_POST", options: { version: "latest" } },
      { slug: "LINKEDIN_REGISTER_IMAGE_UPLOAD", options: { version: "latest" } },
      { slug: "LINKEDIN_INITIALIZE_IMAGE_UPLOAD", options: { version: "latest" } },
    ]);
    assert.deepEqual(directCalls, [
      { slug: "LINKEDIN_INITIALIZE_IMAGE_UPLOAD", body: { userId: "user_839108", connectedAccountId: "ca_linkedin_owner", version: "20260915_00", arguments: { owner: "urn:li:person:owner" } } },
      { slug: "LINKEDIN_CREATE_LINKED_IN_POST", body: { userId: "user_839108", connectedAccountId: "ca_linkedin_owner", version: "20260915_00", arguments: { author: "urn:li:person:owner", commentary: "Current schema launch", images: ["urn:li:image:current-123"] } } },
    ]);
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("LinkedIn image publishing uses the current catalog schema when a direct lookup is still legacy", async () => {
  const userId = 839110;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const legacyPostSchema = { type: "object", properties: { author: { type: "string" }, commentary: { type: "string" } } };
  const currentPostSchema = { type: "object", properties: { author: { type: "string" }, commentary: { type: "string" }, images: { type: "array", items: { type: "string" } } } };
  const initSchema = { type: "object", properties: { owner: { type: "string" } } };
  const directCalls: Array<{ slug: string; body: Record<string, unknown> }> = [];
  const session = {
    sessionId: "media-bridge-linkedin-catalog-session",
    tools: async () => [{ type: "function", function: { name: "LINKEDIN_CREATE_LINKED_IN_POST", parameters: legacyPostSchema } }],
    execute: async () => { throw new Error("legacy ToolRouter action must not execute"); },
  };
  const composioClient = {
    connectedAccounts: { list: async () => [{ id: "ca_linkedin_owner", alias: "Brand Account", status: "ACTIVE", toolkit: { slug: "linkedin" } }] },
    tools: {
      getRawComposioToolBySlug: async (slug: string) => ({ slug, version: "20260915_00", toolkit: { slug: "linkedin" }, inputParameters: slug === "LINKEDIN_INITIALIZE_IMAGE_UPLOAD" ? initSchema : legacyPostSchema }),
      getRawComposioTools: async () => [{ slug: "LINKEDIN_CREATE_LINKED_IN_POST", version: "20260915_00", toolkit: { slug: "linkedin" }, inputParameters: currentPostSchema }],
      execute: async (slug: string, body: Record<string, unknown>) => {
        directCalls.push({ slug, body });
        return slug === "LINKEDIN_INITIALIZE_IMAGE_UPLOAD"
          ? { successful: true, data: { upload_url: "https://www.linkedin.com/dms-uploads/upload-token", image: "urn:li:image:catalog-123" } }
          : { successful: true, data: { id: "urn:li:share:catalog" } };
      },
    },
  };
  setAgentDependenciesForTests({
    composio: { ...composioClient, create: async () => session, sessions: { use: async () => session } },
    mediaBridgeStorage: { saveImageAsset: async () => ({ id: "img", r2Key: "image", name: "image.png", contentType: "image/png", size: imageBytes.byteLength }), getImageAsset: async () => undefined, readR2Object: async () => imageBytes, signR2Download: async () => "https://signed.example/image" },
    mediaBridgeFetch: async () => new Response(null, { status: 201 }),
  } as any);
  try {
    const result = await executeMediaBridgeAction(userId, session, await session.tools(), {
      source: "current", toolSlug: "LINKEDIN_CREATE_LINKED_IN_POST", account: "linkedin",
      arguments: { author: "urn:li:person:owner", commentary: "Catalog fallback launch" },
    }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] });
    assert.equal(result.providerActionSucceeded, true);
    assert.deepEqual(directCalls.map((call) => call.body.connectedAccountId), ["ca_linkedin_owner", "ca_linkedin_owner"]);
    assert.deepEqual(directCalls[1]?.body.arguments, { author: "urn:li:person:owner", commentary: "Catalog fallback launch", images: ["urn:li:image:catalog-123"] });
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("LinkedIn actions without an image field direct the agent to the supported image-post action", async () => {
  const userId = 839109;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const schema = { type: "object", required: ["author", "commentary"], properties: {
    author: { type: "string" }, commentary: { type: "string" },
  }, additionalProperties: false };
  const session = {
    sessionId: "media-bridge-linkedin-text-session",
    tools: async () => [{ type: "function", function: { name: "LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE", parameters: schema } }],
    execute: async () => { throw new Error("an image-incompatible action must not execute"); },
  };
  setAgentDependenciesForTests({ composio: { create: async () => session, sessions: { use: async () => session } } } as any);
  try {
    const availableTools = await session.tools();
    await assert.rejects(
      () => executeMediaBridgeAction(userId, session, availableTools, {
        source: "current", toolSlug: "LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE",
        arguments: { author: "urn:li:person:owner", commentary: "Hello" },
      }, { currentImages: [{ data: imageBytes, mediaType: "image/png" }] }),
      /LINKEDIN_CREATE_LINKED_IN_POST.*No provider action was attempted/i,
    );
  } finally {
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "media-test-reset", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});
