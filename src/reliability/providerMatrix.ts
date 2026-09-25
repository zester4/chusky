export type ProviderSurface = "telegram" | "slack" | "whatsapp" | "imessage" | "web" | "cli" | "sdk" | "xchat" | "meetings";
export interface ProviderMatrixEntry { surface: ProviderSurface; inboundText: boolean; inboundImage: boolean; outboundText: boolean; outboundImage: boolean; liveProof: "verified" | "configured_unverified" | "not_configured"; missing?: string; }

const surfaces: ProviderSurface[] = ["telegram", "slack", "whatsapp", "imessage", "web", "cli", "sdk", "xchat", "meetings"];

/** Honest capability matrix: code parity is separate from live credentials/provider proof. */
export function providerMatrix(env: NodeJS.ProcessEnv = process.env): ProviderMatrixEntry[] {
  return surfaces.map((surface) => {
    const configured = surface === "web" || surface === "cli" || surface === "sdk" || (surface === "telegram" ? Boolean(env.TELEGRAM_BOT_TOKEN) : surface === "slack" ? Boolean(env.SLACK_BOT_TOKEN) : surface === "whatsapp" ? Boolean(env.WHATSAPP_ACCESS_TOKEN) : surface === "imessage" ? Boolean(env.SENDBLUE_API_KEY) : surface === "xchat" ? Boolean(env.XCHAT_BOT_TOKEN) : surface === "meetings" ? Boolean(env.RECALL_API_KEY) : false);
    return { surface, inboundText: true, inboundImage: true, outboundText: true, outboundImage: true, liveProof: configured ? "configured_unverified" : "not_configured", missing: "A real inbound/outbound smoke test is required before claiming provider proof." };
  });
}
