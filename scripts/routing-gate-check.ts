import fs from "node:fs";
import { isClearlyConversational } from "../src/decisions/actionGate.js";

type Case = { message: string; label: "conversational" | "action" };
const filename = process.env.ROUTING_FIXTURE ?? "tests/fixtures/routing-messages.json";
const cases = JSON.parse(fs.readFileSync(filename, "utf8")) as Case[];
if (!Array.isArray(cases) || cases.some((item) => !item || typeof item.message !== "string" || !["conversational", "action"].includes(item.label))) {
  throw new Error("Routing fixture must be an array of { message, label } records.");
}

const actionMisses = cases.filter((item) => item.label === "action" && isClearlyConversational(item.message));
const conversationalHits = cases.filter((item) => item.label === "conversational" && isClearlyConversational(item.message));
const conversationalCases = cases.filter((item) => item.label === "conversational");
console.log(`fixture: ${filename}`);
console.log(`action misclassified as conversational: ${actionMisses.length}/${cases.filter((item) => item.label === "action").length}`);
console.log(`conversational recognized: ${conversationalHits.length}/${conversationalCases.length}`);
for (const item of actionMisses) console.log(`MISS action: ${item.message}`);
if (actionMisses.length > 0) process.exitCode = 1;
