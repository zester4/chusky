import { createClient } from "./_client.js";

const chusky = createClient();
const content = "customer_id,renewal_date\n123,2026-10-01\n";
const body = new TextEncoder().encode(content);

const upload = await chusky.files.create(
  { name: "renewals.csv", contentType: "text/csv", size: body.byteLength },
  { idempotencyKey: "upload-renewals-csv-v1" },
);

const response = await fetch(upload.uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": "text/csv" },
  body,
});
if (!response.ok) throw new Error(`Upload failed with HTTP ${response.status}.`);

const file = await chusky.files.complete(
  upload.id,
  { idempotencyKey: `complete-upload:${upload.id}` },
);
console.log({ id: file.id, name: file.name, status: file.status });
