import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { createTrigger, listTriggers, setAgentDependenciesForTests, setTriggerState, updateTriggerInstructions } from "../src/agent.js";
import { getSession, initStore, saveSession } from "../src/store.js";
import { resetTriggerCatalogueForTests } from "../src/triggerCatalog.js";

const userId = 991_801;
const providerCalls: Array<{ method: string; args: unknown[] }> = [];

beforeEach(async () => {
  await initStore({ memoryOnly: true });
  resetTriggerCatalogueForTests();
  providerCalls.length = 0;
  setAgentDependenciesForTests({ composio: {
    connectedAccounts: {
      list: async (query: unknown) => {
        providerCalls.push({ method: "accounts.list", args: [query] });
        return [{ id: "acct-assistant-workspace", alias: "assistant-workspace", toolkit: { slug: "gmail" }, status: "ACTIVE" }];
      },
    },
    triggers: {
      listTypes: async () => ({ items: [{
        slug: "GMAIL_NEW_GMAIL_MESSAGE",
        name: "New Gmail message",
        description: "A new message arrived.",
        toolkit: { slug: "gmail", name: "Gmail" },
        config: { type: "object", required: ["query"], properties: { query: { type: "string", maxLength: 100 } }, additionalProperties: false },
      }] }),
      create: async (...args: unknown[]) => {
        providerCalls.push({ method: "triggers.create", args });
        return { triggerId: "trigger-owned-1", status: "enabled" };
      },
      enable: async (id: string) => { providerCalls.push({ method: "triggers.enable", args: [id] }); return { id, enabled: true }; },
      disable: async (id: string) => { providerCalls.push({ method: "triggers.disable", args: [id] }); return { id, enabled: false }; },
      listActive: async () => ({ items: [{ id: "trigger-owned-1", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", status: "disabled" }] }),
    },
  } });
});

test("trigger creation requires an exact catalog slug, valid config, and an active owned matching account", async () => {
  await assert.rejects(createTrigger(userId, "GMAIL_NEW_GMAIL_MESSAGE_GUESSED", { triggerConfig: { query: "in:inbox" } }), /exact supported slug/i);
  await assert.rejects(createTrigger(userId, "GMAIL_NEW_GMAIL_MESSAGE", { triggerConfig: {} }), /query/);
  await assert.rejects(createTrigger(userId, "GMAIL_NEW_GMAIL_MESSAGE", { connectedAccountId: "somebody-elses-account", triggerConfig: { query: "in:inbox" } }), /not active|does not belong/i);
  assert.equal(providerCalls.some((call) => call.method === "triggers.create"), false);

  const result = await createTrigger(userId, "GMAIL_NEW_GMAIL_MESSAGE", {
    connectedAccountId: "acct-assistant-workspace",
    triggerConfig: { query: "in:inbox" },
    instructions: "Triage new mail; draft sensitive replies but never send them.",
  }) as { triggerId: string };

  assert.equal(result.triggerId, "trigger-owned-1");
  assert.deepEqual(providerCalls.find((call) => call.method === "triggers.create")?.args, [
    `user_${userId}`,
    "GMAIL_NEW_GMAIL_MESSAGE",
    { connectedAccountId: "acct-assistant-workspace", triggerConfig: { query: "in:inbox" } },
  ]);
  const session = await getSession(userId);
  assert.deepEqual(session.triggerIds, ["trigger-owned-1"]);
  assert.equal(session.triggerInstructions?.["trigger-owned-1"], "Triage new mail; draft sensitive replies but never send them.");
});

test("trigger instruction edits and enable/disable controls enforce ownership and truthful provider state", async () => {
  await assert.rejects(updateTriggerInstructions(userId, "foreign-trigger", "Do work"), /do not own/i);
  await assert.rejects(setTriggerState(userId, "foreign-trigger", true), /do not own/i);
  const session = await getSession(userId);
  session.triggerIds = ["trigger-owned-1"];
  await saveSession(userId, session);

  const existing = await listTriggers(userId) as Array<{ id: string; status: string; enabled: boolean }>;
  assert.deepEqual(existing.map(({ id, status, enabled }) => ({ id, status, enabled })), [
    { id: "trigger-owned-1", status: "disabled", enabled: false },
  ]);

  await updateTriggerInstructions(userId, "trigger-owned-1", "Only summarize; never send email.");
  await setTriggerState(userId, "trigger-owned-1", true);
  await setTriggerState(userId, "trigger-owned-1", false);

  const restored = await getSession(userId);
  assert.equal(restored.triggerInstructions?.["trigger-owned-1"], "Only summarize; never send email.");
  assert.deepEqual(providerCalls.filter((call) => call.method.startsWith("triggers.")).map((call) => call.method), ["triggers.enable", "triggers.disable"]);
});
