export interface ArtifactEmailFile {
  data: Buffer;
  name: string;
  contentType: string;
  artifactId: string;
}

interface SchemaProperty {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
}

interface EmailToolSchema {
  function?: {
    parameters?: {
      properties?: Record<string, SchemaProperty>;
    };
  };
}

const ATTACHMENT_FIELDS = ["attachments", "attachment", "files", "file"];
const NAME_FIELDS = ["file_name", "filename", "name", "fileName"];
const DATA_FIELDS = ["file_data", "data", "content", "base64", "content_bytes", "contentBytes"];
const MIME_FIELDS = ["mime_type", "mimeType", "content_type", "contentType", "type"];
const MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function firstMatchingField(properties: Record<string, SchemaProperty>, candidates: string[]): string | undefined {
  const lower = new Map(Object.keys(properties).map((key) => [key.toLowerCase(), key]));
  for (const candidate of candidates) {
    const exact = lower.get(candidate.toLowerCase());
    if (exact) return exact;
  }
  return undefined;
}

function attachmentField(schema: EmailToolSchema): { name: string; property: SchemaProperty } {
  const properties = schema.function?.parameters?.properties ?? {};
  const name = firstMatchingField(properties, ATTACHMENT_FIELDS);
  if (!name) throw new Error("The selected email action does not expose a supported attachment field.");
  return { name, property: properties[name] ?? {} };
}

function attachmentObject(file: ArtifactEmailFile, itemSchema: SchemaProperty | undefined): Record<string, string> {
  const properties = itemSchema?.properties ?? {};
  const nameField = firstMatchingField(properties, NAME_FIELDS) ?? "file_name";
  const dataField = firstMatchingField(properties, DATA_FIELDS) ?? "file_data";
  const mimeField = firstMatchingField(properties, MIME_FIELDS);
  const value: Record<string, string> = {
    [nameField]: file.name,
    [dataField]: file.data.toString("base64"),
  };
  if (mimeField) value[mimeField] = file.contentType;
  return value;
}

/**
 * Add generated artifacts to an exact Composio email action without exposing
 * their bytes to the model, the run transcript, or audit logs. Composio email
 * actions differ slightly between providers, so the attachment field and
 * nested property names come from the action schema returned by Composio.
 */
export function buildArtifactEmailArguments(
  schema: EmailToolSchema,
  emailArguments: Record<string, unknown>,
  files: ArtifactEmailFile[],
): Record<string, unknown> {
  if (!files.length) throw new Error("At least one generated artifact is required.");
  const totalBytes = files.reduce((total, file) => total + file.data.byteLength, 0);
  if (files.some((file) => file.data.byteLength > MAX_EMAIL_ATTACHMENT_BYTES) || totalBytes > MAX_EMAIL_ATTACHMENT_BYTES) {
    throw new Error("The generated email attachment(s) exceed the supported 25 MB total size.");
  }
  const field = attachmentField(schema);
  const itemSchema = field.property.type === "array" ? field.property.items : field.property;
  const values = files.map((file) => attachmentObject(file, itemSchema));
  const existing = emailArguments[field.name];
  let attachmentValue: unknown;
  if (field.property.type === "array" || existing === undefined) {
    const previous = Array.isArray(existing) ? existing : existing === undefined ? [] : [existing];
    attachmentValue = [...previous, ...values];
  } else if (field.property.type === "object") {
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      attachmentValue = [existing, ...values];
    } else {
      attachmentValue = values[0];
    }
  } else {
    throw new Error(`The selected email action exposes ${field.name} in an unsupported format.`);
  }
  return { ...emailArguments, [field.name]: attachmentValue };
}
