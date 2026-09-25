export interface BridgeFile {
  name: string;
  contentType: string;
  data: Buffer;
}

type PropertySchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, PropertySchema>;
  items?: PropertySchema;
};

const FILE_CONTAINERS = ["file", "files", "attachment", "attachments"];
const DATA_NAMES = new Set(["file_data", "file_content", "content_bytes", "contentbytes", "base64", "data_base64", "content_base64", "bytes_base64"]);
const FILE_NAME_NAMES = new Set(["name", "filename", "file_name", "fileName".toLowerCase()]);
const MIME_NAMES = new Set(["mime_type", "mimetype", "content_type", "contenttype"]);
const MAX_BRIDGE_BYTES = 25 * 1024 * 1024;

function isObjectSchema(value: PropertySchema | undefined): value is PropertySchema {
  return Boolean(value && (value.type === "object" || value.properties));
}

function findProperty(properties: Record<string, PropertySchema>, names: Set<string>): string | undefined {
  return Object.keys(properties).find((key) => names.has(key.toLowerCase()));
}

function findDataProperty(properties: Record<string, PropertySchema>): string | undefined {
  return Object.keys(properties).find((key) => {
    const property = properties[key]!;
    return property.type === "string" && (DATA_NAMES.has(key.toLowerCase()) || /\b(base64|binary|encoded file bytes)\b/i.test(property.description ?? ""));
  });
}

function makeFileObject(schema: PropertySchema, file: BridgeFile): Record<string, string> | undefined {
  if (!isObjectSchema(schema)) return undefined;
  const properties = schema.properties ?? {};
  const dataKey = findDataProperty(properties);
  if (!dataKey) return undefined;
  const value: Record<string, string> = { [dataKey]: file.data.toString("base64") };
  const nameKey = findProperty(properties, FILE_NAME_NAMES);
  const mimeKey = findProperty(properties, MIME_NAMES);
  if (nameKey) value[nameKey] = file.name;
  if (mimeKey) value[mimeKey] = file.contentType;
  return value;
}

/**
 * Add one owner-owned artifact to an exact Composio upload action, using only
 * binary fields explicitly identified by that action's advertised JSON schema.
 * It intentionally refuses file paths, arbitrary URLs, and ambiguous `content`
 * fields because those are not safe or portable upload contracts.
 */
export function buildArtifactUploadArguments(inputSchema: unknown, actionArguments: Record<string, unknown>, file: BridgeFile): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) throw new Error("The selected app upload action has no usable argument schema.");
  if (!actionArguments || typeof actionArguments !== "object" || Array.isArray(actionArguments)) throw new Error("arguments must be an object matching the selected app action.");
  if (!Buffer.isBuffer(file.data) || file.data.length === 0 || file.data.length > MAX_BRIDGE_BYTES) throw new Error("The artifact must contain 1 byte to 25 MB.");
  const schema = inputSchema as PropertySchema;
  const properties = schema.properties ?? {};
  const containers: Array<{ key: string; property: PropertySchema; value: unknown }> = [];
  for (const key of FILE_CONTAINERS) {
    const property = properties[key];
    if (!property) continue;
    const itemSchema = property.type === "array" ? property.items : property;
    const shaped = itemSchema ? makeFileObject(itemSchema, file) : undefined;
    if (shaped) containers.push({ key, property, value: property.type === "array" ? [shaped] : shaped });
  }
  if (containers.length > 1) throw new Error("The advertised app action has multiple possible file containers; choose an unambiguous upload action.");
  let additions: Record<string, unknown>;
  if (containers.length === 1) {
    additions = { [containers[0]!.key]: containers[0]!.value };
  } else {
    const dataKeys = Object.keys(properties).filter((key) => findDataProperty({ [key]: properties[key]! }) === key);
    if (dataKeys.length !== 1) throw new Error("The advertised app action has no unambiguous schema-declared binary upload field; choose a supported upload action.");
    const additionsForUpload: Record<string, unknown> = { [dataKeys[0]!]: file.data.toString("base64") };
    const nameKey = findProperty(properties, FILE_NAME_NAMES);
    const mimeKey = findProperty(properties, MIME_NAMES);
    if (nameKey) additionsForUpload[nameKey] = file.name;
    if (mimeKey) additionsForUpload[mimeKey] = file.contentType;
    additions = additionsForUpload;
  }
  const result = { ...actionArguments };
  for (const [key, value] of Object.entries(additions)) {
    if (Object.hasOwn(result, key)) throw new Error(`Do not supply ${key}; Chusky fills it from the owner-owned artifact after approval.`);
    result[key] = value;
  }
  return result;
}
