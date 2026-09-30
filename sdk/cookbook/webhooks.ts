import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-webhooks",
});

const webhook = await chusky.webhooks.create(
  "https://app.example.com/api/chusky/events",
  { idempotencyKey: "cookbook-register-events-0001" },
);

console.log({
  webhookId: webhook.id,
  secretReturnedOnce: Boolean(webhook.secret),
});

const deliveries = await chusky.webhooks.deliveries(webhook.id);
console.log({
  deliveryStatuses: deliveries.data.map((delivery) => delivery.status),
});

// The receiving endpoint must verify the Chusky signature, persist the
// delivery ID before applying the event, and return 2xx after that write.
