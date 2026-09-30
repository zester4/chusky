import { readFile } from "node:fs/promises";
import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const imagePath = process.env.IMAGE_PATH ?? "launch.png";
const imageBytes = new Uint8Array(await readFile(imagePath));
const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-image-post",
});

const image = await chusky.files.upload(
  {
    name: imagePath,
    contentType: "image/png",
    data: imageBytes,
  },
  { idempotencyKey: "cookbook-upload-image-0001" },
);

const { thread, run } = await chusky.runs.create(
  {
    input:
      "Prepare a social post using the attached image. Verify the image is available, draft the caption, and stop before publishing.",
    attachments: [image.id],
    wait: false,
    budget: { duration: "5m", maxToolCalls: 10, maxCost: 1 },
  },
  { idempotencyKey: "cookbook-image-post-run-0001" },
);

console.log({
  fileId: image.id,
  fileStatus: image.status,
  threadId: thread.id,
  runId: run.id,
  status: run.status,
});
