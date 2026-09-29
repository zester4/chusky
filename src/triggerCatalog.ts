/**
 * Small, provider-backed catalogue for trigger pickers.  The catalogue is
 * shared by Telegram and the developer API, so neither surface needs a
 * hard-coded list of Composio trigger slugs.
 */
export interface TriggerCatalogueClient {
  listTypes(query?: { cursor?: string; limit?: number; toolkits?: string[] }): Promise<{
    items: Array<{
      slug: string;
      name: string;
      description: string;
      instructions?: string;
      toolkit: { slug: string; name: string; logo?: string };
      config: Record<string, unknown>;
    }>;
    nextCursor?: string | null;
  }>;
}

type RawTriggerType = Awaited<ReturnType<TriggerCatalogueClient["listTypes"]>>["items"][number];

export interface TriggerCatalogueItem {
  token: string;
  slug: string;
  name: string;
  description: string;
  instructions?: string;
  toolkit: { slug: string; name: string; logo?: string };
  config: Record<string, unknown>;
}

export interface TriggerToolkit {
  slug: string;
  name: string;
  logo?: string;
  triggerCount: number;
}

const CACHE_TTL_MS = 10 * 60_000;
let cache: { expiresAt: number; items: TriggerCatalogueItem[] } | undefined;

function tokenFor(slug: string): string {
  // Stable compact callback data. It is an identifier, not an authorization
  // secret; callers still validate the signed-in user's connected account.
  let hash = 2166136261;
  for (const char of slug) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalize(raw: RawTriggerType): TriggerCatalogueItem {
  return {
    token: tokenFor(raw.slug), slug: raw.slug, name: raw.name, description: raw.description,
    instructions: raw.instructions, toolkit: raw.toolkit, config: raw.config ?? {},
  };
}

export async function listTriggerCatalogue(client: TriggerCatalogueClient): Promise<TriggerCatalogueItem[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.items;
  const items: TriggerCatalogueItem[] = [];
  let cursor: string | undefined;
  // Composio currently has hundreds of trigger types. Paginate instead of
  // assuming a single response, but keep a hard ceiling against bad cursors.
  for (let page = 0; page < 30; page += 1) {
    const result = await client.listTypes({ limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...result.items.map(normalize));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  const unique = [...new Map(items.map((item) => [item.slug, item])).values()]
    .sort((a, b) => a.toolkit.name.localeCompare(b.toolkit.name) || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  cache = { expiresAt: Date.now() + CACHE_TTL_MS, items: unique };
  return unique;
}

export async function listTriggerToolkits(client: TriggerCatalogueClient): Promise<TriggerToolkit[]> {
  const grouped = new Map<string, TriggerToolkit>();
  for (const item of await listTriggerCatalogue(client)) {
    const key = item.toolkit.slug.toLowerCase();
    const previous = grouped.get(key);
    grouped.set(key, previous
      ? { ...previous, triggerCount: previous.triggerCount + 1 }
      : { slug: item.toolkit.slug, name: item.toolkit.name, logo: item.toolkit.logo, triggerCount: 1 });
  }
  return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

export async function listTriggerTypesForToolkit(client: TriggerCatalogueClient, toolkit: string): Promise<TriggerCatalogueItem[]> {
  const normalized = toolkit.toLowerCase();
  return (await listTriggerCatalogue(client)).filter((item) => item.toolkit.slug.toLowerCase() === normalized);
}

export async function getTriggerTypeByToken(client: TriggerCatalogueClient, token: string): Promise<TriggerCatalogueItem | undefined> {
  return (await listTriggerCatalogue(client)).find((item) => item.token === token);
}

export async function getTriggerTypeBySlug(client: TriggerCatalogueClient, slug: string): Promise<TriggerCatalogueItem | undefined> {
  const exactSlug = slug.trim();
  return exactSlug ? (await listTriggerCatalogue(client)).find((item) => item.slug === exactSlug) : undefined;
}

export function requiredTriggerConfigFields(config: Record<string, unknown>): string[] {
  const required = Array.isArray(config.required) ? config.required.filter((field): field is string => typeof field === "string") : [];
  return [...new Set(required)].slice(0, 20);
}

/** A bounded, credential-safe view of provider configuration requirements for the agent. */
export function triggerTypeForAgent(item: TriggerCatalogueItem): Record<string, unknown> {
  const properties = item.config.properties && typeof item.config.properties === "object" && !Array.isArray(item.config.properties)
    ? item.config.properties as Record<string, unknown>
    : {};
  const required = new Set(requiredTriggerConfigFields(item.config));
  const names = [...new Set([...Object.keys(properties), ...required])].slice(0, 40);
  const fields = names.map((name) => {
    const raw = properties[name] && typeof properties[name] === "object" && !Array.isArray(properties[name])
      ? properties[name] as Record<string, unknown>
      : {};
    const sensitive = /(token|secret|password|authorization|credential|private[_-]?key|api[_-]?key)/i.test(name);
    if (sensitive) return { name, required: required.has(name), sensitive: true };
    const options = Array.isArray(raw.enum)
      ? raw.enum.filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value)).slice(0, 20)
      : undefined;
    return {
      name,
      required: required.has(name),
      ...(typeof raw.type === "string" ? { type: raw.type.slice(0, 40) } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description.slice(0, 300) } : {}),
      ...(options?.length ? { allowedValues: options } : {}),
      ...(Number.isFinite(raw.maxLength) ? { maxLength: raw.maxLength } : {}),
      ...(Number.isFinite(raw.minLength) ? { minLength: raw.minLength } : {}),
    };
  });
  return {
    slug: item.slug,
    name: item.name.slice(0, 160),
    description: item.description.slice(0, 500),
    toolkit: { slug: item.toolkit.slug, name: item.toolkit.name.slice(0, 100) },
    ...(item.instructions ? { setupInstructions: item.instructions.slice(0, 800) } : {}),
    requiredFields: [...required],
    fields,
  };
}

/** Test seam: production refreshes the catalogue naturally after ten minutes. */
export function resetTriggerCatalogueForTests(): void { cache = undefined; }
