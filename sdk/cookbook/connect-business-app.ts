import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const toolkit = process.env.CHUSKY_TOOLKIT ?? "gmail";
const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-connect-app",
});

const available = await chusky.apps.list();
const match = available.data.find((app) => app.toolkit === toolkit);
if (!match) throw new Error("The requested toolkit is not available: " + toolkit);

const consent = await chusky.apps.connect(
  toolkit,
  process.env.CHUSKY_APP_ALIAS,
  { idempotencyKey: "cookbook-connect-" + toolkit + "-0001" },
);

console.log("Complete provider consent at:", consent.url);
console.log("After consent, run this recipe again to read connections.");

const connections = await chusky.apps.connections();
console.log({
  connected: connections.data.filter((connection) => connection.toolkit === toolkit),
});
