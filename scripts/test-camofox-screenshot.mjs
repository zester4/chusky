/**
 * Capture and validate a real Camofox screenshot.
 * Run: node scripts/test-camofox-screenshot.mjs [output-image-path]
 *
 * Without an output path, the temporary screenshot is removed after checking.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { ACCESS_KEY, BASE } from "./camofox-config.mjs";

const userId = `thinky-screenshot-test-${randomUUID()}`;
const sessionKey = `screenshot-test-${randomUUID()}`;
const requestedOutput = process.argv[2] ? resolve(process.argv[2]) : undefined;
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "chusky-camofox-"));
const outputPath = requestedOutput ?? resolve(temporaryDirectory, "screenshot");
let tabId;
let requestFailed = false;

async function request(path, { method = "GET", body, ownerId } = {}) {
  const url = new URL(path, BASE);
  if (ownerId) url.searchParams.set("userId", ownerId);

  const response = await fetch(url, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: {
      Accept: "application/json, image/png, image/jpeg, image/webp",
      ...(body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${ACCESS_KEY}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Camofox returned HTTP ${response.status} for ${path}.`);
  }
  return response;
}

function extensionForMimeType(mimeType) {
  return {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
  }[mimeType];
}

function verifyImage(bytes, mimeType) {
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
  if (
    (mimeType === "image/png" && !png) ||
    (mimeType === "image/jpeg" && !jpeg) ||
    (mimeType === "image/webp" && !webp)
  ) {
    throw new Error(`Screenshot bytes do not match the declared ${mimeType} content type.`);
  }
}

async function cleanup() {
  if (tabId) {
    try {
      const response = await request(`/tabs/${encodeURIComponent(tabId)}`, {
        method: "DELETE",
        ownerId: userId,
      });
      await response.body?.cancel();
      console.log("Temporary tab closed.");
    } catch (error) {
      console.error(`Could not close temporary tab: ${error.message}`);
      requestFailed = true;
    }
  }

  try {
    const response = await request(`/sessions/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
    await response.body?.cancel();
    console.log("Temporary session deleted.");
  } catch (error) {
    console.error(`Could not delete temporary session: ${error.message}`);
    requestFailed = true;
  }
}

try {
  console.log("Opening a temporary example.com tab...");
  const openResponse = await request("/tabs", {
    method: "POST",
    ownerId: userId,
    body: {
      userId,
      sessionKey,
      url: "https://example.com/",
    },
  });
  const tab = await openResponse.json();
  tabId = tab?.tabId;
  if (typeof tabId !== "string" || tabId.length === 0) {
    throw new Error("Camofox did not return a tab ID.");
  }

  console.log("Requesting a screenshot...");
  const screenshotResponse = await request(
    `/tabs/${encodeURIComponent(tabId)}/screenshot`,
    { ownerId: userId },
  );
  const mimeType = screenshotResponse.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const extension = extensionForMimeType(mimeType);
  if (!extension) {
    throw new Error(`Unsupported screenshot content type: ${mimeType ?? "missing"}.`);
  }

  const bytes = Buffer.from(await screenshotResponse.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) {
    throw new Error(`Screenshot size is outside the supported range: ${bytes.length} bytes.`);
  }
  verifyImage(bytes, mimeType);

  const savedPath = requestedOutput
    ? outputPath.endsWith(extension) ? outputPath : `${outputPath}${extension}`
    : `${outputPath}${extension}`;
  if (requestedOutput) {
    await mkdir(dirname(savedPath), { recursive: true });
  }
  await writeFile(savedPath, bytes, { flag: "wx" });
  console.log(`Valid ${mimeType} screenshot received (${bytes.length} bytes).`);
  if (requestedOutput) {
    console.log(`Saved screenshot: ${savedPath}`);
  } else {
    console.log("Screenshot signature is valid; temporary image will be removed after the test.");
  }
} catch (error) {
  requestFailed = true;
  console.error(`Screenshot test failed: ${error.message}`);
} finally {
  await cleanup();
  if (!requestedOutput) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (requestFailed) {
  process.exitCode = 1;
}