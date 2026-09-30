import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createAttentionRecord, listAttentionRecords, updateAttentionRecord, type TinyFishMonitorRecord } from "./store.js";

const MAX_WEBHOOK_BYTES = 1_000_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function tinyFishMonitorSignature(apiKey: string, userId: number, internalId: string): string {
  return createHmac("sha256", apiKey).update(`tinyfish-monitor:${userId}:${internalId}`).digest("hex");
}

export function verifyTinyFishMonitorSignature(apiKey: string, userId: number, internalId: string, signature: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(tinyFishMonitorSignature(apiKey, userId, internalId), "hex");
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function validateTinyFishMonitorSchedule(type: "fetch" | "search", value: string): string {
  const schedule = value.trim();
  const fields = schedule.replace(/^CRON_TZ=[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*\s+/, "").split(/\s+/);
  if (fields.length !== 5) throw new Error("scheduleCron must be a five-field cron expression, optionally prefixed with CRON_TZ=<IANA timezone>.");
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (!/^[0-9*/?,\-]+$/.test(field)) throw new Error("scheduleCron contains unsupported cron syntax.");
    for (const part of field.split(",")) {
      const [base, step] = part.split("/");
      if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1 || Number(step) > ranges[index]![1] + 1)) throw new Error("scheduleCron contains an invalid step value.");
      if (base === "*" || base === "?") continue;
      const rangeParts = base!.split("-");
      if (rangeParts.some((item) => !/^\d+$/.test(item) || Number(item) < ranges[index]![0] || Number(item) > ranges[index]![1])) throw new Error("scheduleCron contains an out-of-range value.");
      if (rangeParts.length > 2 || (rangeParts.length === 2 && Number(rangeParts[0]) > Number(rangeParts[1]))) throw new Error("scheduleCron contains an invalid range.");
    }
  }
  const minute = fields[0]!;
  const interval = /^\*\/(\d+)$/.exec(minute)?.[1];
  const listedMinutes = /^\d+(?:,\d+)*$/.test(minute) ? minute.split(",").map(Number).sort((a, b) => a - b) : undefined;
  const listedMinutesAreSafe = listedMinutes?.length
    ? listedMinutes.every((item, index) => (listedMinutes[(index + 1) % listedMinutes.length]! + (index === listedMinutes.length - 1 ? 60 : 0) - item) >= 30)
    : false;
  if (minute !== "0" && !listedMinutesAreSafe && !(interval !== undefined && Number(interval) >= 30 && 60 % Number(interval) === 0)) {
    throw new Error("TinyFish monitors must run at least 30 minutes apart; use */30 or a fixed minute such as 0.");
  }
  return schedule;
}

function safeMonitorSummary(payload: Record<string, unknown>, monitor: TinyFishMonitorRecord): { status: "changed" | "unchanged" | "failed"; summary: string; snapshotHash?: string; failed: boolean } {
  const outcome = record(payload.outcome);
  const status = String(payload.status ?? payload.event ?? "").toLowerCase();
  const errors = Array.isArray(payload.errors) ? payload.errors.slice(0, 10) : [];
  if (errors.length || status.includes("failed") || status.includes("error") || payload.error) {
    return { status: "failed", summary: `${errors.length || 1} monitored source${errors.length === 1 ? "" : "s"} could not be checked.`, failed: true };
  }
  const goalJudgement = payload.meaningful ?? payload.matches_goal ?? payload.goal_matched ?? payload.met_goal ?? outcome.meaningful ?? outcome.matches_goal ?? outcome.goal_matched ?? outcome.met_goal;
  const providerSummary = [payload.summary, payload.change_summary, payload.judgement_summary, outcome.summary, outcome.change_summary]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim().slice(0, 900);
  if (monitor.monitorType === "search") {
    const positions = Array.isArray(payload.new_result_positions) ? payload.new_result_positions.filter((item) => typeof item === "number") : [];
    const results = Array.isArray(payload.results) ? payload.results : [];
    const fresh = results.filter((item) => {
      const position = record(item).position;
      return typeof position === "number" && positions.includes(position);
    }).slice(0, 5).map((item) => {
      const result = record(item);
      return typeof result.title === "string" ? result.title.slice(0, 200) : "New search result";
    });
    if (goalJudgement === false) return { status: "unchanged", summary: providerSummary ?? "The monitor found no results matching its goal.", failed: false };
    return positions.length || goalJudgement === true
      ? { status: "changed", summary: providerSummary ?? `${positions.length || fresh.length} new result${(positions.length || fresh.length) === 1 ? "" : "s"} found${fresh.length ? `: ${fresh.join("; ")}` : "."}`.slice(0, 900), failed: false }
      : { status: "unchanged", summary: providerSummary ?? "No new topic results.", failed: false };
  }
  const results = Array.isArray(payload.results) ? payload.results.slice(0, 10) : [];
  const snapshotHash = tinyFishMonitorSnapshotHash(payload);
  const isBaseline = payload.is_baseline === true || record(payload.data).is_baseline === true || record(payload.result).is_baseline === true;
  const changed = !isBaseline && goalJudgement !== false && (goalJudgement === true || (Boolean(monitor.snapshotHash) && monitor.snapshotHash !== snapshotHash));
  const title = typeof record(results[0]).title === "string" ? String(record(results[0]).title).slice(0, 200) : monitor.targetUrl ?? "monitored page";
  return { status: changed ? "changed" : "unchanged", summary: providerSummary ?? (changed ? `TinyFish judged a meaningful change on ${title}.` : isBaseline ? `Baseline captured for ${title}.` : `No meaningful change on ${title}.`), snapshotHash, failed: false };
}

export function tinyFishMonitorSnapshotHash(payload: Record<string, unknown>): string {
  const results = Array.isArray(payload.results) ? payload.results.slice(0, 10) : [];
  const snapshot = results.map((item) => {
    const result = record(item);
    return { url: result.final_url ?? result.url, title: result.title, text: result.text };
  });
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export async function receiveTinyFishMonitorWebhook(input: {
  userId: number; internalId: string; signature: string; apiKey: string; rawBody: Uint8Array;
}): Promise<{ accepted: boolean; duplicate?: boolean; ignored?: boolean }> {
  if (input.rawBody.byteLength > MAX_WEBHOOK_BYTES) throw new Error("Monitor callback exceeds the 1 MB limit.");
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || !verifyTinyFishMonitorSignature(input.apiKey, input.userId, input.internalId, input.signature)) throw new Error("Invalid monitor callback authorization.");
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(input.rawBody).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid JSON object");
    payload = parsed as Record<string, unknown>;
  } catch { throw new Error("Invalid monitor callback payload."); }

  const monitor = (await listAttentionRecords(input.userId, "tinyfish_monitor", { limit: 200 }) as TinyFishMonitorRecord[]).find((item) => item.callbackId === input.internalId);
  if (!monitor || monitor.status === "paused" || monitor.status === "failed" || monitor.status === "deleted") throw new Error("Monitor is not active for this owner.");
  const data = record(payload.data ?? payload.result);
  const providerId = payload.fetch_monitor_id ?? payload.search_monitor_id ?? payload.monitor_id ?? payload.monitorId ?? record(payload.monitor).id ?? data.fetch_monitor_id ?? data.search_monitor_id ?? data.monitor_id ?? record(data.monitor).id;
  const runIdValue = payload.run_id ?? payload.id ?? data.run_id ?? data.id;
  if (providerId !== monitor.providerMonitorId || typeof runIdValue !== "string" || runIdValue.length > 160) throw new Error("Monitor callback identity does not match the owner record.");
  const runId = runIdValue;
  if (monitor.runHistory.some((run) => run.id === runId)) return { accepted: true, duplicate: true };

  const summary = safeMonitorSummary({ ...data, ...payload }, monitor);
  const now = Date.now();
  const runHistory = [...monitor.runHistory, { id: runId, occurredAt: now, status: summary.status, summary: summary.summary }].slice(-20);
  const updated = await updateAttentionRecord(input.userId, "tinyfish_monitor", monitor.id, {
    lastRunId: runId, lastRunAt: now, lastSummary: summary.summary, lastError: summary.failed ? summary.summary : "",
    // A failed check is a failed run, not a disabled subscription. Keep the
    // monitor active so the next scheduled check can recover automatically.
    status: "active", snapshotHash: summary.snapshotHash ?? monitor.snapshotHash, runHistory,
  });
  if (!updated) throw new Error("Monitor owner record disappeared during callback processing.");
  if (summary.status === "unchanged" || payload.is_baseline === true || data.is_baseline === true) return { accepted: true, ignored: true };

  await createAttentionRecord(input.userId, "observation", {
    source: "tinyfish_monitor", eventType: summary.failed ? "monitor_check_failed" : "monitor_changed",
    summary: `TinyFish monitor “${monitor.name}”: ${summary.summary}${monitor.purpose ? ` Purpose: ${monitor.purpose.slice(0, 300)}` : ""}`,
    entityId: monitor.id, dedupeKey: `tinyfish:${monitor.id}:${runId}`.slice(0, 300), occurredAt: now,
    importance: summary.failed ? 0.8 : 0.7, novelty: 0.9, confidence: 0.95, privacyScope: "private", status: "new",
    metadata: { monitorType: monitor.monitorType, runId: runId.slice(0, 150), ...(monitor.targetUrl ? { url: monitor.targetUrl.slice(0, 400) } : {}) },
  });
  return { accepted: true };
}
