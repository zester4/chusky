import { createClient } from "./_client.js";

const chusky = createClient();
const webhook = await chusky.webhooks.create(
  "https://app.example.com/api/chusky/events",
  { idempotencyKey: "register-chusky-events-v1" },
);

const deliveries = await chusky.webhooks.deliveries(webhook.id);
console.log({
  webhookId: webhook.id,
  deliveryStatuses: deliveries.data.map((delivery) => delivery.status),
});

// Your receiving endpoint should verify the Chusky signature, persist the
// delivery ID before applying the event, and return 2xx only after that write.
