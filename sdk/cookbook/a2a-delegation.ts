import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-a2a",
});

const card = await chusky.a2a.card();
console.log({
  agent: card.name,
  protocolVersion: card.protocolVersion,
  skills: card.skills?.map((skill) => skill.id),
});

const task = await chusky.a2a.send(
  "Prepare a verified launch brief from the connected account context.",
  { idempotencyKey: "cookbook-a2a-launch-brief-0001" },
);

console.log("Delegated task:", task.id, task.status.state);

const current = await chusky.a2a.get(task.id);
console.log("Current task state:", current.status.state);

if (current.status.state === "TASK_STATE_WORKING") {
  for await (const update of chusky.a2a.subscribe(task.id)) {
    console.log("Task update:", update.statusUpdate?.status.state);
    if (update.statusUpdate?.final) break;
  }
}
