import { config } from "../../config.js";
import { chunkText } from "./chunker.js";
import { UpstashKnowledgeStore } from "./vector.js";

const MAX_EXTRACTION_BYTES = 20 * 1024 * 1024;

export async function indexExtractedDocument(input: { userId: string; documentId: string; filename: string; contentType: string; text: string; sourceType?: string; projectId?: string }): Promise<number> {
  const chunks = chunkText(input.text).map((chunk) => ({ id: `${input.documentId}:${chunk.id}`, data: chunk.text, metadata: { userId: input.userId, projectId: input.projectId, documentId: input.documentId, sourceType: input.sourceType ?? "upload", contentType: input.contentType, filename: input.filename, chunkIndex: chunk.chunkIndex, visibility: input.projectId ? "project" as const : "private" as const } }));
  await new UpstashKnowledgeStore().upsert(chunks);
  return chunks.length;
}

/**
 * Extracts bounded media through the same preferred model selected for the
 * user's turn. The configured vision model is a capability fallback only; it
 * must not silently replace a model that already accepts the media modality.
 */
export async function extractMediaText(bytes: Uint8Array, filename: string, contentType: string, preferredModel = config.visionModel): Promise<string> {
  if (bytes.byteLength > MAX_EXTRACTION_BYTES) throw new Error("PDF exceeds the extraction limit");
  const isImage = contentType.startsWith("image/");
  const content = isImage
    ? [{ type: "text", text: "Describe this image factually for searchable knowledge. Include visible text, names, dates, and important details. Return only the description." }, { type: "image_url", image_url: { url: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}` } }]
    : [{ type: "text", text: "Extract the document text faithfully. Return only the extracted text, preserving headings and lists. Do not summarize." }, { type: "file", file: { filename, file_data: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}` } }];
  const candidates = [preferredModel.trim(), ...(preferredModel.trim() !== config.visionModel ? [config.visionModel] : [])].filter(Boolean);
  let lastError = "OpenRouter document extraction failed";
  for (const model of candidates) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${config.openRouterApiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content }], temperature: 0 }) });
    const raw = await response.text();
    if (!response.ok) {
      const providerError = raw.replace(/\s+/g, " ").trim().slice(0, 300);
      lastError = `OpenRouter document extraction failed (${response.status})${providerError ? `: ${providerError}` : ""}`;
      const modalityRejected = /no endpoints found that support/i.test(raw);
      if (modalityRejected && model !== config.visionModel) continue;
      throw new Error(lastError);
    }
    let body: { choices?: Array<{ message?: { content?: string } }> } = {};
    try { body = JSON.parse(raw) as typeof body; } catch { throw new Error("OpenRouter returned invalid extraction output"); }
    const text = body.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) throw new Error("OpenRouter returned no extracted document text");
    return text;
  }
  throw new Error(lastError);
}

export const extractPdfText = (bytes: Uint8Array, filename: string) => extractMediaText(bytes, filename, "application/pdf");
