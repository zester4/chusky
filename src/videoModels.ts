import { config } from "./config.js";

export type VideoModel = {
  id: string;
  name: string;
  roles: string[];
  description: string;
  durations: number[];
  resolutions: string[];
  aspectRatios: string[];
  sizes: string[];
  frameTypes: string[];
  supportsAudio: boolean;
  supportsSeed: boolean;
  passthrough: string[];
};

type LiveVideoModel = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  supported_durations?: unknown;
  supported_resolutions?: unknown;
  supported_aspect_ratios?: unknown;
  supported_sizes?: unknown;
  supported_frame_images?: unknown;
  generate_audio?: unknown;
  seed?: unknown;
  allowed_passthrough_parameters?: unknown;
};

const curated: VideoModel[] = [
  { id: "bytedance/seedance-2.0", name: "Seedance 2.0", roles: ["general", "consistency", "4k"], description: "Strong character consistency, first/last frames, references, and 4K options.", durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ["480p", "720p", "1080p", "4K"], aspectRatios: ["1:1", "3:4", "9:16", "4:3", "16:9", "21:9", "9:21"], sizes: [], frameTypes: ["first_frame", "last_frame"], supportsAudio: true, supportsSeed: true, passthrough: ["watermark", "req_key"] },
  { id: "alibaba/wan-3.0", name: "Wan 3.0", roles: ["long", "general", "storytelling"], description: "Broad 2–30 second generation with 1080p output and reference guidance.", durations: Array.from({ length: 29 }, (_, index) => index + 2), resolutions: ["480p", "720p", "1080p"], aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16"], sizes: [], frameTypes: ["first_frame"], supportsAudio: true, supportsSeed: true, passthrough: [] },
  { id: "minimax/hailuo-3", name: "Hailuo 3", roles: ["text", "editing", "2k"], description: "Controlled multimodal editing, text and brand rendering, and 2K output.", durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ["2K"], aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], sizes: [], frameTypes: ["first_frame", "last_frame"], supportsAudio: true, supportsSeed: false, passthrough: ["aigc_watermark"] },
  { id: "black-forest-labs/flux-3-video", name: "FLUX.3 Video", roles: ["premium", "continuation", "keyframes"], description: "Premium controlled generation with opening/closing keyframes and continuation workflows.", durations: Array.from({ length: 16 }, (_, index) => index + 5), resolutions: ["720p", "1080p"], aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], sizes: [], frameTypes: ["first_frame", "last_frame"], supportsAudio: true, supportsSeed: false, passthrough: ["safety_tolerance", "version"] },
  { id: "heygen/heygen-video-1", name: "HeyGen Video", roles: ["avatar", "presenter", "dialogue"], description: "Presenter and avatar-oriented clips with synthesized spoken or ambient audio workflows.", durations: Array.from({ length: 11 }, (_, index) => index + 5), resolutions: ["480p", "768p"], aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], sizes: [], frameTypes: ["first_frame"], supportsAudio: false, supportsSeed: true, passthrough: [] },
  { id: "google/veo-3.1", name: "Veo 3.1", roles: ["premium", "audio", "4k", "cinematic"], description: "High-fidelity production video with synchronized native audio and 4K options.", durations: [4, 6, 8], resolutions: ["720p", "1080p", "4K"], aspectRatios: ["16:9", "9:16"], sizes: ["1280x720", "1080x1920", "1920x1080", "720x1280", "3840x2160", "2160x3840"], frameTypes: ["first_frame", "last_frame"], supportsAudio: true, supportsSeed: true, passthrough: ["personGeneration", "aspectRatio", "negativePrompt", "conditioningScale", "enhancePrompt"] },
];

const byId = new Map(curated.map((model) => [model.id, model]));
let live: Map<string, VideoModel> | undefined;
let expiresAt = 0;

function arrayOf<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? value.filter((item): item is T => typeof item === typeof fallback[0]) : fallback;
}

function merge(base: VideoModel, entry: LiveVideoModel): VideoModel {
  return {
    ...base,
    name: typeof entry.name === "string" ? entry.name : base.name,
    description: typeof entry.description === "string" ? entry.description : base.description,
    durations: arrayOf<number>(entry.supported_durations, base.durations),
    resolutions: arrayOf<string>(entry.supported_resolutions, base.resolutions),
    aspectRatios: arrayOf<string>(entry.supported_aspect_ratios, base.aspectRatios),
    sizes: arrayOf<string>(entry.supported_sizes, base.sizes),
    frameTypes: arrayOf<string>(entry.supported_frame_images, base.frameTypes),
    supportsAudio: typeof entry.generate_audio === "boolean" ? entry.generate_audio : base.supportsAudio,
    supportsSeed: typeof entry.seed === "boolean" ? entry.seed : base.supportsSeed,
    passthrough: arrayOf<string>(entry.allowed_passthrough_parameters, base.passthrough),
  };
}

async function load(signal?: AbortSignal): Promise<Map<string, VideoModel>> {
  if (live && expiresAt > Date.now()) return live;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/videos/models", { headers: { Authorization: `Bearer ${config.openRouterApiKey}` }, signal });
    if (!response.ok) throw new Error(`video model catalog ${response.status}`);
    const body = await response.json() as { data?: LiveVideoModel[] };
    const next = new Map<string, VideoModel>();
    for (const entry of body.data ?? []) {
      if (typeof entry.id !== "string") continue;
      const base = byId.get(entry.id);
      if (base) next.set(entry.id, merge(base, entry));
    }
    if (next.size) { live = next; expiresAt = Date.now() + 15 * 60_000; }
    return next;
  } catch {
    return live ?? new Map(curated.map((model) => [model.id, model]));
  }
}

export async function listVideoModels(signal?: AbortSignal): Promise<VideoModel[]> {
  return Array.from((await load(signal)).values()).map((model) => ({ ...model, durations: [...model.durations], resolutions: [...model.resolutions], aspectRatios: [...model.aspectRatios], sizes: [...model.sizes], frameTypes: [...model.frameTypes], passthrough: [...model.passthrough] }));
}

export function chooseVideoModel(prompt: string, options: { preferredModel?: string; duration?: number; resolution?: string; frameMode?: string; generateAudio?: boolean } = {}): string {
  const preferred = options.preferredModel?.trim();
  if (preferred && preferred.toLowerCase() !== "auto") {
    if (preferred.toLowerCase() === "bytedance/seedance-2.0-mini") return "bytedance/seedance-2.0";
    return preferred;
  }
  if (/(?:avatar|presenter|talking head|speaking to camera|ugc|spokesperson|host)/i.test(prompt)) return "heygen/heygen-video-1";
  if (options.generateAudio || /(?:dialogue|voiceover|sound effects|soundscape|music|synchronized audio)/i.test(prompt)) return "google/veo-3.1";
  if (options.frameMode === "last_frame" || /(?:continue|extend|opening and closing|first frame.*last frame)/i.test(prompt)) return "black-forest-labs/flux-3-video";
  if (options.duration !== undefined && options.duration > 15) return "alibaba/wan-3.0";
  if (options.resolution === "4K" || /(?:cinematic|final production|premium|high fidelity)/i.test(prompt)) return "bytedance/seedance-2.0";
  if (/(?:text|brand|logo|typography|product label)/i.test(prompt)) return "minimax/hailuo-3";
  return "bytedance/seedance-2.0";
}

function nearest<T extends number | string>(value: T, supported: T[]): T | undefined {
  if (!supported.length) return undefined;
  if (supported.includes(value)) return value;
  if (typeof value === "number") return supported.reduce((best, candidate) => Math.abs(Number(candidate) - value) < Math.abs(Number(best) - value) ? candidate : best);
  return supported[0];
}

export async function resolveVideoRequest(prompt: string, options: { preferredModel?: string; duration?: number; resolution?: string; aspectRatio?: string; size?: string; generateAudio?: boolean; frameMode?: string; signal?: AbortSignal } = {}): Promise<{ model: VideoModel; duration?: number; resolution?: string; aspectRatio?: string; size?: string; generateAudio?: boolean; frameMode?: string }> {
  const selectedId = chooseVideoModel(prompt, options);
  const catalog = await load(options.signal);
  let model = catalog.get(selectedId) ?? byId.get(selectedId);
  if (!model) throw new Error(`Unsupported video model: ${selectedId}`);
  if (options.generateAudio && !model.supportsAudio) {
    if (!options.preferredModel || options.preferredModel.toLowerCase() === "auto") {
      model = catalog.get("google/veo-3.1") ?? byId.get("google/veo-3.1")!;
    } else throw new Error(`${model.name} does not support generated audio`);
  }
  const frameMode = options.frameMode && model.frameTypes.includes(options.frameMode) ? options.frameMode : options.frameMode === "reference" ? "reference" : undefined;
  if (options.frameMode && options.frameMode !== "reference" && !frameMode) throw new Error(`${model.name} does not support ${options.frameMode} frame control`);
  return { model, duration: options.duration === undefined ? undefined : nearest(options.duration, model.durations), resolution: options.resolution ? nearest(options.resolution, model.resolutions) : undefined, aspectRatio: options.aspectRatio ? nearest(options.aspectRatio, model.aspectRatios) : undefined, size: options.size && model.sizes.includes(options.size) ? options.size : undefined, generateAudio: options.generateAudio && model.supportsAudio ? true : options.generateAudio === false ? false : undefined, frameMode };
}
