/**
 * OpenRouter Agent SDK + Chusky A2A.
 *
 * Install:
 *   npm install @openrouter/agent zod
 *
 * OpenRouter supplies model selection, routing, fallbacks, and the tool loop.
 * The user-defined tools execute in our trusted server and call Chusky's A2A
 * boundary. OpenRouter itself never receives the Chusky bearer key.
 */

import { OpenRouter, tool } from "@openrouter/agent";
import { createHash } from "node:crypto";
import { z } from "zod";

const a2aUrl = process.env.CHUSKY_A2A_URL?.replace(/\/$/, "");
const apiKey = process.env.CHUSKY_API_KEY;
const callerId = process.env.CHUSKY_CALLER_ID;

if (!a2aUrl || !apiKey || !callerId) throw new Error("CHUSKY_A2A_URL, CHUSKY_API_KEY, and CHUSKY_CALLER_ID are required");

function idempotencyKey(title: string, objective: string, definitionOfDone: string) {
  return `openrouter-${callerId}-${createHash("sha256").update(JSON.stringify([title, objective, definitionOfDone])).digest("hex").slice(0, 32)}`;
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
    body: JSON.stringify({ jsonrpc: "2.0", id: `openrouter-${method}`, method, params }),
  });
  if (!response.ok) throw new Error(`Chusky A2A returned HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "Chusky A2A request failed");
  return body.result;
}

const startChuskyTask = tool({
  name: "chusky_start_task",
  description: "Start a durable, governed Chusky task for work that may outlive this model call.",
  inputSchema: z.object({
    objective: z.string().min(1).max(8_000),
    title: z.string().min(1).max(160),
    definitionOfDone: z.string().min(1).max(2_000),
  }),
  execute: async ({ objective, title, definitionOfDone }) => {
    const result = await chuskyRpc("message/send", {
      contextId: `openrouter-${callerId}`,
      message: { role: "ROLE_USER", parts: [{ text: objective }] },
      title,
      definitionOfDone,
    }, idempotencyKey(title, objective, definitionOfDone)) as { task: { id: string; status: { state: string } } };
    return { taskId: result.task.id, state: result.task.status.state };
  },
});

const getChuskyTask = tool({
  name: "chusky_get_task",
  description: "Get status and artifacts for a Chusky task created by this caller.",
  inputSchema: z.object({ taskId: z.string().min(1) }),
  execute: async ({ taskId }) => {
    const result = await chuskyRpc("tasks/get", { id: taskId }) as { task: Record<string, unknown> };
    return result.task;
  },
});

const openrouter = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
const run = openrouter.callModel({
  model: process.env.OPENROUTER_MODEL ?? "~openai/gpt-sol-latest",
  input: [
    "You coordinate external work.",
    "Use Chusky for durable browser, meeting, research, and artifact tasks.",
    "A task submission is not completion; preserve the task ID and check status when asked.",
    "Never request or invent credentials, caller identities, or approval decisions.",
    "Delegate a verified customer-meeting preparation task to Chusky.",
  ].join("\n"),
  tools: [startChuskyTask, getChuskyTask],
});

console.log(await run.getText());
