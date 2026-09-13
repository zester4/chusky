/** Curated English Flux voices supported by the live Deepgram streaming path. */
export const FLUX_TTS_VOICES = [
  { id: "flux-hannah-en", name: "Hannah", accent: "American" },
  { id: "flux-kit-en", name: "Kit", accent: "British" },
  { id: "flux-alexis-en", name: "Alexis", accent: "American" },
  { id: "flux-cliff-en", name: "Cliff", accent: "American" },
  { id: "flux-sienna-en", name: "Sienna", accent: "American" },
  { id: "flux-cole-en", name: "Cole", accent: "American" },
  { id: "flux-brooke-en", name: "Brooke", accent: "American" },
  { id: "flux-colin-en", name: "Colin", accent: "British" },
  { id: "flux-gemma-en", name: "Gemma", accent: "British" },
  { id: "flux-haley-en", name: "Haley", accent: "American" },
  { id: "flux-heather-en", name: "Heather", accent: "American" },
  { id: "flux-miles-en", name: "Miles", accent: "American" },
  { id: "flux-sean-en", name: "Sean", accent: "British" },
  { id: "flux-bree-en", name: "Bree", accent: "American" },
  { id: "flux-brittany-en", name: "Brittany", accent: "American" },
  { id: "flux-bruce-en", name: "Bruce", accent: "American" },
  { id: "flux-conor-en", name: "Conor", accent: "British" },
  { id: "flux-donovan-en", name: "Donovan", accent: "American" },
  { id: "flux-drew-en", name: "Drew", accent: "American" },
  { id: "flux-elise-en", name: "Elise", accent: "American" },
  { id: "flux-jack-en", name: "Jack", accent: "British" },
  { id: "flux-kai-en", name: "Kai", accent: "Singaporean" },
  { id: "flux-kelsey-en", name: "Kelsey", accent: "American" },
  { id: "flux-maeve-en", name: "Maeve", accent: "Irish" },
  { id: "flux-marcelo-en", name: "Marcelo", accent: "Filipino" },
  { id: "flux-marcus-en", name: "Marcus", accent: "American" },
  { id: "flux-meena-en", name: "Meena", accent: "Indian" },
  { id: "flux-meghan-en", name: "Meghan", accent: "American" },
  { id: "flux-naveen-en", name: "Naveen", accent: "Indian" },
  { id: "flux-paige-en", name: "Paige", accent: "American" },
  { id: "flux-priya-en", name: "Priya", accent: "Indian" },
  { id: "flux-rufus-en", name: "Rufus", accent: "British" },
  { id: "flux-sharon-en", name: "Sharon", accent: "Australian" },
  { id: "flux-tanner-en", name: "Tanner", accent: "British" },
  { id: "flux-wade-en", name: "Wade", accent: "American" },
  { id: "flux-wes-en", name: "Wes", accent: "American" },
] as const;

export type FluxTtsVoiceId = (typeof FLUX_TTS_VOICES)[number]["id"];
export type LiveVoiceProvider = "twilio" | "bland" | "meetings";

export interface LiveVoicePreferences {
  twilio?: FluxTtsVoiceId;
  meetings?: FluxTtsVoiceId;
  bland?: { id: string; name: string };
}

const BLAND_VOICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOICE_NAME_CONTROLS = /[\u0000-\u001f\u007f]/g;

export function isFluxTtsVoice(value: unknown): value is FluxTtsVoiceId {
  return typeof value === "string" && FLUX_TTS_VOICES.some((voice) => voice.id === value);
}

export function fluxTtsVoiceName(value: unknown): string | undefined {
  return FLUX_TTS_VOICES.find((voice) => voice.id === value)?.name;
}

export function normalizeLiveVoicePreferences(value: unknown): LiveVoicePreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const result: LiveVoicePreferences = {};
  if (isFluxTtsVoice(input.twilio)) result.twilio = input.twilio;
  if (isFluxTtsVoice(input.meetings)) result.meetings = input.meetings;
  if (input.bland && typeof input.bland === "object" && !Array.isArray(input.bland)) {
    const bland = input.bland as Record<string, unknown>;
    if (typeof bland.id === "string" && BLAND_VOICE_ID.test(bland.id) && typeof bland.name === "string") {
      const name = bland.name.replace(VOICE_NAME_CONTROLS, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      if (name) result.bland = { id: bland.id, name };
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function isBlandVoiceId(value: unknown): value is string {
  return typeof value === "string" && BLAND_VOICE_ID.test(value);
}
