import { config } from "./config.js";

export type ImageModelRole = "general" | "fast" | "premium" | "text" | "brand" | "photorealistic" | "composition";

export type ImageModelCapabilities = {
  id: string;
  name: string;
  roles: ImageModelRole[];
  maxReferences: number;
  maxOutputs: number;
  resolutions: string[];
  aspectRatios: string[];
  parameters: Set<string>;
  parameterValues?: Record<string, string[]>;
  description: string;
};

type OpenRouterImageModel = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  supported_parameters?: Record<string, { values?: unknown[]; max?: number } | unknown>;
};

const DEFAULT_ASPECT_RATIOS = ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
const DEFAULT_RESOLUTIONS = ["1K", "2K"];

const curated: ImageModelCapabilities[] = [
  { id: "meta/muse-image", name: "Muse Image", roles: ["composition", "general"], maxReferences: 10, maxOutputs: 1, resolutions: [], aspectRatios: DEFAULT_ASPECT_RATIOS, parameters: new Set(), description: "Agentic composition and editing." },
  { id: "black-forest-labs/flux-3-image", name: "FLUX.3 Image", roles: ["premium", "photorealistic"], maxReferences: 10, maxOutputs: 1, resolutions: ["768", "1K", "1.5K", "2K", "4K"], aspectRatios: ["21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2", "9:21", "auto"], parameters: new Set(["aspect_ratio", "input_references", "n", "resolution"]), description: "Premium multi-reference generation and editing." },
  { id: "openai/gpt-image-2", name: "GPT Image 2", roles: ["premium", "text", "general"], maxReferences: 16, maxOutputs: 10, resolutions: [], aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"], parameters: new Set(["aspect_ratio", "background", "input_references", "n", "quality"]), parameterValues: { quality: ["auto", "low", "medium", "high"], background: ["auto", "opaque"] }, description: "High-fidelity production generation and editing." },
  { id: "bytedance-seed/seedream-4.5", name: "Seedream 4.5", roles: ["photorealistic", "premium"], maxReferences: 14, maxOutputs: 10, resolutions: ["1K", "2K", "4K"], aspectRatios: ["1:1", "1:2", "2:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "9:19.5", "19.5:9", "9:20", "20:9", "9:21", "21:9", "auto"], parameters: new Set(["aspect_ratio", "input_references", "n", "resolution", "seed"]), description: "Consistent commercial, portrait, and product imagery." },
  { id: "recraft/recraft-v4.1-flash", name: "Recraft V4.1 Flash", roles: ["fast", "brand", "general"], maxReferences: 0, maxOutputs: 6, resolutions: ["1K"], aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "auto"], parameters: new Set(["aspect_ratio", "n"]), description: "Fast, economical visual asset generation." },
  { id: "qwen/qwen-image-3", name: "Qwen Image 3", roles: ["text", "general"], maxReferences: 4, maxOutputs: 6, resolutions: ["1K", "2K"], aspectRatios: ["1:1", "1:2", "1:4", "2:1", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "9:16", "16:9"], parameters: new Set(["aspect_ratio", "input_references", "n", "resolution", "seed"]), description: "Precise text, labels, diagrams, and detail rendering." },
  { id: "x-ai/grok-imagine-image-2.0", name: "Grok Imagine Image 2.0", roles: ["general", "fast", "photorealistic"], maxReferences: 3, maxOutputs: 1, resolutions: ["1K", "2K"], aspectRatios: ["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1"], parameters: new Set(["aspect_ratio", "input_references", "n", "quality", "resolution"]), parameterValues: { quality: ["low", "medium"] }, description: "Fast general generation and reference editing." },
  { id: "krea/krea-2-medium", name: "Krea 2 Medium", roles: ["fast", "general"], maxReferences: 1, maxOutputs: 1, resolutions: ["1K"], aspectRatios: ["1:1", "4:3", "3:2", "16:9", "4:5", "2:3", "9:16"], parameters: new Set(["aspect_ratio", "input_references", "resolution", "seed"]), description: "Cost-efficient illustration and style exploration." },
];

const curatedById = new Map(curated.map((model) => [model.id, model]));
let liveCatalog: Map<string, ImageModelCapabilities> | undefined;
let liveCatalogExpiresAt = 0;

function numberParam(value: unknown, fallback: number): number {
  if (!value || typeof value !== "object") return fallback;
  const max = (value as { max?: unknown }).max;
  return typeof max === "number" && Number.isFinite(max) ? max : fallback;
}

function valuesParam(value: unknown, fallback: string[]): string[] {
  if (!value || typeof value !== "object") return fallback;
  const values = (value as { values?: unknown }).values;
  return Array.isArray(values) && values.every((item) => typeof item === "string") ? values as string[] : fallback;
}

function mergeLive(base: ImageModelCapabilities, live: OpenRouterImageModel): ImageModelCapabilities {
  const params = live.supported_parameters ?? {};
  const parameterValues = { ...(base.parameterValues ?? {}) };
  for (const [key, value] of Object.entries(params)) {
    const values = (value as { values?: unknown } | undefined)?.values;
    if (Array.isArray(values) && values.every((item) => typeof item === "string")) parameterValues[key] = values as string[];
  }
  return {
    ...base,
    name: typeof live.name === "string" ? live.name : base.name,
    description: typeof live.description === "string" ? live.description : base.description,
    maxReferences: numberParam(params.input_references, base.maxReferences),
    maxOutputs: numberParam(params.n, base.maxOutputs),
    resolutions: valuesParam(params.resolution, base.resolutions),
    aspectRatios: valuesParam(params.aspect_ratio, base.aspectRatios),
    parameters: new Set(Object.keys(params).length ? Object.keys(params) : base.parameters),
    parameterValues,
  };
}

async function loadLiveCatalog(signal?: AbortSignal): Promise<Map<string, ImageModelCapabilities>> {
  if (liveCatalog && liveCatalogExpiresAt > Date.now()) return liveCatalog;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/images/models", {
      headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
      signal,
    });
    if (!response.ok) throw new Error(`image model catalog ${response.status}`);
    const body = await response.json() as { data?: OpenRouterImageModel[] };
    const next = new Map<string, ImageModelCapabilities>();
    for (const entry of body.data ?? []) {
      if (typeof entry.id !== "string") continue;
      const base = curatedById.get(entry.id);
      if (base) next.set(entry.id, mergeLive(base, entry));
    }
    if (next.size) {
      liveCatalog = next;
      liveCatalogExpiresAt = Date.now() + 15 * 60_000;
    }
    return next;
  } catch {
    return liveCatalog ?? new Map(curated.map((model) => [model.id, model]));
  }
}

export function curatedImageModels(): ImageModelCapabilities[] {
  return curated.map((model) => ({ ...model, parameters: new Set(model.parameters) }));
}

export async function listImageModels(signal?: AbortSignal): Promise<Array<Omit<ImageModelCapabilities, "parameters"> & { parameters: string[] }>> {
  const catalog = await loadLiveCatalog(signal);
  return Array.from(catalog.values()).map((model) => ({
    ...model,
    parameters: Array.from(model.parameters).sort(),
    parameterValues: model.parameterValues ? Object.fromEntries(Object.entries(model.parameterValues).map(([key, values]) => [key, [...values]])) : undefined,
  }));
}

export function chooseImageModel(prompt: string, options: { preferredModel?: string; references?: number; count?: number; resolution?: string; outputFormat?: string } = {}): string {
  const preferred = options.preferredModel?.trim();
  if (preferred && preferred.toLowerCase() !== "auto") return preferred;
  const textHeavy = /(?:text|typography|label|signage|poster|menu|diagram|infographic|logo|wordmark|lettering)/i.test(prompt);
  const brand = /(?:logo|icon|vector|svg|brand mark|illustration)/i.test(prompt) || options.outputFormat === "svg";
  const premium = options.resolution === "4K" || (options.references ?? 0) > 8;
  const production = /(?:high[- ]fidelity|production[- ]ready|premium asset|campaign asset|hero asset|commercial asset|exact edit|photorealistic product)/i.test(prompt);
  const fast = /(?:quick|fast|rapid|thumbnail|draft|variant|explore|concept)/i.test(prompt);
  if (brand) return "recraft/recraft-v4.1-flash";
  if (textHeavy) return "qwen/qwen-image-3";
  if (production && options.resolution !== "4K") return "openai/gpt-image-2";
  if (premium) return "black-forest-labs/flux-3-image";
  if ((options.references ?? 0) > 3) return "bytedance-seed/seedream-4.5";
  if (fast || (options.count ?? 1) > 1) return "recraft/recraft-v4.1-flash";
  return "x-ai/grok-imagine-image-2.0";
}

export async function resolveImageModel(prompt: string, options: { preferredModel?: string; references?: number; count?: number; resolution?: string; outputFormat?: string; signal?: AbortSignal } = {}): Promise<ImageModelCapabilities> {
  const id = chooseImageModel(prompt, options);
  const catalog = await loadLiveCatalog(options.signal);
  return catalog.get(id) ?? curatedById.get(id) ?? {
    id,
    name: id,
    roles: ["general"],
    maxReferences: 10,
    maxOutputs: 1,
    resolutions: DEFAULT_RESOLUTIONS,
    aspectRatios: DEFAULT_ASPECT_RATIOS,
    parameters: new Set(["aspect_ratio", "input_references", "n", "resolution", "quality", "output_format", "background", "seed"]),
    description: "User-selected OpenRouter image model.",
  };
}
