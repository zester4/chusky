import test from "node:test";
import assert from "node:assert/strict";
import { normalizeVideoDestination, resolveVideoWorkspacePath, videoDownloadUrl, videoPollingUrl } from "../src/video.js";

test("Telegram video delivery ignores an accidental Daytona path", () => {
  assert.equal(normalizeVideoDestination(undefined), "telegram");
  assert.equal(resolveVideoWorkspacePath("telegram", "/home/user/resume.html"), undefined);
});

test("Daytona video destinations accept workspace-relative paths only", () => {
  assert.equal(resolveVideoWorkspacePath("both", "/home/user/generated/video.mp4"), "generated/video.mp4");
  assert.throws(() => resolveVideoWorkspacePath("daytona", "C:\\Users\\user\\video.mp4"), /workspace-relative/);
});

test("video polling uses OpenRouter's returned polling URL", () => {
  assert.equal(videoPollingUrl({ polling_url: "/api/v1/videos/job-1" }, "job-1"), "https://openrouter.ai/api/v1/videos/job-1");
  assert.equal(videoPollingUrl({}, "job-1"), "https://openrouter.ai/api/v1/videos/job-1");
});

test("video download supports unsigned URLs and the content fallback", () => {
  assert.deepEqual(videoDownloadUrl({ unsigned_urls: ["https://storage.example/video.mp4"] }, "job-1"), { url: "https://storage.example/video.mp4", authenticated: false });
  assert.deepEqual(videoDownloadUrl({}, "job-1"), { url: "https://openrouter.ai/api/v1/videos/job-1/content?index=0", authenticated: true });
});
