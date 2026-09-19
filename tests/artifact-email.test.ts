import assert from "node:assert/strict";
import test from "node:test";
import { buildArtifactEmailArguments } from "../src/artifactEmail.js";

const file = {
  artifactId: "art_123",
  name: "proposal.pdf",
  contentType: "application/pdf",
  data: Buffer.from("pdf-bytes"),
};

test("maps an artifact into a Gmail-style attachment field without changing email arguments", () => {
  const result = buildArtifactEmailArguments({
    function: { parameters: { properties: { attachment: { type: "array", items: { type: "object", properties: { file_name: { type: "string" }, file_data: { type: "string" }, mime_type: { type: "string" } } } } } } },
  }, { recipient_email: "client@example.com", subject: "Proposal", body: "Attached." }, [file]);

  assert.deepEqual(result, {
    recipient_email: "client@example.com",
    subject: "Proposal",
    body: "Attached.",
    attachment: [{ file_name: "proposal.pdf", file_data: Buffer.from("pdf-bytes").toString("base64"), mime_type: "application/pdf" }],
  });
});

test("supports an Outlook-style attachments array and preserves existing attachments", () => {
  const result = buildArtifactEmailArguments({
    function: { parameters: { properties: { attachments: { type: "array", items: { type: "object", properties: { filename: { type: "string" }, contentBytes: { type: "string" }, contentType: { type: "string" } } } } } } },
  }, { to: "client@example.com", attachments: [{ filename: "existing.txt" }] }, [file]);

  assert.deepEqual(result.attachments, [
    { filename: "existing.txt" },
    { filename: "proposal.pdf", contentBytes: Buffer.from("pdf-bytes").toString("base64"), contentType: "application/pdf" },
  ]);
});

test("fails closed when the selected email action has no attachment field", () => {
  assert.throws(
    () => buildArtifactEmailArguments({ function: { parameters: { properties: { recipient_email: { type: "string" } } } } }, { recipient_email: "client@example.com" }, [file]),
    /does not expose a supported attachment field/,
  );
});

