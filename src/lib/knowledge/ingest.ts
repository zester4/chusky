import { config } from "../../config.js";
import { chunkText } from "./chunker.js";
import { UpstashKnowledgeStore } from "./vector.js";

const MAX_EXTRACTION_BYTES = 20 * 1024 * 1024;

export async function indexExtractedDocument(input: { userId: string; documentId: string; filename: string; contentType: string; text: string; sourceType?: string; projectId?: string }): Promise<number> {
  const chunks = chunkText(input.text).map((chunk) => ({ id: `${input.documentId}:${chunk.id}`, data: chunk.text, metadata: { userId: input.userId, projectId: input.projectId, documentId: input.documentId, sourceType: input.sourceType ?? "upload", contentType: input.contentType, filename: input.filename, chunkIndex: chunk.chunkIndex, visibility: input.projectId ? "project" as const : "private" as const } }));
  await new UpstashKnowledgeStore().upsert(chunks);
  return chunks.length;
}

/** Extracts a bounded PDF through the already configured OpenRouter multimodal path. */
export async function extractMediaText(bytes: Uint8Array, filename: string, contentType: string): Promise<string> {
  if (bytes.byteLength > MAX_EXTRACTION_BYTES) throw new Error("PDF exceeds the extraction limit");
  const isImage = contentType.startsWith("image/");
  const content = isImage
    ? [{ type: "text", text: "Describe this image factually for searchable knowledge. Include visible text, names, dates, and important details. Return only the description." }, { type: "image_url", image_url: { url: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}` } }]
    : [{ type: "text", text: "Extract the document text faithfully. Return only the extracted text, preserving headings and lists. Do not summarize." }, { type: "file", file: { filename, file_data: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}` } }];
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${config.openRouterApiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: config.visionModel, messages: [{ role: "user", content }], temperature: 0 }) });
  if (!response.ok) throw new Error(`OpenRouter document extraction failed (${response.status})`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("OpenRouter returned no extracted document text");
  return text;
}

export const extractPdfText = (bytes: Uint8Array, filename: string) => extractMediaText(bytes, filename, "application/pdf");
