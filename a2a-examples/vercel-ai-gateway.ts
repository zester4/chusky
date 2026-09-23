/**
 * Vercel AI Gateway + AI SDK tool calling + Chusky A2A.
 *
 * Install:
 *   npm install ai zod
 *
 * AI Gateway routes the model. The execute functions run in our server and
 * perform the authenticated Chusky A2A calls. The model never sees the key.
 */

import { generateText, gateway, stepCountIs, tool } from "ai";
import { createHash } from "node:crypto";
import { z } from "zod";

const a2aUrl = process.env.CHUSKY_A2A_URL?.replace(/\/$/, "");
const apiKey = process.env.CHUSKY_API_KEY;
const callerId = process.env.CHUSKY_CALLER_ID;

if (!a2aUrl || !apiKey || !callerId) throw new Error("CHUSKY_A2A_URL, CHUSKY_API_KEY, and CHUSKY_CALLER_ID are required");

function idempotencyKey(title: string, objective: string, definitionOfDone: string) {
  return `gateway-${callerId}-${createHash("sha256").update(JSON.stringify([title, objective, definitionOfDone])).digest("hex").slice(0, 32)}`;
}

async function chuskyRpc(method: string, params: Record<string, unknown>, idempotencyKey?: string) {
  const response = await fetch(`${a2aUrl}/a2a/rpc`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Chusky-User-Id": callerId,
      "A2A-Version": "1.0",
      "Content-Type": "application/a2a+json",
      Accept: "application/a2a+json, application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: `gateway-${method}`, method, params }),
  });
  if (!response.ok) throw new Error(`Chusky A2A returned HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "Chusky A2A request failed");
  return body.result;
}

const startChuskyTask = tool({
  description: "Start a durable Chusky mission for browser, meeting, research, or artifact work.",
  inputSchema: z.object({
    objective: z.string().min(1).max(8_000),
    title: z.string().min(1).max(160),
    definitionOfDone: z.string().min(1).max(2_000),
  }),
  execute: async ({ objective, title, definitionOfDone }) => {
    const result = await chuskyRpc("message/send", {
      contextId: `vercel-gateway-${callerId}`,
      message: { role: "ROLE_USER", parts: [{ text: objective }] },
      title,
      definitionOfDone,
    }, idempotencyKey(title, objective, definitionOfDone)) as { task: { id: string; status: { state: string } } };
    return { taskId: result.task.id, state: result.task.status.state };
  },
});

const getChuskyTask = tool({
  description: "Read a Chusky task created by this integration.",
  inputSchema: z.object({ taskId: z.string().min(1) }),
  execute: async ({ taskId }) => {
    const result = await chuskyRpc("tasks/get", { id: taskId }) as { task: Record<string, unknown> };
    return result.task;
  },
});

const result = await generateText({
  model: gateway(process.env.VERCEL_AI_MODEL ?? "openai/gpt-5"),
  system: "Use Chusky for durable browser, meeting, research, and artifact work. A submitted task is not a completed task; retain and report its task ID. Never request credentials, caller IDs, or approval decisions.",
  prompt: "Delegate a verified launch-brief task to Chusky and explain how it will be tracked.",
  tools: { startChuskyTask, getChuskyTask },
  stopWhen: stepCountIs(4),
});

console.log(result.text);
