import type { ChannelCapabilities, ChannelProvider } from "./contracts.js";

export const CHANNEL_CAPABILITIES: Record<ChannelProvider, ChannelCapabilities> = {
  telegram: { supportsThreads: false, supportsStreaming: true, supportsFiles: true, supportsMarkdown: true, supportsButtons: true, supportsTyping: true, maxTextLength: 4096 },
  slack: { supportsThreads: true, supportsStreaming: true, supportsFiles: true, supportsMarkdown: true, supportsButtons: true, supportsTyping: true, maxTextLength: 40_000 },
  whatsapp: { supportsThreads: false, supportsStreaming: false, supportsFiles: true, supportsMarkdown: false, supportsButtons: true, supportsTyping: true, supportsTemplates: true, maxTextLength: 4096 },
  sendblue: { supportsThreads: false, supportsStreaming: false, supportsFiles: true, supportsMarkdown: false, supportsButtons: false, supportsTyping: true, maxTextLength: 4096 },
  sms: { supportsThreads: false, supportsStreaming: false, supportsFiles: true, supportsMarkdown: false, supportsButtons: false, supportsTyping: false, maxTextLength: 1600 },
  // The regular X adapter handles private DMs, plain text, and outbound media.
  // The installed adapter does not expose inbound DM media as attachments.
  x: { supportsThreads: true, supportsStreaming: false, supportsFiles: true, supportsMarkdown: false, supportsButtons: false, supportsTyping: false, maxTextLength: 10_000 },
  xchat: { supportsThreads: true, supportsStreaming: false, supportsFiles: true, supportsMarkdown: false, supportsButtons: false, supportsTyping: true, maxTextLength: 10_000 },
  voice: { supportsThreads: false, supportsStreaming: false, supportsFiles: true, supportsMarkdown: false, supportsButtons: false, supportsTyping: false, maxTextLength: 4000 },
  cli: { supportsThreads: true, supportsStreaming: true, supportsFiles: true, supportsMarkdown: true, supportsButtons: true, supportsTyping: false, maxTextLength: 100_000 },
  // Internal SDK webhook delivery uses the durable outbox but is not an inbound channel.
  webhook: { supportsThreads: false, supportsStreaming: false, supportsFiles: false, supportsMarkdown: false, supportsButtons: false, supportsTyping: false, maxTextLength: 0 },
};
