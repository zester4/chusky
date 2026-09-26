import test from "node:test";
import assert from "node:assert/strict";
import { addRecallMeeting, getSession, initStore, listAgentRuns, saveSession, updateMeetingRepresentativeProfile } from "../src/store.js";
import { appendPreviewLinks, cleanModelText, invalidateSession, listConnectedAccounts, openRouterAttemptTimeoutMs, orChat, parseLegacyDsmlToolCalls, parseToolArguments, readStreamingChat, runAgent, ApprovalRequiredError, setAgentDependenciesForTests, triggerAutonomyInstructions } from "../src/agent.js";
import { config } from "../src/config.js";
import { nativeTool } from "../src/nativeTools.js";
import { daytonaEngine } from "../src/lib/daytona/index.js";
import { AUTONOMY_OPERATING_KERNEL, needsAutonomyCloseoutNudge } from "../src/autonomy/operatingLoop.js";

// Agent contract tests mock provider HTTP calls; never send their fetch stubs
// to a developer's configured Upstash Vector instance.
config.upstashVectorRestUrl = "";
config.upstashVectorRestToken = "";

function chatResponse(message: any) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message }] }), { status: 200, headers: { "content-type": "application/json" } });
}

function toolResponse(name: string, args: string, id = "call-1", finishReason = "tool_calls") {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
}

test("preview links are included exactly once even when the model omits them", () => {
  const url = "https://preview.test/app";
  assert.equal(appendPreviewLinks("The app is ready.", [url]), `The app is ready.\n\n🔗 Daytona preview: ${url}`);
  assert.equal(appendPreviewLinks(`The app is ready at ${url}.`, [url]), `The app is ready at ${url}.`);
});

test("verified triggers receive executor framing while ordinary conversations do not", () => {
  assert.equal(triggerAutonomyInstructions(undefined), undefined);
  const instructions = triggerAutonomyInstructions("evt_trigger_1");
  assert.match(instructions ?? "", /AUTONOMOUS TRIGGER EXECUTION/);
  assert.match(instructions ?? "", /not a user chat message/i);
  assert.match(instructions ?? "", /return exactly NO_ACTION/i);
  assert.match(instructions ?? "", /not create a durable attention record.*guess/i);
});

test("private runs receive a capability-neutral operating kernel", () => {
  assert.match(AUTONOMY_OPERATING_KERNEL, /connected app or web tool, native tool, MCP, browser\/computer/i);
  assert.match(AUTONOMY_OPERATING_KERNEL, /provider receipt.*artifact validation.*browser inspection/i);
  assert.match(AUTONOMY_OPERATING_KERNEL, /exact approval and provider-verification boundary/i);
  assert.match(AUTONOMY_OPERATING_KERNEL, /exact next action/i);
});

test("tool-bearing runs reject bare completion language until the result is closed out", () => {
  assert.equal(needsAutonomyCloseoutNudge("Done.", 1), true);
  assert.equal(needsAutonomyCloseoutNudge("Done — verified the provider receipt and scheduled the next check.", 1), false);
  assert.equal(needsAutonomyCloseoutNudge("Done.", 0), false);
});

async function withAgentMocks(responses: Response[], execute: (slug: string, args: any) => unknown, fn: () => Promise<void>, includeMultiExecute = false, safeToolSchema: Record<string, unknown> = { type: "object" }) {
  const originalFetch = globalThis.fetch;
  let index = 0;
  const session = {
    sessionId: "test-composio-session",
    tools: async () => [
      { type: "function", function: { name: "TEST_SAFE_TOOL", description: "Test-only safe tool", parameters: safeToolSchema } },
      { type: "function", function: { name: "GITHUB_DELETE_REPOSITORY", description: "Test-only risky tool", parameters: { type: "object" } } },
    ],
    execute,
  };
  if (includeMultiExecute) session.tools = async () => [
    { type: "function", function: { name: "TEST_SAFE_TOOL", description: "Test-only safe tool", parameters: safeToolSchema } },
    { type: "function", function: { name: "GITHUB_DELETE_REPOSITORY", description: "Test-only risky tool", parameters: { type: "object" } } },
    { type: "function", function: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "Test-only multi tool", parameters: { type: "object" } } },
  ];
  setAgentDependenciesForTests({ composio: { create: async () => session, sessions: { use: async () => session } } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    if (url.includes("/chat/completions")) return responses[index++] ?? chatResponse({ role: "assistant", content: "unexpected extra request" });
    // Async SDK telemetry and unrelated provider requests must not consume a
    // queued model completion merely because this test replaces global fetch.
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await fn(); } finally {
    globalThis.fetch = originalFetch;
  }
}

test("ordinary conversation sends an attached image through the normal Composio email action", async () => {
  const userId = 830071;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const originalFetch = globalThis.fetch;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const emailSchema = { type: "object", required: ["recipient_email", "subject", "body", "attachment"], properties: {
    recipient_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
    attachment: { type: "string", file_uploadable: true },
  }, additionalProperties: false };
  const executed: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const staged: Array<{ toolSlug: string; toolkitSlug: string; file: File }> = [];
  const session = {
    sessionId: "normal-image-action-session",
    tools: async () => [{ type: "function", function: { name: "GMAIL_SEND_EMAIL", parameters: emailSchema } }],
    execute: async (slug: string, args: Record<string, unknown>) => {
      executed.push({ slug, args });
      return { successful: true, data: { id: "gmail-sent-with-image", status: "sent" } };
    },
  };
  const composio = {
    create: async () => session,
    sessions: { use: async () => session },
    tools: { getRawComposioToolBySlug: async (slug: string) => ({ slug, toolkit: { slug: "gmail" } }) },
    files: { upload: async (input: { toolSlug: string; toolkitSlug: string; file: File }) => {
      staged.push(input);
      return { name: input.file.name, mimetype: input.file.type, s3key: "staged/run-agent-image" };
    } },
  };
  const requests: Array<Record<string, any>> = [];
  let chatIndex = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text", "image"] }, supported_parameters: { tools: true } } }), { status: 200 });
    if (url.includes("/chat/completions")) {
      requests.push(JSON.parse(String(init?.body)));
      return chatIndex++ === 0
        ? toolResponse("GMAIL_SEND_EMAIL", JSON.stringify({ recipient_email: "team@example.com", subject: "Launch", body: "The photo is attached." }))
        : chatResponse({ role: "assistant", content: "The email was sent with the photo attached." });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio });
  try {
    const result = await runAgent(userId, [
      { type: "text", text: "Email this photo to the team with a short note." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${imageBytes.toString("base64")}` } },
    ], [], "test/model");
    assert.match(result.text, /sent with the photo attached/);
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.toolSlug, "GMAIL_SEND_EMAIL");
    assert.equal(staged[0]?.toolkitSlug, "gmail");
    assert.deepEqual(executed, [{ slug: "GMAIL_SEND_EMAIL", args: {
      recipient_email: "team@example.com", subject: "Launch", body: "The photo is attached.",
      attachment: { name: "chusky-image-1.png", mimetype: "image/png", s3key: "staged/run-agent-image" },
    } }]);
    const offeredTools = requests[0]?.tools as Array<{ function?: { name?: string; parameters?: { required?: string[] } } }>;
    assert.equal(offeredTools.some((tool) => tool.function?.name === "CHUCK_MEDIA_BRIDGE"), false);
    const emailTool = offeredTools.find((tool) => tool.function?.name === "GMAIL_SEND_EMAIL");
    assert.ok(emailTool);
    assert.deepEqual(emailTool.function?.parameters?.required, ["recipient_email", "subject", "body"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a reattached image resumes the pending Composio email through multi-execute with the image staged", async () => {
  const userId = 830072;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const originalFetch = globalThis.fetch;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const emailSchema = { type: "object", required: ["recipient_email", "subject", "body", "attachment"], properties: {
    recipient_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
    attachment: { type: "string", file_uploadable: true },
  }, additionalProperties: false };
  const executed: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const staged: Array<{ toolSlug: string; toolkitSlug: string; file: File }> = [];
  const session = {
    sessionId: "reattached-image-retry-session",
    tools: async () => [
      { type: "function", function: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", parameters: { type: "object" } } },
      { type: "function", function: { name: "GMAIL_SEND_EMAIL", parameters: emailSchema } },
    ],
    execute: async (slug: string, args: Record<string, unknown>) => {
      if (slug === "COMPOSIO_MULTI_EXECUTE_TOOL") throw new Error("image retry must not use the text-only Composio batch path");
      executed.push({ slug, args });
      return { successful: true, data: { id: "gmail-retry-with-image", status: "sent" } };
    },
  };
  const composio = {
    create: async () => session,
    sessions: { use: async () => session },
    tools: { getRawComposioToolBySlug: async (slug: string) => ({ slug, toolkit: { slug: "gmail" } }) },
    files: { upload: async (input: { toolSlug: string; toolkitSlug: string; file: File }) => {
      staged.push(input);
      return { name: input.file.name, mimetype: input.file.type, s3key: "staged/reattached-image" };
    } },
  };
  const requests: Array<Record<string, any>> = [];
  let chatIndex = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text", "image"] }, supported_parameters: { tools: true } } }), { status: 200 });
    if (url.includes("/chat/completions")) {
      requests.push(JSON.parse(String(init?.body)));
      return chatIndex++ === 0
        ? toolResponse("COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify({
          tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "team@example.com", subject: "Gratitude", body: "We don't walk alone." } }],
          current_step: "SENDING_EMAIL", current_step_metric: "0/1 emails", session_id: "reattached-image-retry-session",
          sync_response_to_workbench: false, thought: "Send the requested image with the email.",
        }))
        : chatResponse({ role: "assistant", content: "The email was sent with the reattached image." });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio });
  try {
    const result = await runAgent(userId, [
      { type: "text", text: "Inspect the attached image and respond helpfully to the user." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${imageBytes.toString("base64")}` } },
    ], [
      { role: "user", content: "Send this generated gratitude image to team@example.com with a short note." },
      { role: "assistant", content: "I couldn't send it because the image wasn't available. Please reattach the image here and I can try again with it." },
    ], "test/model");
    assert.match(result.text, /sent with the reattached image/i);
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.toolSlug, "GMAIL_SEND_EMAIL");
    assert.equal(staged[0]?.toolkitSlug, "gmail");
    assert.deepEqual(executed, [{ slug: "GMAIL_SEND_EMAIL", args: {
      recipient_email: "team@example.com", subject: "Gratitude", body: "We don't walk alone.",
      attachment: { name: "chusky-image-1.png", mimetype: "image/png", s3key: "staged/reattached-image" },
    } }]);
    assert.match(JSON.stringify(requests[0]?.messages), /IMAGE ACTION RETRY/);
  } finally {
    globalThis.fetch = originalFetch;
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "test-reset-session", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("a later Instagram retry stages the original saved attachment before publishing", async () => {
  const userId = 830075;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const originalFetch = globalThis.fetch;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const at = Date.now() - 5 * 60_000;
  const asset = { id: "img_attached_retry", userId, name: "telegram-photo.jpg", purpose: "Image uploaded from Telegram", description: "Post it", tags: ["telegram", "uploaded-image"], r2Key: "images/owner/attached.jpg", contentType: "image/png" as const, size: imageBytes.length, createdAt: at + 3000, updatedAt: at + 3000 };
  const durable = await getSession(userId);
  durable.imageAssets = [asset];
  await saveSession(userId, durable);
  const postSchema = { type: "object", required: ["ig_user_id"], properties: {
    ig_user_id: { type: "string" }, caption: { type: "string" },
    image_file: { type: "object", file_uploadable: true, required: ["name", "mimetype", "s3key"], properties: { name: { type: "string" }, mimetype: { type: "string" }, s3key: { type: "string" } } },
    video_file: { type: "object", file_uploadable: true },
  } };
  const publishSchema = { type: "object", properties: { creation_id: { type: "string" } } };
  const readSchema = { type: "object", properties: { ig_media_id: { type: "string" }, fields: { type: "string" } } };
  const executed: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const session = {
    sessionId: "saved-image-instagram-retry",
    tools: async () => [{ type: "function", function: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", parameters: { type: "object" } } }],
    search: async ({ query }: { query: string }) => {
      const slug = query.match(/INSTAGRAM_[A-Z_]+/)?.[0] ?? "INSTAGRAM_GET_IG_MEDIA";
      return { toolSchemas: { [slug]: { toolSlug: slug, inputSchema: slug === "INSTAGRAM_POST_IG_USER_MEDIA" ? postSchema : slug === "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH" ? publishSchema : readSchema } } };
    },
    execute: async (slug: string, args: Record<string, unknown>) => {
      if (slug === "COMPOSIO_MULTI_EXECUTE_TOOL") throw new Error("A text-only batch must not reach Composio");
      executed.push({ slug, args });
      if (slug === "INSTAGRAM_POST_IG_USER_MEDIA") return { successful: true, data: { id: "container-1" } };
      if (slug === "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH") return { successful: true, data: { id: "published-1" } };
      return { successful: true, data: { id: "published-1", media_type: "IMAGE", media_url: "https://instagram.example/published.jpg" } };
    },
  };
  const composio = {
    create: async () => session, sessions: { use: async () => session },
    tools: { getRawComposioToolBySlug: async (slug: string) => ({ slug, toolkit: { slug: "instagram" } }) },
    files: { upload: async () => ({ name: "telegram-photo.jpg", mimetype: "image/png", s3key: "staged/original" }) },
  };
  let chatIndex = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    if (url.includes("/chat/completions")) return chatIndex++ === 0
      ? toolResponse("COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify({ tools: [{ tool_slug: "INSTAGRAM_POST_IG_USER_MEDIA", arguments: { ig_user_id: "owner", caption: "New caption" } }] }))
      : chatResponse({ role: "assistant", content: "The image post was published and verified." });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio, mediaBridgeStorage: {
    getImageAsset: async (owner, id) => owner === userId && id === asset.id ? { ...asset, downloadUrl: "https://private.example/image" } : undefined,
    readR2Object: async () => Buffer.from(imageBytes),
    signR2Download: async () => "https://private.example/image",
    saveImageAsset: async () => { throw new Error("The saved image must be reused"); },
  } });
  try {
    const result = await runAgent(userId, "Tried to fix, try again", [
      { role: "user", content: "[Image attached] I am sending you the image use different text and post it", createdAt: at },
      { role: "assistant", content: "The image did not reach Instagram. No post was made.", createdAt: at + 1000 },
    ], "test/model");
    assert.match(result.text, /published and verified/);
    assert.deepEqual(executed.map((call) => call.slug), ["INSTAGRAM_POST_IG_USER_MEDIA", "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", "INSTAGRAM_GET_IG_MEDIA"]);
    assert.deepEqual(executed[0]?.args.image_file, { name: "telegram-photo.jpg", mimetype: "image/png", s3key: "staged/original" });
  } finally {
    globalThis.fetch = originalFetch;
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "test-reset-session", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("a reattached image is uploaded before a pending LinkedIn multi-execute post", async () => {
  const userId = 830074;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const originalFetch = globalThis.fetch;
  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const postSchema = { type: "object", required: ["author", "commentary", "images"], properties: {
    author: { type: "string" }, commentary: { type: "string" }, images: { type: "array", items: { type: "string" } },
  }, additionalProperties: false };
  const uploadSchema = { type: "object", required: ["owner_urn"], properties: { owner_urn: { type: "string" } }, additionalProperties: false };
  const executed: Array<{ slug: string; args: Record<string, unknown> }> = [];
  let uploaded: Buffer | undefined;
  const session = {
    sessionId: "reattached-linkedin-retry-session",
    tools: async () => [
      { type: "function", function: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", parameters: { type: "object" } } },
      { type: "function", function: { name: "LINKEDIN_CREATE_LINKED_IN_POST", parameters: postSchema } },
    ],
    search: async () => ({ toolSchemas: { LINKEDIN_REGISTER_IMAGE_UPLOAD: { toolSlug: "LINKEDIN_REGISTER_IMAGE_UPLOAD", inputSchema: uploadSchema } } }),
    execute: async (slug: string, args: Record<string, unknown>) => {
      if (slug === "COMPOSIO_MULTI_EXECUTE_TOOL") throw new Error("LinkedIn post must not bypass the image upload adapter");
      executed.push({ slug, args });
      if (slug === "LINKEDIN_REGISTER_IMAGE_UPLOAD") return { successful: true, data: { upload_url: "https://www.linkedin.com/dms-uploads/reattached-image", asset_urn: "urn:li:image:reattached" } };
      return { successful: true, data: { id: "urn:li:share:reattached" } };
    },
  };
  const requests: Array<Record<string, any>> = [];
  let chatIndex = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text", "image"] }, supported_parameters: { tools: true } } }), { status: 200 });
    if (url.includes("/chat/completions")) {
      requests.push(JSON.parse(String(init?.body)));
      return chatIndex++ === 0
        ? toolResponse("COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify({
          tools: [{ tool_slug: "LINKEDIN_CREATE_LINKED_IN_POST", arguments: { author: "urn:li:person:owner", commentary: "Grateful for everyone who guides us." } }],
          current_step: "PUBLISHING_POST", current_step_metric: "0/1 posts", session_id: "reattached-linkedin-retry-session",
          sync_response_to_workbench: false, thought: "Publish the requested post with its attached image.",
        }))
        : chatResponse({ role: "assistant", content: "The LinkedIn post was published with the reattached image." });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  setAgentDependenciesForTests({
    composio: { create: async () => session, sessions: { use: async () => session } },
    mediaBridgeFetch: async (_url: string | URL | Request, init?: RequestInit) => {
      uploaded = Buffer.from(init?.body as Uint8Array);
      return new Response(null, { status: 201 });
    },
  });
  try {
    const result = await runAgent(userId, [
      { type: "text", text: "Inspect the attached image and respond helpfully to the user." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${imageBytes.toString("base64")}` } },
    ], [
      { role: "user", content: "Publish my gratitude caption to LinkedIn with the generated image." },
      { role: "assistant", content: "I couldn't post it because the image wasn't available. Please reattach the image here and I can try again with it." },
    ], "test/model");
    assert.match(result.text, /published with the reattached image/i);
    assert.deepEqual(uploaded, imageBytes);
    assert.deepEqual(executed, [
      { slug: "LINKEDIN_REGISTER_IMAGE_UPLOAD", args: { owner_urn: "urn:li:person:owner" } },
      { slug: "LINKEDIN_CREATE_LINKED_IN_POST", args: { author: "urn:li:person:owner", commentary: "Grateful for everyone who guides us.", images: ["urn:li:image:reattached"] } },
    ]);
    assert.match(JSON.stringify(requests[0]?.messages), /IMAGE ACTION RETRY/);
  } finally {
    globalThis.fetch = originalFetch;
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "test-reset-session", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("an image fetched from saved assets is uploaded on a referential LinkedIn post request", async () => {
  const userId = 830075;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const originalFetch = globalThis.fetch;
  const originalR2 = {
    accountId: config.r2AccountId,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
    bucket: config.r2Bucket,
  };
  config.r2AccountId = "test-account";
  config.r2AccessKeyId = "test-access-key";
  config.r2SecretAccessKey = "test-secret-key";
  config.r2Bucket = "test-images";

  const imageBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  imageBytes.write("IEND", 16, "ascii");
  const now = Date.now();
  const selectedAsset = {
    id: "img_saved_prayer",
    userId,
    name: "prayer-elder.png",
    purpose: "Generated gratitude image",
    description: "A young man kneeling in prayer with an elder behind him.",
    tags: ["generated", "prayer"],
    r2Key: `images/${userId}/prayer-elder.png`,
    contentType: "image/png" as const,
    size: imageBytes.byteLength,
    createdAt: now,
    updatedAt: now,
  };
  const otherAsset = {
    ...selectedAsset,
    id: "img_saved_landscape",
    name: "coastal-landscape.png",
    purpose: "A coastal landscape",
    description: "A quiet coastline at sunset.",
    tags: ["landscape"],
    r2Key: `images/${userId}/coastal-landscape.png`,
    createdAt: now - 1000,
  };
  const storedSession = await getSession(userId);
  storedSession.imageAssets = [selectedAsset, otherAsset];
  await saveSession(userId, storedSession);

  const postSchema = { type: "object", required: ["author", "commentary", "images"], properties: {
    author: { type: "string" }, commentary: { type: "string" }, images: { type: "array", items: { type: "string" } },
  }, additionalProperties: false };
  const uploadSchema = { type: "object", required: ["owner_urn"], properties: { owner_urn: { type: "string" } }, additionalProperties: false };
  const executed: Array<{ slug: string; args: Record<string, unknown> }> = [];
  let uploaded: Buffer | undefined;
  const session = {
    sessionId: "saved-image-linkedin-session",
    tools: async () => [
      { type: "function", function: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", parameters: { type: "object" } } },
      { type: "function", function: { name: "LINKEDIN_CREATE_LINKED_IN_POST", parameters: postSchema } },
    ],
    search: async () => ({ toolSchemas: { LINKEDIN_REGISTER_IMAGE_UPLOAD: { toolSlug: "LINKEDIN_REGISTER_IMAGE_UPLOAD", inputSchema: uploadSchema } } }),
    execute: async (slug: string, args: Record<string, unknown>) => {
      if (slug === "COMPOSIO_MULTI_EXECUTE_TOOL") throw new Error("LinkedIn post must not bypass the image upload adapter");
      executed.push({ slug, args });
      if (slug === "LINKEDIN_REGISTER_IMAGE_UPLOAD") return { successful: true, data: { upload_url: "https://www.linkedin.com/dms-uploads/saved-prayer-image", asset_urn: "urn:li:image:saved-prayer" } };
      return { successful: true, data: { id: "urn:li:share:saved-prayer" } };
    },
  };
  const requests: Array<Record<string, any>> = [];
  let chatIndex = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text", "image"] }, supported_parameters: { tools: true } } }), { status: 200 });
    if (url.includes("/chat/completions")) {
      requests.push(JSON.parse(String(init?.body)));
      const index = chatIndex++;
      if (index === 0) return toolResponse("CHUCK_SEARCH_IMAGE_ASSETS", JSON.stringify({ query: "prayer elder" }), "search-images");
      if (index === 1) return toolResponse("CHUCK_GET_IMAGE_ASSET", JSON.stringify({ id: selectedAsset.id }), "get-prayer-image");
      if (index === 2) return toolResponse("COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify({
        tools: [{ tool_slug: "LINKEDIN_CREATE_LINKED_IN_POST", arguments: { author: "urn:li:person:owner", commentary: "Grateful for the people whose prayers guide us." } }],
        current_step: "PUBLISHING_POST", current_step_metric: "0/1 posts", session_id: "saved-image-linkedin-session",
        sync_response_to_workbench: false, thought: "Publish the requested gratitude post with the image just retrieved.",
      }), "publish-prayer-post");
      return chatResponse({ role: "assistant", content: "The LinkedIn post was published with the saved prayer image." });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  setAgentDependenciesForTests({
    composio: { create: async () => session, sessions: { use: async () => session } },
    mediaBridgeStorage: {
      saveImageAsset: async () => { throw new Error("A saved asset should be reused without creating another asset"); },
      getImageAsset: async (_owner: number, id: string) => {
        const asset = [selectedAsset, otherAsset].find((candidate) => candidate.id === id);
        return asset ? { ...asset, downloadUrl: "https://signed.example/private-image" } : undefined;
      },
      readR2Object: async (key: string) => key === selectedAsset.r2Key ? imageBytes : Buffer.alloc(0),
      signR2Download: async () => "https://signed.example/private-image",
    },
    mediaBridgeFetch: async (_url: string | URL | Request, init?: RequestInit) => {
      uploaded = Buffer.from(init?.body as Uint8Array);
      return new Response(null, { status: 201 });
    },
  });
  try {
    const result = await runAgent(userId, "Post it now", [], "test/model");
    assert.match(result.text, /published with the saved prayer image/i);
    assert.deepEqual(uploaded, imageBytes, "the retrieved private image bytes reach LinkedIn's upload flow");
    assert.deepEqual(executed, [
      { slug: "LINKEDIN_REGISTER_IMAGE_UPLOAD", args: { owner_urn: "urn:li:person:owner" } },
      { slug: "LINKEDIN_CREATE_LINKED_IN_POST", args: { author: "urn:li:person:owner", commentary: "Grateful for the people whose prayers guide us.", images: ["urn:li:image:saved-prayer"] } },
    ]);
    assert.equal(executed.some(({ args }) => "assetId" in args), false, "private image asset IDs stay out of LinkedIn action arguments");
    assert.equal(requests.length, 4, "search, retrieval, image post, and truthful completion each use a separate model round");
  } finally {
    globalThis.fetch = originalFetch;
    config.r2AccountId = originalR2.accountId;
    config.r2AccessKeyId = originalR2.accessKeyId;
    config.r2SecretAccessKey = originalR2.secretAccessKey;
    config.r2Bucket = originalR2.bucket;
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "test-reset-session", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("image generation reports when the image could not be saved for reuse in later turns", async () => {
  const userId = 830073;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const originalFetch = globalThis.fetch;
  const generatedBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(generatedBytes);
  generatedBytes.write("IEND", 16, "ascii");
  const imageModel = config.imageModel;
  const chatRequests: Array<Record<string, any>> = [];
  let chatIndex = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    if (url.includes("/images")) return new Response(JSON.stringify({ data: [{ b64_json: generatedBytes.toString("base64"), media_type: "image/png" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/chat/completions")) {
      chatRequests.push(JSON.parse(String(init?.body)));
      return chatIndex++ === 0
        ? toolResponse("CHUCK_GENERATE_IMAGE", JSON.stringify({ prompt: "A warm gratitude image", destination: "telegram" }))
        : chatResponse({ role: "assistant", content: "The image was created for this turn." });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  setAgentDependenciesForTests({
    composio: { create: async () => ({ sessionId: "generated-image-save-failure", tools: async () => [], execute: async () => undefined }) },
    mediaBridgeStorage: {
      saveImageAsset: async () => { throw new Error("R2 persistence unavailable"); },
      getImageAsset: async () => undefined,
      readR2Object: async () => generatedBytes,
      signR2Download: async () => "https://unused.example/image.png",
    } as any,
  });
  try {
    config.imageModel = "meta/muse-image";
    const result = await runAgent(userId, "Create a warm gratitude image.", [], "test/model");
    assert.equal(result.generatedImages?.length, 1);
    const toolResult = chatRequests[1]?.messages.find((message: any) => message.role === "tool")?.content as string;
    assert.match(toolResult, /"imagePersistence":"unavailable"/);
    assert.match(toolResult, /available only during this agent turn/i);
    assert.doesNotMatch(toolResult, /All generated images were saved/);
  } finally {
    config.imageModel = imageModel;
    globalThis.fetch = originalFetch;
    setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "test-reset-session", tools: async () => [], execute: async () => ({ successful: true, data: {} }) }) } });
  }
});

test("agent uses the selected model for a normal text response", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830001);
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    requests.push(JSON.parse(String(init?.body)));
    return chatResponse({ role: "assistant", content: "done" });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "text-session", tools: async () => [], execute: async () => undefined }) } });
  try {
    const result = await runAgent(830001, "hello", [], "test/model");
    assert.equal(result.text, "done");
    assert.deepEqual(requests.map((request) => request.model), ["test/model"]);
    assert.deepEqual(requests[0]?.provider, { allow_fallbacks: true, preferred_max_latency: { p90: 45 } });
  } finally { globalThis.fetch = originalFetch; }
});

test("gives a transient OpenRouter retry a bounded larger timeout", () => {
  const original = config.openRouterTimeoutMs;
  config.openRouterTimeoutMs = 45_000;
  try {
    assert.equal(openRouterAttemptTimeoutMs(0), 45_000);
    assert.equal(openRouterAttemptTimeoutMs(1), 90_000);
    assert.equal(openRouterAttemptTimeoutMs(2), 120_000);
  } finally {
    config.openRouterTimeoutMs = original;
  }
});

test("raises the output budget for structured artifact calls", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830054);
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "artifact-budget-session", tools: async () => [], execute: async () => undefined }) } });
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? toolResponse("CHUCK_CREATE_PDF", "{\"title\":\"truncated")
      : chatResponse({ role: "assistant", content: "I could not complete the PDF call." });
  }) as typeof fetch;
  try {
    const result = await runAgent(830054, "Create a PDF playbook with charts", [], "test/model");
    assert.match(result.text, /could not complete/);
    assert.equal(requests[0]?.max_tokens, config.openRouterArtifactMaxTokens);
  } finally { globalThis.fetch = originalFetch; }
});

test("emails a generated artifact through the exact connected Composio action", async () => {
  const userId = 830055;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const originalFetch = globalThis.fetch;
  const originalCreatePdf = daytonaEngine.createPdf;
  const originalDownloadArtifact = daytonaEngine.downloadArtifact;
  let sentArguments: Record<string, unknown> | undefined;
  const session = {
    sessionId: "artifact-email-session",
    tools: async () => [{
      type: "function",
      function: {
        name: "GMAIL_SEND_EMAIL",
        description: "Send an email",
        parameters: { type: "object", properties: {
          recipient_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
          attachment: { type: "array", items: { type: "object", properties: { file_name: { type: "string" }, file_data: { type: "string" }, mime_type: { type: "string" } } } },
        } },
      },
    }],
    execute: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "GMAIL_SEND_EMAIL");
      sentArguments = args;
      return { ok: true };
    },
  };
  setAgentDependenciesForTests({ composio: { create: async () => session } });
  (daytonaEngine as any).createPdf = async () => ({ __chuskyArtifactReady: true, id: "art_email_1", name: "proposal.pdf", type: "pdf", contentType: "application/pdf", verification: { pagesRendered: 2, expectedTitleMatched: true } });
  (daytonaEngine as any).downloadArtifact = async (_owner: number, id: string) => ({ id, name: "proposal.pdf", type: "pdf", contentType: "application/pdf", size: 9, data: Buffer.from("pdf-bytes") });
  const modelRequests: Array<Record<string, any>> = [];
  let responseIndex = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    modelRequests.push(JSON.parse(String(init?.body ?? "{}")));
    const responses = [
      toolResponse("CHUCK_CREATE_PDF", JSON.stringify({ title: "Proposal", sections: [{ heading: "Summary", body: "Approved proposal" }] }), "call-create-pdf"),
      toolResponse("CHUCK_EMAIL_ARTIFACT", JSON.stringify({ emailTool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "client@example.com", subject: "Proposal", body: "Attached." }, artifactIds: ["art_email_1"] }), "call-email-artifact"),
      chatResponse({ role: "assistant", content: "The proposal was emailed with the generated PDF attached." }),
    ];
    return responses[responseIndex++] ?? chatResponse({ role: "assistant", content: "unexpected extra request" });
  }) as typeof fetch;
  try {
    const result = await runAgent(userId, "Create the proposal PDF and email it to the client.", [], "test/model");
    assert.match(result.text, /emailed/);
    assert.equal(result.generatedFiles?.[0]?.artifactId, "art_email_1");
    const toolResult = modelRequests.flatMap((request) => request.messages ?? []).find((message: any) => message.role === "tool" && String(message.content).includes("artifactCreated"));
    assert.match(String(toolResult?.content), /"verification"/);
    assert.match(String(toolResult?.content), /"pagesRendered":2/);
    assert.equal((sentArguments?.attachment as Array<Record<string, string>>)?.[0]?.file_name, "proposal.pdf");
    assert.equal((sentArguments?.attachment as Array<Record<string, string>>)?.[0]?.file_data, Buffer.from("pdf-bytes").toString("base64"));
  } finally {
    (daytonaEngine as any).createPdf = originalCreatePdf;
    (daytonaEngine as any).downloadArtifact = originalDownloadArtifact;
    globalThis.fetch = originalFetch;
  }
});

test("file bridge requires approval and uploads only an owner artifact through the exposed action schema", async () => {
  const userId = 830056;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const originalFetch = globalThis.fetch;
  const originalDownloadArtifact = daytonaEngine.downloadArtifact;
  let executed: { slug: string; args: Record<string, unknown> } | undefined;
  const session = {
    sessionId: "artifact-bridge-session",
    tools: async () => [{
      type: "function",
      function: {
        name: "GOOGLEDRIVE_UPLOAD_FILE",
        description: "Upload a file",
        parameters: { type: "object", required: ["parent_id", "file"], properties: {
          parent_id: { type: "string" },
          file: { type: "object", required: ["name", "data", "mime_type"], properties: {
            name: { type: "string" }, data: { type: "string", description: "base64 encoded file bytes" }, mime_type: { type: "string" },
          } },
        } },
      },
    }],
    execute: async (slug: string, args: Record<string, unknown>) => {
      executed = { slug, args };
      return { successful: true, data: { id: "drive-file-123", name: "brief.pdf" } };
    },
  };
  setAgentDependenciesForTests({ composio: { create: async () => session, sessions: { use: async () => session } } });
  (daytonaEngine as any).downloadArtifact = async (owner: number, id: string) => {
    assert.equal(owner, userId);
    assert.equal(id, "artifact_bridge_1");
    return { id, name: "brief.pdf", type: "pdf", contentType: "application/pdf", size: 9, data: Buffer.from("pdf-bytes") };
  };
  const modelRequests: Array<Record<string, any>> = [];
  let responseIndex = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    modelRequests.push(JSON.parse(String(init?.body ?? "{}")));
    return responseIndex++ === 0
      ? toolResponse("CHUCK_FILE_BRIDGE", JSON.stringify({ artifactId: "artifact_bridge_1", toolSlug: "GOOGLEDRIVE_UPLOAD_FILE", arguments: { parent_id: "folder_123" } }), "call-file-bridge")
      : chatResponse({ role: "assistant", content: "The approved PDF was uploaded." });
  }) as typeof fetch;
  try {
    await assert.rejects(() => runAgent(userId, "Upload my PDF to Drive", [], "test/model"), (error: unknown) => error instanceof ApprovalRequiredError);
    assert.equal(executed, undefined, "must not upload before approval");
    const approval = (await getSession(userId)).approvals[0];
    assert.equal(approval.toolSlug, "CHUCK_FILE_BRIDGE");
    await import("../src/store.js").then(({ setApprovalStatus }) => setApprovalStatus(userId, approval.id, "approved"));
    responseIndex = 0;
    const result = await runAgent(userId, approval.request, approval.history, approval.model, undefined, undefined, undefined, approval.id);
    assert.match(result.text, /approved PDF was uploaded/);
    assert.equal(executed?.slug, "GOOGLEDRIVE_UPLOAD_FILE");
    assert.deepEqual(executed?.args, { parent_id: "folder_123", file: { name: "brief.pdf", data: Buffer.from("pdf-bytes").toString("base64"), mime_type: "application/pdf" } });
    const exposed = modelRequests.at(-1)?.tools?.map((item: any) => item.function?.name);
    assert.ok(exposed?.includes("GOOGLEDRIVE_UPLOAD_FILE"));
  } finally {
    (daytonaEngine as any).downloadArtifact = originalDownloadArtifact;
    globalThis.fetch = originalFetch;
  }
});

test("shared current-information requests are nudged into live web search", async () => {
  const userId = 830053;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  let responseIndex = 0;
  setAgentDependenciesForTests({ composio: {
    create: async () => ({
      sessionId: "shared-search-session",
      tools: async () => [{ type: "function", function: { name: "COMPOSIO_SEARCH_WEB", description: "Search live web", parameters: { type: "object" } } }],
      execute: async (name: string, args: unknown) => ({ name, args, sources: [{ title: "Official source", url: "https://example.com/rates" }] }),
    }),
  } });
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    requests.push(JSON.parse(String(init?.body)));
    const responses = [
      chatResponse({ role: "assistant", content: "I cannot access current rates." }),
      toolResponse("COMPOSIO_SEARCH_WEB", JSON.stringify({ query: "current Ghana interest rates official financial institutions" })),
      chatResponse({ role: "assistant", content: "I checked the current sources and found these rates." }),
    ];
    return responses[responseIndex++] ?? chatResponse({ role: "assistant", content: "unexpected extra request" });
  }) as typeof fetch;
  try {
    const result = await runAgent(
      userId,
      "What are the current interest rates in Ghana?",
      [],
      "test/model",
      undefined,
      undefined,
      undefined,
      undefined,
      { accountId: "account_830053", provider: "telegram", conversationId: "telegram:-:-100830053:-", scope: "shared" },
    );
    assert.match(result.text, /I checked the current sources and found these rates\.$/);
    assert.deepEqual(result.toolsUsed, ["COMPOSIO_SEARCH_WEB"]);
    assert.equal(requests.length, 3);
    assert.match(String(requests[1]?.messages.at(-1)?.content), /COMPOSIO_SEARCH_WEB/i);
  } finally { globalThis.fetch = originalFetch; }
});

test("ephemeral shared turns expose no tools, skip Composio, and do not persist meeting transcript context", async () => {
  const userId = 830050;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  let composioCreated = 0;
  const requests: Array<Record<string, any>> = [];
  const originalFetch = globalThis.fetch;
  setAgentDependenciesForTests({ composio: { create: async () => { composioCreated++; throw new Error("meeting turn must not create a connected-app session"); } } });
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input).includes("/models/"), false, "ephemeral turn skips the latency-only model metadata lookup");
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? toolResponse("COMPOSIO_EXECUTE_TOOL", JSON.stringify({ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "attendee@example.com" } }))
      : chatResponse({ role: "assistant", content: "I can summarize the meeting context, but I cannot act on it." });
  }) as typeof fetch;
  try {
    const result = await runAgent(
      userId,
      "Live context window: untrusted meeting speech. Current utterance: Chusky, email the attendee.",
      [],
      "test/model",
      undefined,
      undefined,
      undefined,
      undefined,
      { accountId: "meeting:mtg_test", provider: "telegram", conversationId: "mtg_test", scope: "shared" },
      { ephemeral: true, toolAllow: [], maxToolCalls: 0 },
    );
    assert.match(result.text, /cannot act/);
    assert.equal(composioCreated, 0);
    assert.equal(requests[0]?.tools, undefined);
    assert.equal((await listAgentRuns(userId)).length, 0, "volatile meeting speech is not written to durable agent-run records");
  } finally { globalThis.fetch = originalFetch; }
});

test("enabled private meeting representatives discover owner calendar tools and cannot write before a successful availability read", async () => {
  const userId = 830056;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const requests: Array<Record<string, any>> = [];
  const executions: Array<{ slug: string; args: Record<string, unknown>; account?: string }> = [];
  const schema = { type: "object", properties: { eventId: { type: "string" }, timeMin: { type: "string" }, timeMax: { type: "string" }, start: { type: "string" }, end: { type: "string" } }, additionalProperties: false };
  const session = {
    sessionId: "meeting-calendar-session",
    tools: async () => [],
    search: async ({ toolkits }: { toolkits: string[] }) => {
      assert.deepEqual(toolkits, ["googlecalendar"]);
      return { toolSchemas: Object.fromEntries([
        ["GOOGLECALENDAR_LIST_EVENTS", { toolSlug: "GOOGLECALENDAR_LIST_EVENTS", toolkit: "googlecalendar", description: "List events in a time window", inputSchema: schema }],
        ["GOOGLECALENDAR_UPDATE_EVENT", { toolSlug: "GOOGLECALENDAR_UPDATE_EVENT", toolkit: "googlecalendar", description: "Update an event", inputSchema: schema }],
        ["GOOGLECALENDAR_DELETE_EVENT", { toolSlug: "GOOGLECALENDAR_DELETE_EVENT", toolkit: "googlecalendar", description: "Delete an event", inputSchema: schema }],
        ["GMAIL_SEND_EMAIL", { toolSlug: "GMAIL_SEND_EMAIL", toolkit: "gmail", description: "Send email", inputSchema: schema }],
      ]) };
    },
    execute: async (slug: string, args: Record<string, unknown>, options?: { account?: string }) => {
      executions.push({ slug, args, account: options?.account });
      return { successful: true, data: { events: [] } };
    },
  };
  const originalFetch = globalThis.fetch;
  setAgentDependenciesForTests({ composio: {
    create: async () => session,
    connectedAccounts: { list: async () => [{ id: "calendar-account-1", alias: "work-calendar", toolkit: { slug: "googlecalendar" }, status: "ACTIVE" }] },
  } });
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/chat/completions")) {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? toolResponse("GOOGLECALENDAR_UPDATE_EVENT", JSON.stringify({ eventId: "event-1", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z" }), "call-1")
        : requests.length === 2
          ? toolResponse("GOOGLECALENDAR_LIST_EVENTS", "{}", "call-2")
          : requests.length === 3
            ? toolResponse("GOOGLECALENDAR_UPDATE_EVENT", JSON.stringify({ eventId: "event-1", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z" }), "call-3")
            : chatResponse({ role: "assistant", content: "I checked availability and rescheduled the meeting." });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await runAgent(
      userId,
      "Reschedule the meeting to 10:00 UTC on October 1.",
      [],
      "test/model",
      undefined,
      undefined,
      undefined,
      undefined,
      { accountId: "meeting:mtg_calendar", provider: "telegram", conversationId: "mtg_calendar", scope: "shared" },
      { ephemeral: true, meetingId: "mtg_calendar", meetingAppAccess: true, meetingCapabilityContext: { role: "sales", objective: "Reschedule an agreed customer meeting", subject: "Acme" }, meetingComposioAccountAliases: {}, toolAllow: ["CHUCK_MEETING_JOIN"], maxToolCalls: 8 },
    );
    assert.match(result.text, /checked availability and rescheduled/);
    const shownNames = requests[0]?.tools?.map((tool: any) => tool.function?.name) ?? [];
    assert.equal(shownNames.includes("GOOGLECALENDAR_LIST_EVENTS"), true);
    assert.equal(shownNames.includes("GOOGLECALENDAR_UPDATE_EVENT"), true);
    assert.equal(shownNames.includes("GOOGLECALENDAR_DELETE_EVENT"), false);
    assert.equal(shownNames.includes("GMAIL_SEND_EMAIL"), false);
    assert.deepEqual(executions.map(({ slug }) => slug), ["GOOGLECALENDAR_LIST_EVENTS", "GOOGLECALENDAR_UPDATE_EVENT"]);
    assert.equal(executions.every((call) => call.account === "work-calendar"), true);
  } finally { globalThis.fetch = originalFetch; }
});

test("private meeting mission discovers owner-connected HR and CRM schemas while shared meetings stay explicitly scoped", async () => {
  const userId = 830057;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  const requests: Array<Record<string, any>> = [];
  const discoveryRequests: Array<{ query: string; toolkits: string[] }> = [];
  const executions: Array<{ slug: string; args: Record<string, unknown>; account?: string }> = [];
  const schema = { type: "object", properties: { person: { type: "string" }, query: { type: "string" }, recordId: { type: "string" } }, additionalProperties: false };
  const session = {
    sessionId: "meeting-business-systems-session",
    tools: async () => [],
    search: async ({ query, toolkits }: { query: string; toolkits: string[] }) => {
      discoveryRequests.push({ query, toolkits });
      return { toolSchemas: {
        ASHBY_SEARCH_CANDIDATES: { toolSlug: "ASHBY_SEARCH_CANDIDATES", toolkit: "ashby", description: "Find the candidate record", inputSchema: schema },
        ASHBY_GET_APPLICATION: { toolSlug: "ASHBY_GET_APPLICATION", toolkit: "ashby", description: "Read application status", inputSchema: schema },
        HUBSPOT_SEARCH_CONTACTS: { toolSlug: "HUBSPOT_SEARCH_CONTACTS", toolkit: "hubspot", description: "Find the connected customer contact", inputSchema: schema },
        HUBSPOT_CREATE_NOTE: { toolSlug: "HUBSPOT_CREATE_NOTE", toolkit: "hubspot", description: "Add a meeting follow-up note", inputSchema: schema },
        GMAIL_SEND_EMAIL: { toolSlug: "GMAIL_SEND_EMAIL", toolkit: "gmail", description: "Send email", inputSchema: schema },
        ASHBY_DELETE_CANDIDATE: { toolSlug: "ASHBY_DELETE_CANDIDATE", toolkit: "ashby", description: "Delete candidate", inputSchema: schema },
        COMPOSIO_EXECUTE_TOOL: { toolSlug: "COMPOSIO_EXECUTE_TOOL", toolkit: "ashby", description: "Generic executor", inputSchema: schema },
      } };
    },
    execute: async (slug: string, args: Record<string, unknown>, options?: { account?: string }) => {
      executions.push({ slug, args, account: options?.account });
      return { successful: true, data: { record: "owner-connected record result" } };
    },
  };
  const originalFetch = globalThis.fetch;
  setAgentDependenciesForTests({ composio: {
    create: async () => session,
    connectedAccounts: { list: async () => [
      { id: "ashby-account-1", alias: "hiring", toolkit: { slug: "ashby" }, status: "ACTIVE" },
      { id: "hubspot-account-1", alias: "company-crm", toolkit: { slug: "hubspot" }, status: "ACTIVE" },
      { id: "gmail-account-1", alias: "personal-mail", toolkit: { slug: "gmail" }, status: "ACTIVE" },
    ] },
  } });
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/chat/completions")) {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? toolResponse("ASHBY_SEARCH_CANDIDATES", JSON.stringify({ person: "Amina" }), "call-1")
        : requests.length === 2
          ? toolResponse("HUBSPOT_SEARCH_CONTACTS", JSON.stringify({ query: "Amina" }), "call-2")
          : requests.length === 3
            ? toolResponse("HUBSPOT_CREATE_NOTE", JSON.stringify({ recordId: "contact-1" }), "call-3")
            : chatResponse({ role: "assistant", content: "I checked the hiring and CRM records and saved the agreed follow-up." });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await runAgent(
      userId,
      "Prepare Amina's onboarding by checking her application and CRM account, then save the agreed follow-up.",
      [],
      "test/model",
      undefined,
      undefined,
      undefined,
      undefined,
      { accountId: "meeting:mtg_business_systems", provider: "telegram", conversationId: "mtg_business_systems", scope: "shared" },
      { ephemeral: true, meetingId: "mtg_business_systems", meetingAppAccess: true, meetingCapabilityContext: { role: "custom", objective: "Prepare an accurate onboarding discussion from hiring and CRM records", subject: "Amina" }, meetingComposioAccountAliases: {}, toolAllow: ["CHUCK_MEETING_JOIN"], maxToolCalls: 8 },
    );
    assert.match(result.text, /checked the hiring and CRM records/);
    assert.deepEqual(discoveryRequests[0]?.toolkits, ["ashby", "hubspot", "gmail"]);
    assert.match(discoveryRequests[0]?.query ?? "", /onboarding/i);
    assert.match(discoveryRequests[0]?.query ?? "", /Amina/i);
    const shownNames = requests[0]?.tools?.map((tool: any) => tool.function?.name) ?? [];
    assert.equal(shownNames.includes("ASHBY_SEARCH_CANDIDATES"), true);
    assert.equal(shownNames.includes("ASHBY_GET_APPLICATION"), true);
    assert.equal(shownNames.includes("HUBSPOT_SEARCH_CONTACTS"), true);
    assert.equal(shownNames.includes("HUBSPOT_CREATE_NOTE"), true);
    assert.equal(shownNames.includes("GMAIL_SEND_EMAIL"), false);
    assert.equal(shownNames.includes("ASHBY_DELETE_CANDIDATE"), false);
    assert.equal(shownNames.includes("COMPOSIO_EXECUTE_TOOL"), false);
    assert.deepEqual(executions.map(({ slug }) => slug), ["ASHBY_SEARCH_CANDIDATES", "HUBSPOT_SEARCH_CONTACTS", "HUBSPOT_CREATE_NOTE"]);
    assert.deepEqual(executions.map(({ account }) => account), ["hiring", "company-crm", "company-crm"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("private voice turns keep the Chusky context but skip Composio setup and durable agent-run overhead", async () => {
  const userId = 830052;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  let composioCreated = 0;
  let modelMetadataLookups = 0;
  let requestBody: Record<string, any> | undefined;
  const originalFetch = globalThis.fetch;
  setAgentDependenciesForTests({ composio: { create: async () => { composioCreated++; throw new Error("voice turn must not initialize Composio"); } } });
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) modelMetadataLookups++;
    else requestBody = JSON.parse(String(init?.body));
    return chatResponse({ role: "assistant", content: "I can help with that." });
  }) as typeof fetch;
  try {
    const result = await runAgent(
      userId,
      "Can you remind me what we discussed?",
      [{ role: "user", content: "We discussed the launch plan." }],
      "test/model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { voiceTurn: true, toolAllow: ["CHUCK_LIST_REMINDERS"] },
    );
    assert.equal(result.text, "I can help with that.");
    assert.equal(composioCreated, 0);
    assert.equal(modelMetadataLookups, 0);
    assert.equal(requestBody?.messages.at(-2)?.content, "We discussed the launch plan.");
    assert.deepEqual(requestBody?.tools.map((tool: any) => tool.function.name), ["CHUCK_LIST_REMINDERS"]);
    assert.deepEqual(requestBody?.provider, {
      allow_fallbacks: true,
      preferred_max_latency: { p90: 2 },
      preferred_min_throughput: { p50: 50 },
      sort: { by: "latency", partition: "none" },
    });
    assert.equal(requestBody?.max_tokens, 192);
    assert.deepEqual(requestBody?.models, ["test/model", "google/gemini-2.5-flash"]);
    assert.equal((await listAgentRuns(userId)).length, 0);
    await assert.rejects(
      () => runAgent(userId, "place the call", [], "test/model", undefined, undefined, undefined, undefined, undefined, {
        voiceTurn: true,
        toolAllow: ["CHUCK_START_PHONE_CALL"],
      }),
      /explicit allowlist of read-only Chusky tools/,
    );
  } finally { globalThis.fetch = originalFetch; }
});

test("owner-scoped meeting contact capture executes without a spurious approval failure", async () => {
  const userId = 830051;
  const meetingId = "mtg_agent_contact_policy";
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  await updateMeetingRepresentativeProfile(userId, { enabled: true, objective: "Capture requested client follow-up details" });
  await addRecallMeeting(userId, {
    id: meetingId,
    userId,
    platform: "google_meet",
    interactionMode: "representative",
    status: "in_call",
    meetingUrlHash: "b".repeat(64),
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const originalFetch = globalThis.fetch;
  let requestIndex = 0;
  const responses = [
    toolResponse("CHUCK_MEETING_CONTACT_CAPTURE", JSON.stringify({
      participantName: "Riley Park",
      email: "riley@example.com",
      contactPreference: "email",
      interest: "Asked for a test-drive follow-up",
      nextStep: "Send available test-drive times",
    })),
    chatResponse({ role: "assistant", content: "I’ve saved Riley’s agreed follow-up details." }),
  ];
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "meeting-contact-session", tools: async () => [], execute: async () => ({}) }) } });
  globalThis.fetch = (async () => responses[requestIndex++] ?? chatResponse({ role: "assistant", content: "unexpected extra request" })) as typeof fetch;
  try {
    const result = await runAgent(
      userId,
      "Live context window. Current utterance: Please save my email for the test drive follow-up.",
      [],
      "test/model",
      undefined,
      undefined,
      undefined,
      undefined,
      { accountId: `meeting:${meetingId}`, provider: "telegram", conversationId: meetingId, scope: "shared" },
      { ephemeral: true, toolAllow: ["CHUCK_MEETING_CONTACT_CAPTURE"], meetingId, maxToolCalls: 1 },
    );
    assert.equal(result.text, "I’ve saved Riley’s agreed follow-up details.");
    assert.deepEqual(result.toolsSucceeded, ["CHUCK_MEETING_CONTACT_CAPTURE"]);
    const contacts = await nativeTool(userId, "CHUCK_MEETING_CONTACTS_LIST", {}) as Array<{ participantName: string; email?: string }>;
    assert.deepEqual(contacts.map(({ participantName, email }) => ({ participantName, email })), [{ participantName: "Riley Park", email: "riley@example.com" }]);
  } finally { globalThis.fetch = originalFetch; }
});

test("agent executes a safe tool and feeds its result into the next model round", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830002);
  const executed: any[] = [];
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", JSON.stringify({ value: 7 })),
    chatResponse({ role: "assistant", content: "tool complete" }),
  ], async (slug, args) => { executed.push({ slug, args }); return { ok: true }; }, async () => {
    const result = await runAgent(830002, "do it", [], "test/model");
    assert.equal(result.text, "tool complete");
    assert.deepEqual(executed, [{ slug: "TEST_SAFE_TOOL", args: { value: 7 } }]);
    assert.deepEqual(result.toolsUsed, ["TEST_SAFE_TOOL"]);
    assert.deepEqual(result.toolsSucceeded, ["TEST_SAFE_TOOL"]);
  });
});

test("agent distinguishes a failed tool attempt from a successful side effect", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830021);
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", JSON.stringify({ value: 7 })),
    chatResponse({ role: "assistant", content: "The action failed." }),
  ], async () => { throw new Error("provider rejected action"); }, async () => {
    const result = await runAgent(830021, "do it", [], "test/model");
    assert.deepEqual(result.toolsUsed, ["TEST_SAFE_TOOL"]);
    assert.deepEqual(result.toolsSucceeded, []);
  });
});

test("routes a direct Composio tool to the requested connected-account alias", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830016);
  const executed: any[] = [];
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", JSON.stringify({ value: 7, account: "work-gmail" })),
    chatResponse({ role: "assistant", content: "tool complete" }),
  ], async (slug, args, options) => {
    executed.push({ slug, args, options });
    return { ok: true };
  }, async () => {
    const result = await runAgent(830016, "read from work email", [], "test/model");
    assert.equal(result.text, "tool complete");
  });
  assert.deepEqual(executed, [{ slug: "TEST_SAFE_TOOL", args: { value: 7 }, options: { account: "work-gmail" } }]);
});

test("lists only safe connected-account metadata", async () => {
  setAgentDependenciesForTests({
    composio: {
      connectedAccounts: {
        list: async () => ({ items: [
          { id: "ca_work", alias: "work-gmail", toolkit: { slug: "gmail" }, status: "ACTIVE", data: { access_token: "secret" } },
          { id: "ca_personal", alias: "personal-gmail", toolkit: { slug: "gmail" }, status: "ACTIVE", data: { refresh_token: "secret" } },
        ] }),
      },
    },
  });
  const accounts = await listConnectedAccounts(830016, "gmail");
  assert.deepEqual(accounts, [
    { id: "ca_work", alias: "work-gmail", toolkit: "gmail", status: "ACTIVE", createdAt: undefined, updatedAt: undefined },
    { id: "ca_personal", alias: "personal-gmail", toolkit: "gmail", status: "ACTIVE", createdAt: undefined, updatedAt: undefined },
  ]);
  assert.equal(JSON.stringify(accounts).includes("secret"), false);
});

test("agent uses the native account boundary and hides the raw Composio account tool", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830017);
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  const session = {
    sessionId: "account-boundary-session",
    tools: async () => [{ type: "function", function: { name: "COMPOSIO_GET_CONNECTED_ACCOUNTS", parameters: { type: "object" } } }],
    execute: async () => { throw new Error("raw Composio account tool should not execute"); },
  };
  setAgentDependenciesForTests({
    composio: {
      create: async () => session,
      connectedAccounts: {
        list: async () => ({ items: [{ id: "ca_work", alias: "work-gmail", toolkit: { slug: "gmail" }, status: "ACTIVE", data: { access_token: "secret" } }] }),
      },
    },
  });
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    requests.push(body);
    return requests.length === 1
      ? toolResponse("CHUCK_LIST_CONNECTED_ACCOUNTS", JSON.stringify({ toolkit: "gmail" }))
      : chatResponse({ role: "assistant", content: "I found your connected Gmail account." });
  }) as typeof fetch;
  try {
    const result = await runAgent(830017, "Which Gmail accounts are connected?", [], "test/model");
    assert.equal(result.text, "I found your connected Gmail account.");
    const offered = (requests[0].tools as Array<any>).map((tool) => tool.function.name);
    assert.equal(offered.includes("COMPOSIO_GET_CONNECTED_ACCOUNTS"), false);
    assert.equal(offered.includes("CHUCK_LIST_CONNECTED_ACCOUNTS"), true);
    const toolMessage = requests[1].messages.find((message: any) => message.role === "tool");
    assert.deepEqual(JSON.parse(toolMessage.content), [{ id: "ca_work", alias: "work-gmail", toolkit: "gmail", status: "ACTIVE" }]);
    assert.equal(toolMessage.content.includes("secret"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("treats an empty optional connected-account toolkit filter as omitted", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830018);
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  const session = {
    sessionId: "empty-toolkit-session",
    tools: async () => [],
    execute: async () => { throw new Error("No provider tool should be executed for native account discovery"); },
  };
  setAgentDependenciesForTests({
    composio: {
      create: async () => session,
      connectedAccounts: {
        list: async (options?: { toolkitSlugs?: string[] }) => {
          assert.deepEqual(options, { userIds: ["user_830018"] });
          return { items: [{ id: "ca_gmail", alias: "work-gmail", toolkit: { slug: "gmail" }, status: "ACTIVE" }] };
        },
      },
    },
  });
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? toolResponse("CHUCK_LIST_CONNECTED_ACCOUNTS", JSON.stringify({ toolkit: "", limit: 20 }))
      : chatResponse({ role: "assistant", content: "I found your connected accounts." });
  }) as typeof fetch;
  try {
    const result = await runAgent(830018, "Which accounts are connected?", [], "test/model");
    assert.equal(result.text, "I found your connected accounts.");
    const toolMessage = requests[1].messages.find((message: any) => message.role === "tool");
    assert.deepEqual(JSON.parse(toolMessage.content), [{ id: "ca_gmail", alias: "work-gmail", toolkit: "gmail", status: "ACTIVE" }]);
  } finally { globalThis.fetch = originalFetch; }
});

test("materially risky tool calls stop before execution and approved exact calls execute once", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830003);
  let executions = 0;
  await withAgentMocks([toolResponse("GITHUB_DELETE_REPOSITORY", JSON.stringify({ owner: "acme", repo: "demo" }))], async () => { executions++; }, async () => {
    await assert.rejects(() => runAgent(830003, "send it", [], "test/model"), (error: unknown) => error instanceof ApprovalRequiredError);
    assert.equal(executions, 0);
    const approval = (await getSession(830003)).approvals[0];
    assert.equal(approval.toolSlug, "GITHUB_DELETE_REPOSITORY");
    await import("../src/store.js").then(({ setApprovalStatus }) => setApprovalStatus(830003, approval.id, "approved"));
    await withAgentMocks([
      toolResponse("GITHUB_DELETE_REPOSITORY", JSON.stringify({ owner: "acme", repo: "demo" })),
      chatResponse({ role: "assistant", content: "sent" }),
    ], async () => { executions++; }, async () => {
      const result = await runAgent(830003, approval.request, approval.history, approval.model, undefined, undefined, undefined, approval.id);
      assert.equal(result.text, "sent");
    });
    assert.equal(executions, 1);
  });
});

test("approved multi-tool calls execute the stored arguments when the model regenerates different JSON", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830014);
  const reviewedArgs = { tools: [{ tool_slug: "GITHUB_DELETE_REPOSITORY", arguments: { owner: "acme", repo: "demo" } }] };
  const regeneratedArgs = { tools: [{ tool_slug: "GITHUB_DELETE_REPOSITORY", arguments: { owner: "other", repo: "demo" } }] };
  const executed: any[] = [];
  await withAgentMocks([toolResponse("COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify(reviewedArgs))], async (slug, args) => { executed.push({ slug, args }); }, async () => {
    await assert.rejects(() => runAgent(830014, "send it", [], "test/model"), (error: unknown) => error instanceof ApprovalRequiredError);
    const approval = (await getSession(830014)).approvals[0];
    await import("../src/store.js").then(({ setApprovalStatus }) => setApprovalStatus(830014, approval.id, "approved"));
    await withAgentMocks([
      toolResponse("COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify(regeneratedArgs)),
      chatResponse({ role: "assistant", content: "sent" }),
    ], async (slug, args) => { executed.push({ slug, args }); }, async () => {
      const result = await runAgent(830014, approval.request, approval.history, approval.model, undefined, undefined, undefined, approval.id);
      assert.equal(result.text, "sent");
    }, true);
  }, true);
  assert.deepEqual(executed, [{ slug: "COMPOSIO_MULTI_EXECUTE_TOOL", args: reviewedArgs }]);
});

test("a malformed tool call is discarded without consuming the next valid tool-call budget", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830004);
  let executions = 0;
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", "not-json"),
    toolResponse("TEST_SAFE_TOOL", JSON.stringify({ value: "recovered" })),
    chatResponse({ role: "assistant", content: "recovered" }),
  ], async () => { executions++; return { ok: true }; }, async () => {
    const result = await runAgent(830004, "recover", [], "test/model", undefined, undefined, undefined, undefined, undefined, { maxToolCalls: 1 });
    assert.equal(result.text, "recovered");
    assert.equal(executions, 1);
  });
});

test("tool argument parser accepts fenced and single-quoted JSON-like objects safely", () => {
  assert.deepEqual(parseToolArguments("```json\n{'type': 'report', 'title': 'Chusky\\'s findings',}\n```"), { type: "report", title: "Chusky's findings" });
  assert.throws(() => parseToolArguments("{action: create, value: process.exit(1)}"));
});

test("tool argument parser reports truncated JSON without leaking a SyntaxError", () => {
  assert.throws(() => parseToolArguments('{"type":"report","content":"unterminated'), /malformed or truncated JSON/);
});

test("tool argument parser repairs literal newlines inside model strings", () => {
  assert.deepEqual(parseToolArguments('{"content":"line one\nline two"}'), { content: "line one\nline two" });
});

test("tool argument parser preserves Unicode and significant edge whitespace", () => {
  const value = "  Café 🧪 — line one\nline two  ";
  assert.deepEqual(parseToolArguments(JSON.stringify({ content: value })), { content: value });
  const markup = `<|DSML|tool_calls><|DSML|invoke name="TEST_SAFE_TOOL"><|DSML|parameter name="content" string="true">  ${value}  </|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`;
  const dsmlArgs = JSON.parse(parseLegacyDsmlToolCalls(markup)[0]?.function.arguments ?? "{}") as { content: string };
  assert.equal(dsmlArgs.content, `  ${value}  `);
});

test("stream parser flushes the unterminated final SSE record and preserves exact tool arguments", async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-final", type: "function", function: { name: "TEST_SAFE_TOOL", arguments: '{"value":"A ' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-final", type: "function", function: { name: "", arguments: "🧪 B" } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-final", type: "function", function: { name: "", arguments: '"}' } }] }, finish_reason: "tool_calls" }] },
  ];
  const payload = new TextEncoder().encode(`${events.slice(0, -1).map((event) => `data: ${JSON.stringify(event)}\n`).join("")}data: ${JSON.stringify(events.at(-1))}`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < payload.length;) {
        const size = [1, 2, 7, 13, 5][offset % 5]!;
        controller.enqueue(payload.slice(offset, offset + size));
        offset += size;
      }
      controller.close();
    },
  });
  const response = await readStreamingChat(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  const call = response.choices[0]?.message.tool_calls?.[0];
  assert.equal(response.choices[0]?.finish_reason, "tool_calls");
  assert.equal(call?.id, "call-final");
  assert.deepEqual(parseToolArguments(call?.function.arguments), { value: "A 🧪 B" });
});

test("stream parser rejects incomplete and provider-error streams instead of inventing a stop", async () => {
  const incomplete = new Response("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}", { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(() => readStreamingChat(incomplete), /before a terminal finish reason/);
  const providerError = new Response("data: {\"error\":{\"message\":\"private provider details\"}}", { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(() => readStreamingChat(providerError), /in-stream error/);
});

test("a partial streamed answer is not retried after text has reached the client", async () => {
  const originalFetch = globalThis.fetch;
  const originalMaxAttempts = config.openRouterMaxAttempts;
  let requests = 0;
  const deltas: string[] = [];
  config.openRouterMaxAttempts = 3;
  globalThis.fetch = (async () => {
    requests++;
    return new Response('data: {"choices":[{"delta":{"content":"visible partial"},"finish_reason":null}]}', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    await assert.rejects(() => orChat("test/model", [{ role: "user", content: "hello" }], [], undefined, (text) => { deltas.push(text); }), /terminal finish reason/);
    assert.equal(requests, 1);
    assert.deepEqual(deltas, ["visible partial"]);
  } finally {
    globalThis.fetch = originalFetch;
    config.openRouterMaxAttempts = originalMaxAttempts;
  }
});

test("schema-invalid Composio arguments are rejected before execution and corrected on the next round", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830016);
  const executed: unknown[] = [];
  const schema = { type: "object", properties: { value: { type: "string", maxLength: 40 } }, required: ["value"], additionalProperties: false };
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", "{}"),
    toolResponse("TEST_SAFE_TOOL", JSON.stringify({ value: "  Café 🧪  " })),
    chatResponse({ role: "assistant", content: "The exact value was accepted and processed." }),
  ], async (_slug, args) => { executed.push(args); return { ok: true }; }, async () => {
    const result = await runAgent(830016, "use the connected action", [], "test/model", undefined, undefined, undefined, undefined, undefined, { maxToolCalls: 1 });
    assert.match(result.text, /exact value was accepted/);
  }, false, schema);
  assert.deepEqual(executed, [{ value: "  Café 🧪  " }]);
});

test("a length-limited tool call is never executed, even when its argument prefix parses", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830017);
  let executions = 0;
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", JSON.stringify({ value: "possibly incomplete" }), "call-truncated", "length"),
    chatResponse({ role: "assistant", content: "The model response was truncated; no tool action ran." }),
  ], async () => { executions++; return { ok: true }; }, async () => {
    const result = await runAgent(830017, "do the action", [], "test/model");
    assert.match(result.text, /no tool action ran/);
    assert.equal(executions, 0);
  });
});

test("repeated provider tool-call IDs execute only once", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830009);
  let executions = 0;
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", '{"value":"one"}'),
    toolResponse("TEST_SAFE_TOOL", '{"value":"one"}'),
    chatResponse({ role: "assistant", content: "done" }),
  ], async () => { executions++; return { ok: true }; }, async () => {
    const result = await runAgent(830009, "repeat", [], "test/model");
    assert.equal(result.text, "done");
    assert.equal(executions, 1);
  });
});

test("legacy DSML tool markup is converted to a tool call and never shown to the user", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830007);
  const markup = `<|DSML|tool_calls><|DSML|invoke name="CHUCK_DAYTONA_WORKSPACE"><|DSML|parameter name="action" string="true">status</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`;
  const parsed = parseLegacyDsmlToolCalls(markup);
  assert.equal(parsed[0]?.function.name, "CHUCK_DAYTONA_WORKSPACE");
  assert.deepEqual(JSON.parse(parsed[0]?.function.arguments ?? "{}"), { action: "status" });
  assert.equal(cleanModelText(markup), "");
  await withAgentMocks([
    chatResponse({ role: "assistant", content: markup }),
    chatResponse({ role: "assistant", content: "workspace ready" }),
  ], async (slug, args) => ({ slug, args, status: "ready" }), async () => {
    const result = await runAgent(830007, "check my workspace", [], "test/model");
    assert.equal(result.text, "workspace ready");
    assert.deepEqual(result.toolsUsed, ["CHUCK_DAYTONA_WORKSPACE"]);
  });
});

test("full-width DSML from Composio multi-execute output is converted and hidden", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830008);
  const markup = `<｜DSML｜tool_calls><｜DSML｜invoke name="COMPOSIO_MULTI_EXECUTE_TOOL"><｜DSML｜parameter name="current_step" string="true">VERIFYING_LINKEDIN_POST</｜DSML｜parameter><｜DSML｜parameter name="current_step_metric" string="true">3/3</｜DSML｜parameter><｜DSML｜parameter name="session_id" string="true">both</｜DSML｜parameter><｜DSML｜parameter name="sync_response_to_workbench" string="false">false</｜DSML｜parameter><｜DSML｜parameter name="thought" string="true">Get the final result.</｜DSML｜parameter><｜DSML｜parameter name="tools" string="false">[{"arguments":{"taskId":"task-1","lastStepSeen":7},"tool_slug":"BROWSER_TOOL_WATCH_TASK"}]</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
  const parsed = parseLegacyDsmlToolCalls(markup);
  assert.equal(parsed[0]?.function.name, "COMPOSIO_MULTI_EXECUTE_TOOL");
  const parsedAgain = parseLegacyDsmlToolCalls(markup);
  assert.equal(parsedAgain[0]?.function.name, "COMPOSIO_MULTI_EXECUTE_TOOL", "a prior parse must not leave a shared global-regex cursor behind");
  assert.equal(JSON.parse(parsedAgain[0]?.function.arguments ?? "{}").current_step, "VERIFYING_LINKEDIN_POST");
  const args = JSON.parse(parsed[0]?.function.arguments ?? "{}");
  assert.equal(args.current_step, "VERIFYING_LINKEDIN_POST");
  assert.match(args.tools, /BROWSER_TOOL_WATCH_TASK/);
  assert.equal(cleanModelText(markup), "");
  await withAgentMocks([
    chatResponse({ role: "assistant", content: markup }),
    chatResponse({ role: "assistant", content: "LinkedIn verification completed." }),
  ], async (slug, receivedArgs) => ({ slug, args: receivedArgs, status: "completed" }), async () => {
    const result = await runAgent(830008, "verify the LinkedIn post", [], "test/model");
    assert.equal(result.text, "LinkedIn verification completed.");
    assert.deepEqual(result.toolsUsed, ["COMPOSIO_MULTI_EXECUTE_TOOL"]);
  }, true);
});

test("agent retries transient OpenRouter responses with a bounded retry", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830005);
  const originalFetch = globalThis.fetch;
  let chatAttempts = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    chatAttempts++;
    if (chatAttempts === 1) return new Response("temporary", { status: 503 });
    return chatResponse({ role: "assistant", content: "retried" });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "retry-session", tools: async () => [], execute: async () => undefined }) } });
  try {
    const result = await runAgent(830005, "retry", [], "test/model");
    assert.equal(result.text, "retried");
    assert.equal(chatAttempts, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("agent keeps the selected model when it accepts media despite incomplete metadata", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830006);
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    models.push(JSON.parse(String(init?.body)).model);
    return chatResponse({ role: "assistant", content: "image understood" });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "vision-session", tools: async () => [], execute: async () => undefined }) } });
  try {
    const result = await runAgent(830006, [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }], [], "test/model");
    assert.equal(result.text, "image understood");
    assert.deepEqual(models, ["test/model"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("agent falls back only after the selected model rejects the media modality", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830015);
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    if (body.model === "test/model") return new Response("No endpoints found that support image input", { status: 400 });
    return chatResponse({ role: "assistant", content: "image understood by fallback" });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "fallback-session", tools: async () => [], execute: async () => undefined }) } });
  try {
    const result = await runAgent(830015, [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }], [], "test/model");
    assert.equal(result.text, "image understood by fallback");
    // orChat retries the selected model for transient/provider failures before
    // runAgent makes the modality fallback decision.
    assert.deepEqual(models, ["test/model", "test/model", "openai/gpt-5.6-luna"]);
  } finally { globalThis.fetch = originalFetch; }
});
