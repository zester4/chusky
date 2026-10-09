import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chuckTools, validateNativeToolArguments } from "../src/agentTools.js";
import { nativeTool } from "../src/nativeTools.js";
import { finalizeLeadCampaign, getMission, initStore, listLeadCampaignCandidates, listMissions, reserveLeadCampaignTregSpend, settleLeadCampaignTregSpend, upsertLeadCampaignCandidates } from "../src/store.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

const enqueueMissionTask = async (_owner: number, missionId: string) => `wf_${missionId}`;
const campaignRuntime = (patch: Record<string, unknown> = {}) => ({
  ownerPrivateRun: true,
  enqueueMissionTask,
  ...patch,
});
const tool = (args: Record<string, unknown>, runtime: Record<string, unknown> = {}) => nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", args, campaignRuntime(runtime));

test("lead campaign tool validates bounded campaign requests and is in the native catalogue", () => {
  assert.ok(chuckTools.some((entry) => entry.function.name === "CHUCK_LEAD_CAMPAIGN"));
  validateNativeToolArguments("CHUCK_LEAD_CAMPAIGN", {
    action: "start", title: "HVAC prospects", objective: "Find qualified HVAC service companies in Texas",
    idealCustomerProfile: "Commercial HVAC contractors with 10-100 employees", geography: "Texas", targetCount: 100,
    maxTregSpendUsd: 5, idempotencyKey: "hvac-2026-10",
  });
  assert.throws(() => validateNativeToolArguments("CHUCK_LEAD_CAMPAIGN", {
    action: "start", title: "HVAC", objective: "Find leads", idealCustomerProfile: "HVAC", geography: "US", targetCount: 1000,
  }), /targetCount.*at most 500/i);
});

test("campaign start creates one resumable mission and replays idempotently", async () => {
  const args = {
    action: "start", title: "HVAC lead campaign", objective: "Find qualified HVAC service companies",
    idealCustomerProfile: "Commercial HVAC businesses with 10-100 employees", geography: "Texas", targetCount: 100,
    maxTregSpendUsd: 5, idempotencyKey: "campaign-hvac-test",
  };
  const enqueued: string[] = [];
  const runtime = { ownerPrivateRun: true, enqueueMissionTask: async (_owner: number, id: string) => { enqueued.push(id); return `wf_${id}`; } };
  const first = await nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", args, runtime) as { id: string; missionId: string; status: string };
  const replay = await nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", args, runtime) as { id: string; missionId: string; status: string };
  assert.equal(first.id, replay.id);
  assert.equal(first.missionId, replay.missionId);
  assert.equal(first.status, "running");
  assert.equal((await listMissions(981001)).length, 1);
  assert.equal(enqueued.length, 1);
});

test("mission worker can persist source-backed leads, dedupe them, and keep them private", async () => {
  const campaign = await tool({
    action: "start", title: "HVAC lead campaign", objective: "Find HVAC prospects",
    idealCustomerProfile: "Commercial HVAC businesses", geography: "Texas", targetCount: 2,
    maxTregSpendUsd: 1, idempotencyKey: "campaign-hvac-record-test",
  }) as { id: string; missionId: string };
  const candidate = {
    companyName: "Northstar Mechanical", domain: "northstar.example", personName: "Avery Stone", jobTitle: "Operations Director",
    workEmail: "avery@northstar.example", sourceUrls: ["https://northstar.example/about"],
    evidenceSummary: "Company operates commercial HVAC services in Texas; source describes its service area.",
    qualificationStatus: "qualified", qualificationReason: "Matches industry and service geography; company size not yet verified.",
  };
  const runtime = campaignRuntime({ missionId: campaign.missionId });
  const first = await nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", { action: "record_candidates", id: campaign.id, candidates: [candidate] }, runtime) as { inserted: number; duplicates: number; candidates: Array<{ id: string }> };
  const replay = await nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", { action: "record_candidates", id: campaign.id, candidates: [candidate] }, runtime) as { inserted: number; duplicates: number; candidates: Array<{ id: string }> };
  assert.deepEqual([first.inserted, first.duplicates], [1, 0]);
  assert.deepEqual([replay.inserted, replay.duplicates], [0, 1]);
  assert.equal(first.candidates[0].id, replay.candidates[0].id);
  const list = await nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", { action: "get", id: campaign.id }, campaignRuntime()) as { candidates: unknown[] };
  assert.equal(list.candidates.length, 1);
  await assert.rejects(nativeTool(981002, "CHUCK_LEAD_CAMPAIGN", { action: "get", id: campaign.id }, campaignRuntime()), /not found|not owned/i);
  await assert.rejects(nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", {
    action: "record_candidates", id: campaign.id,
    candidates: [{ ...candidate, companyName: "Unsourced Company", domain: "unsourced.example", sourceUrls: [] }],
  }, runtime), /sourceUrls.*minItems/i);
});

test("campaign Treg reservations are atomic, cumulative, and bounded by the configured cap", async () => {
  const campaign = await tool({
    action: "start", title: "Bounded campaign", objective: "Find prospects",
    idealCustomerProfile: "B2B services", geography: "US", targetCount: 10,
    maxTregSpendUsd: 1, idempotencyKey: "campaign-treg-cap-test",
  }) as { id: string; missionId: string };
  const first = await reserveLeadCampaignTregSpend(981001, campaign.missionId, 0.8);
  const second = await reserveLeadCampaignTregSpend(981001, campaign.missionId, 0.5);
  assert.deepEqual(first, { campaignId: campaign.id, reservedUsd: 0.8 });
  assert.deepEqual(second, { campaignId: campaign.id, reservedUsd: 0.2 });
  await settleLeadCampaignTregSpend(981001, campaign.id, first!.reservedUsd, 0.6);
  await settleLeadCampaignTregSpend(981001, campaign.id, second!.reservedUsd, 0.1);
  const finalReservation = await reserveLeadCampaignTregSpend(981001, campaign.missionId, 0.31);
  assert.deepEqual(finalReservation, { campaignId: campaign.id, reservedUsd: 0.3 });
  await assert.rejects(reserveLeadCampaignTregSpend(981001, campaign.missionId, 0.01), /exhausted/i);
});

test("finalization records a server-derived snapshot and freezes the candidate set", async () => {
  const campaign = await tool({
    action: "start", title: "Finalize test", objective: "Find one company",
    idealCustomerProfile: "B2B services", geography: "US", targetCount: 1,
    maxTregSpendUsd: 0, idempotencyKey: "campaign-finalize-test",
  }) as { id: string; missionId: string };
  const runtime = campaignRuntime({ missionId: campaign.missionId });
  await nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", { action: "record_candidates", id: campaign.id, candidates: [{
    companyName: "Northstar Mechanical", domain: "northstar.example", sourceUrls: ["https://northstar.example/about"],
    evidenceSummary: "Source describes commercial HVAC services in Texas.", qualificationStatus: "qualified", qualificationReason: "Matches stated segment and geography.",
  }] }, runtime);
  const finalized = await nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", { action: "finalize", id: campaign.id }, runtime) as { candidateCount: number; qualifiedCount: number; shortfall: number; evidenceRecorded: boolean };
  assert.deepEqual([finalized.candidateCount, finalized.qualifiedCount, finalized.shortfall, finalized.evidenceRecorded], [1, 1, 0, true]);
  const mission = await getMission(981001, campaign.missionId);
  assert.ok(mission?.evidence?.some((item) => item.id === `lead_campaign_${campaign.id}_snapshot` && item.verifiedBy === "system"));
  await assert.rejects(nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", { action: "record_candidates", id: campaign.id, candidates: [{
    companyName: "Another company", sourceUrls: ["https://example.org"], evidenceSummary: "A source-backed candidate.",
  }] }, runtime), /finalized/i);
  await assert.rejects(nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", { action: "update_candidate", id: campaign.id, candidateId: "missing", qualificationStatus: "review" }, runtime), /finalized/i);
});

test("candidate persistence and finalization serialize around one immutable snapshot", async () => {
  const campaign = await tool({
    action: "start", title: "Concurrent finalize", objective: "Find a company",
    idealCustomerProfile: "B2B services", geography: "US", targetCount: 1,
    maxTregSpendUsd: 0, idempotencyKey: "campaign-concurrent-finalize",
  }) as { id: string; missionId: string };
  const write = upsertLeadCampaignCandidates(981001, campaign.id, [{
    dedupeKey: "company:concurrent.example", companyName: "Concurrent Co", domain: "concurrent.example",
    sourceUrls: ["https://concurrent.example/about"], evidenceSummary: "Source describes the company.",
    qualificationStatus: "review", enrichmentStatus: "not_started", enrichmentFields: [],
  }]);
  const finalize = finalizeLeadCampaign(981001, campaign.id, campaign.missionId);
  const [writeResult, finalResult] = await Promise.allSettled([write, finalize]);
  assert.equal(finalResult.status, "fulfilled");
  const finalized = (finalResult as PromiseFulfilledResult<Awaited<typeof finalize>>).value;
  assert.ok(finalized);
  const saved = await listLeadCampaignCandidates(981001, campaign.id, { limit: 10 });
  assert.equal(finalized.candidateCount, saved.length);
  if (writeResult.status === "rejected") assert.match(String(writeResult.reason), /finalized/i);
});

test("lead campaigns are private-only even though their durable worker can update its own campaign", async () => {
  await assert.rejects(nativeTool(981001, "CHUCK_LEAD_CAMPAIGN", { action: "list" }, { sharedConversation: true }), /private owner conversation/i);
});
