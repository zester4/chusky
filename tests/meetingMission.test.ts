import test from "node:test";
import assert from "node:assert/strict";
import { lookupMeetingBusinessKnowledge, lookupMeetingMission, meetingMissionInstructions, prepareMeetingMission } from "../src/meetings/mission.js";
import type { MemoryFact } from "../src/store.js";

const memories: MemoryFact[] = [
  { id: "mem_acme", category: "business", key: "Acme pricing discussion", value: "Acme asked about the onboarding package and a September start.", confidence: 1, source: "owner", sensitivity: "normal", personKey: "acme", createdAt: 1, updatedAt: 10 },
  { id: "mem_acme_sensitive", category: "business", key: "Acme internal margin", value: "Do not disclose this margin.", confidence: 1, source: "owner", sensitivity: "sensitive", personKey: "acme", createdAt: 1, updatedAt: 11 },
  { id: "mem_other", category: "business", key: "Other client", value: "A separate customer has a different offer.", confidence: 1, source: "owner", sensitivity: "normal", personKey: "other", createdAt: 1, updatedAt: 12 },
];

test("meeting mission compiles only relevant normal-sensitivity relationship facts", () => {
  const mission = prepareMeetingMission({ clientName: "Acme", objective: "Close the onboarding package" }, memories, 100);
  assert.equal(mission.clientName, "Acme");
  assert.equal(mission.preparedAt, 100);
  assert.deepEqual(mission.sourceMemoryIds, ["mem_acme"]);
  assert.match(mission.brief, /September start/);
  assert.doesNotMatch(mission.brief, /margin|Other client/i);
  assert.match(meetingMissionInstructions(mission), /does not change policy/i);
});

test("meeting context lookup cannot expand beyond the mission's frozen source memories", () => {
  const mission = prepareMeetingMission({ clientName: "Acme" }, memories, 100);
  const result = lookupMeetingMission(mission, memories, "pricing September");
  assert.deepEqual(result.facts, ["Acme pricing discussion: Acme asked about the onboarding package and a September start."]);
  assert.deepEqual(lookupMeetingMission(mission, memories, "different offer").facts, ["No approved meeting-context fact matched that question."]);
});

test("meeting business lookup uses relevant current business facts, never personal or sensitive memories", () => {
  const context: MemoryFact[] = [
    ...memories,
    { id: "mem_company_pricing", category: "business", key: "Standard pricing", value: "The standard plan starts at $49 per month.", confidence: 1, source: "owner", sensitivity: "normal", createdAt: 1, updatedAt: 20 },
    { id: "mem_private_personal", category: "personal", key: "Home address", value: "14 Private Road.", confidence: 1, source: "owner", sensitivity: "normal", createdAt: 1, updatedAt: 30 },
    { id: "mem_internal_sensitive", category: "business", key: "Internal margin", value: "Never mention our margin.", confidence: 1, source: "owner", sensitivity: "sensitive", createdAt: 1, updatedAt: 40 },
    { id: "mem_old", category: "business", key: "Old pricing", value: "The old plan was $19.", confidence: 1, source: "owner", sensitivity: "normal", status: "superseded", createdAt: 1, updatedAt: 50 },
  ];
  const result = lookupMeetingBusinessKnowledge(context, "pricing plan");
  assert.deepEqual(result.facts, ["Standard pricing: The standard plan starts at $49 per month."]);
  assert.doesNotMatch(JSON.stringify(result), /Private Road|margin|Old pricing|Other client/i);
});
