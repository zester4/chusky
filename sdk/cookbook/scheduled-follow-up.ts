import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-scheduled-follow-up",
});

const reminder = await chusky.reminders.create(
  {
    text: "Check whether the buyer replied and prepare the next sales step.",
    delaySeconds: 60 * 60 * 24,
    mode: "check_in",
    nextAction: "Read the latest buyer reply, update the CRM, and draft a response.",
    preconditions: ["The buyer inquiry is still open."],
    postconditions: ["The next action is recorded or the owner is notified."],
  },
  { idempotencyKey: "cookbook-buyer-follow-up-0001" },
);

console.log({
  reminderId: reminder.id,
  status: reminder.status,
  runAt: reminder.runAt,
});

// The same pattern can be recurring:
const job = await chusky.jobs.create(
  {
    text: "Review open support conversations and prepare a daily handoff.",
    cron: "0 9 * * 1-5",
    mode: "notify",
    nextAction: "Summarize only conversations that changed since the last run.",
  },
  { idempotencyKey: "cookbook-daily-support-handoff-0001" },
);

console.log({ jobId: job.id, cron: job.cron, status: job.status });
