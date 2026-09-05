import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const ENV_PATH = resolve(process.cwd(), ".env");
const REQUIRED = ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY", "COMPOSIO_API_KEY"] as const;
const DEFAULTS: Record<string, string> = { DEFAULT_MODEL: "~deepseek/deepseek-v4-flash-latest", VISION_MODEL: "openai/gpt-5.6-luna", TRANSCRIPTION_MODEL: "openai/gpt-transcribe", IMAGE_MODEL: "x-ai/grok-imagine-image-2.0", VIDEO_MODEL: "bytedance/seedance-2.0-mini", PORT: "8080" };
export type SetupHealth = { key: string; status: "configured" | "missing" | "optional"; detail: string };

export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}

function encodeEnv(value: string): string { return value === "" ? "" : JSON.stringify(value); }

export function mergeEnv(text: string, updates: Record<string, string>): string {
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/).map((raw) => {
    const match = raw.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=).*$/);
    if (!match || !(match[2] in updates)) return raw;
    seen.add(match[2]);
    return `${match[1]}${match[2]}=${encodeEnv(updates[match[2]])}`;
  });
  for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) lines.push(`${key}=${encodeEnv(value)}`);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export async function readEnvFile(path = ENV_PATH): Promise<{ text: string; values: Map<string, string> }> {
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  return { text, values: parseEnv(text) };
}

export async function writeEnvFile(updates: Record<string, string>, path = ENV_PATH): Promise<void> {
  const current = await readEnvFile(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, mergeEnv(current.text, updates), { encoding: "utf8", mode: 0o600 });
}

export function healthReport(values: Map<string, string>): SetupHealth[] {
  const rows: SetupHealth[] = REQUIRED.map((key) => ({ key, status: values.get(key) ? "configured" : "missing", detail: values.get(key) ? "configured" : "required" }));
  rows.push({ key: "REDIS_URL", status: values.get("REDIS_URL") ? "configured" : "optional", detail: values.get("REDIS_URL") ? "configured" : "recommended for persistence" });
  rows.push({ key: "WEBHOOK_URL", status: values.get("WEBHOOK_URL") ? "configured" : "optional", detail: values.get("WEBHOOK_URL") ? "webhook mode" : "polling mode" });
  rows.push({ key: "QSTASH_TOKEN", status: values.get("QSTASH_TOKEN") ? "configured" : "optional", detail: values.get("QSTASH_TOKEN") ? "workflow features enabled" : "reminders/jobs/video workflows unavailable" });
  rows.push({ key: "DASHBOARD_URL", status: values.get("DASHBOARD_URL") ? "configured" : "optional", detail: values.get("DASHBOARD_URL") ? "dashboard links enabled" : "set this to enable /dashboard links" });
  if (values.get("SENDBLUE_ENABLED") === "true") {
    for (const key of ["SENDBLUE_API_KEY", "SENDBLUE_API_SECRET", "SENDBLUE_NUMBER", "SENDBLUE_WEBHOOK_SECRET"]) {
      rows.push({ key, status: values.get(key) ? "configured" : "missing", detail: values.get(key) ? "configured" : "required when Sendblue is enabled" });
    }
  }
  for (const key of ["DAYTONA_API_KEY"]) rows.push({ key, status: values.get(key) ? "configured" : "optional", detail: values.get(key) ? "configured" : "optional integration" });
  for (const key of Object.keys(DEFAULTS)) rows.push({ key, status: values.get(key) ? "configured" : "optional", detail: values.get(key) ? "configured" : `default: ${DEFAULTS[key]}` });
  return rows;
}

async function ask(message: string, fallback = ""): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(message)).trim() || fallback; } finally { rl.close(); }
}

async function secret(message: string, fallback = ""): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return ask(message, fallback);
  stdout.write(message); stdin.setRawMode(true); stdin.resume();
  return await new Promise<string>((resolveSecret, reject) => {
    let value = "";
    const cleanup = () => { stdin.off("data", onData); stdin.setRawMode(false); };
    const onData = (chunk: Buffer) => { for (const char of chunk.toString("utf8")) {
      if (char === "\u0003") { cleanup(); reject(new Error("Setup cancelled")); return; }
      if (char === "\r" || char === "\n") { stdout.write("\n"); cleanup(); resolveSecret(value || fallback); return; }
      if (char === "\u007f" || char === "\b") { if (value) value = value.slice(0, -1); continue; }
      if (char >= " ") value += char;
    }};
    stdin.on("data", onData);
  });
}

async function valueFor(key: string, current: Map<string, string>, isSecret = false): Promise<string> {
  const existing = current.get(key); const suffix = existing ? " [keep]" : "";
  return isSecret ? secret(`${key}${suffix}: `, existing ?? "") : ask(`${key}${suffix}: `, existing ?? "");
}

export async function runSetup(): Promise<void> {
  const current = (await readEnvFile()).values;
  console.log("Chusky setup — press Enter to keep existing values or skip optional settings.\n");
  const updates: Record<string, string> = {};
  for (const key of REQUIRED) updates[key] = await valueFor(key, current, true);
  const selectedMode = (await ask(`Telegram mode [${current.get("WEBHOOK_URL") ? "webhook" : "polling"}] (polling/webhook): `, current.get("WEBHOOK_URL") ? "webhook" : "polling")).toLowerCase();
  if (selectedMode !== "polling" && selectedMode !== "webhook") throw new Error("Telegram mode must be polling or webhook");
  if (selectedMode === "webhook") {
    updates.WEBHOOK_URL = await valueFor("WEBHOOK_URL", current);
    if (!/^https:\/\//i.test(updates.WEBHOOK_URL)) throw new Error("WEBHOOK_URL must use HTTPS in webhook mode");
    updates.WEBHOOK_SECRET = current.get("WEBHOOK_SECRET") || randomBytes(24).toString("base64url");
    updates.COMPOSIO_WEBHOOK_SECRET = current.get("COMPOSIO_WEBHOOK_SECRET") || randomBytes(24).toString("base64url");
  } else updates.WEBHOOK_URL = "";
  console.log("\nOptional production features (press Enter to skip):");
  for (const key of ["REDIS_URL", "QSTASH_TOKEN", "DAYTONA_API_KEY"] as const) updates[key] = await valueFor(key, current, true);
  if (updates.QSTASH_TOKEN) for (const key of ["QSTASH_URL", "VIDEO_WORKFLOW_URL", "REMINDER_WORKFLOW_URL", "JOB_WORKFLOW_URL", "TRIGGER_WORKFLOW_URL"]) updates[key] = await valueFor(key, current);
  for (const [key, fallback] of Object.entries(DEFAULTS)) updates[key] = current.get(key) || fallback;
  await writeEnvFile(updates);
  const report = healthReport((await readEnvFile()).values);
  console.log(`\nSaved ${ENV_PATH}\n`);
  for (const row of report) console.log(`${row.status === "configured" ? "✓" : row.status === "missing" ? "!" : "·"} ${row.key}: ${row.detail}`);
  console.log("\nRun `chusky doctor` to validate the configuration and service connectivity.");
}

export async function runDoctor(serverOverride?: string): Promise<void> {
  const { values } = await readEnvFile(); console.log("Chusky doctor\n");
  for (const row of healthReport(values)) console.log(`${row.status === "configured" ? "✓" : row.status === "missing" ? "!" : "·"} ${row.key}: ${row.detail}`);
  const server = serverOverride || values.get("WEBHOOK_URL");
  if (server) try {
    const response = await fetch(`${server.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(10000) });
    console.log(`${response.ok ? "✓" : "!"} service health: HTTP ${response.status}`);
    const body = await response.json().catch(() => undefined) as { checks?: Record<string, string>; monitoring?: { counters?: Record<string, number> } } | undefined;
    for (const [key, status] of Object.entries(body?.checks ?? {})) console.log(`${status === "ok" || status === "configured" || status === "disabled" ? "✓" : "!"} service ${key}: ${status}`);
    const failures = Object.entries(body?.monitoring?.counters ?? {}).filter(([, count]) => count > 0);
    if (failures.length) console.log(`! runtime failures: ${failures.map(([key, count]) => `${key}=${count}`).join(", ")}`);
  } catch (error) { console.log(`! service health: ${error instanceof Error ? error.message : String(error)}`); }
  else console.log("· service health: skipped (polling mode)");
  if (!values.get("REDIS_URL")) console.log("\nRecommendation: configure REDIS_URL before production use.");
}
