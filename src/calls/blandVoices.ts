export interface BlandSelectableVoice {
  id: string;
  name: string;
  description?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Return only Bland's public, curated BTTS_V3 voices. The organization-wide
 * credentials may also expose private voice clones; those must not be shown
 * to every Telegram account using this Chusky deployment.
 */
export async function listBlandCuratedVoices(apiKey: string, fetchImpl: FetchLike = fetch): Promise<BlandSelectableVoice[]> {
  if (!apiKey.trim()) throw new Error("Bland voice choices require BLAND_API_KEY");
  let response: Response;
  try {
    response = await fetchImpl("https://api.bland.ai/v1/voices", {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Bland's voice catalogue could not be reached. Try again shortly.");
  }
  if (!response.ok) throw new Error(`Bland's voice catalogue is unavailable (HTTP ${response.status}).`);
  const payload = await response.json().catch(() => ({})) as { voices?: unknown };
  if (!Array.isArray(payload.voices)) throw new Error("Bland returned an invalid voice catalogue.");
  const voices = payload.voices.flatMap((item): BlandSelectableVoice[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const voice = item as Record<string, unknown>;
    const tags = Array.isArray(voice.tags) ? voice.tags : [];
    if (voice.public !== true || voice.service !== "BTTS_V3" || !tags.includes("Bland Curated")) return [];
    if (typeof voice.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(voice.id)) return [];
    if (typeof voice.name !== "string" || !voice.name.trim()) return [];
    const name = voice.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    const description = typeof voice.description === "string"
      ? voice.description.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)
      : undefined;
    return [{ id: voice.id, name, ...(description ? { description } : {}) }];
  });
  return voices.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
}
