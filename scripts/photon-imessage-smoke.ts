import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";

type PhotonModule = { Photon: new (options: Record<string, unknown>) => { projects: any } };
type PhotonMessage = Record<string, any>;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running the Photon iMessage smoke test.`);
  return value;
}

function importPhoton(): Promise<PhotonModule> {
  const importer = new Function("name", "return import(name)") as (name: string) => Promise<PhotonModule>;
  return importer("@photon-ai/api");
}

function matching(message: PhotonMessage, config: { sender: string; agent: string }, startedAt: number): { id: string; spaceId: string; senderId: string } | undefined {
  if (message.platform !== "imessage" || message.status !== "received") return undefined;
  if (Date.parse(String(message.createdAt ?? "")) < startedAt) return undefined;
  const sender = message.sentBy;
  const agent = message.receivedBy;
  const space = message.space;
  if (sender?.kind !== "human" || sender.handle !== config.sender) return undefined;
  if (agent?.kind !== "agent" || agent.handle !== config.agent || sender.id === agent.id) return undefined;
  if (space?.kind !== "direct" || typeof space.id !== "string") return undefined;
  const content = message.content;
  if (content?.type !== "text" || content.format !== "plain" || String(content.text ?? "").trim() !== "ping") return undefined;
  if (typeof message.id !== "string" || typeof agent.id !== "string") return undefined;
  return { id: message.id, spaceId: space.id, senderId: agent.id };
}

async function main(): Promise<void> {
  const photonModule = await importPhoton();
  const projectId = required("PHOTON_PROJECT_ID");
  const apiKey = required("PHOTON_API_KEY");
  const sender = required("PHOTON_TEST_SENDER");
  const agent = required("PHOTON_AGENT_HANDLE");
  const apiOrigin = (process.env.PHOTON_API_ORIGIN?.trim() || "https://api.photon.codes").replace(/\/$/, "");
  const windowMs = Number(process.env.PHOTON_SMOKE_WINDOW_MS ?? 120_000);
  const pollMs = Number(process.env.PHOTON_SMOKE_POLL_MS ?? 2_000);
  if (!Number.isFinite(windowMs) || windowMs < 5_000 || !Number.isFinite(pollMs) || pollMs < 500) {
    throw new Error("PHOTON_SMOKE_WINDOW_MS must be at least 5000 and PHOTON_SMOKE_POLL_MS at least 500.");
  }

  const photon = new photonModule.Photon({
    baseUrl: apiOrigin,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: 30_000,
    retry: { maxAttempts: 3, maximumRetryAfterMs: 60_000 },
  });

  const startedAt = Date.now();
  const deadline = startedAt + windowMs;
  const createdSince = new Date(startedAt - 5_000).toISOString();
  console.log("Ready. Send exactly 'ping' from the configured sender to the assigned Photon iMessage line.");

  while (Date.now() < deadline) {
    let pageToken: string | undefined;
    do {
      const page = await photon.projects.listMessages({
        path: { id: projectId },
        query: {
          createdSince,
          direction: "received",
          order: "asc",
          pageSize: 100,
          platform: "imessage",
          ...(pageToken ? { pageToken } : {}),
        },
      });
      for (const message of page.items as PhotonMessage[]) {
        const found = matching(message, { sender, agent }, startedAt);
        if (!found) continue;
        await photon.projects.sendMessage({
          path: { id: projectId },
          headers: { idempotencyKey: `first-agent-reply:${found.id}` },
          body: {
            spaceId: found.spaceId,
            senderId: found.senderId,
            parentMessageId: found.id,
            content: { type: "text", format: "plain", text: "Hello from your Photon agent!" },
          },
        });
        console.log(JSON.stringify({ ok: true, messageId: found.id, accepted: true, note: "Photon accepted the send asynchronously; delivery must be confirmed on the device/API activity." }, null, 2));
        return;
      }
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    } while (pageToken);
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  throw new Error("No matching ping found before the deadline.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Photon iMessage smoke test failed.");
  process.exitCode = 1;
});
