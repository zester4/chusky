/** Provider groups shown in the Telegram model picker. */
export const MODEL_PROVIDER_IDS = [
  "anthropic", "openai", "google", "meta-muse", "deepseek",
  "qwen", "z-ai", "moonshotai", "x-ai", "minimax", "all",
] as const;

export type ModelProvider = typeof MODEL_PROVIDER_IDS[number];

export const MODEL_PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "meta-muse": "Meta Muse",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  "z-ai": "GLM",
  moonshotai: "Kimi",
  "x-ai": "Grok",
  minimax: "MiniMax",
  all: "Browse all models",
};

export interface ProviderModel { id: string; name: string; }

export function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * The catalogue itself is fetched live from OpenRouter. Meta's picker is
 * intentionally narrowed to the current Muse family rather than mixing in
 * unrelated Meta releases.
 */
export function modelsForProvider(models: ProviderModel[], provider: ModelProvider): ProviderModel[] {
  const matching = provider === "all"
    ? models
    : provider === "meta-muse"
      ? models.filter((model) => /^meta\/muse-/i.test(model.id))
      : models.filter((model) => model.id.startsWith(`${provider}/`));
  return matching.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id) || a.id.localeCompare(b.id));
}
