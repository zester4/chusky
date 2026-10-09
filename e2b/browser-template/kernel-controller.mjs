import Kernel from "@onkernel/sdk";

/** Bounded metadata only; solver answers and page contents are never retained. */
export class CaptchaTracker {
  constructor(now = Date.now, deadlineMs = 20_000) { this.now = now; this.deadlineMs = deadlineMs; this.tasks = new Map(); }
  accept(event) {
    const id = event.data?.task_id;
    if (typeof id !== "string" || !id || id.length > 200) return;
    const task = this.tasks.get(id) ?? { at: this.now() };
    if (event.type === "captcha_solve_result") task.status = ["success", "failure", "timeout", "abandoned"].includes(event.data.status) ? event.data.status : "unknown";
    else if (event.type !== "captcha_solve_started") return;
    this.tasks.set(id, task);
    if (this.tasks.size > 100) this.tasks.delete(this.tasks.keys().next().value);
  }
  snapshot() {
    return { pending: [...this.tasks.values()].some(task => !task.status && this.now() - task.at < this.deadlineMs), results: [...this.tasks.values()].filter(task => task.status).map(task => task.status), pageVerificationRequired: true };
  }
}

export async function waitForChallengeClear(probe, { timeoutMs, signal, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  if (signal?.aborted) throw new Error("Browser operation cancelled");
  const deadline = now() + timeoutMs;
  let challenge = await probe();
  while (challenge.detected && challenge.type === "captcha" && now() < deadline) {
    if (signal?.aborted) throw new Error("Browser operation cancelled");
    await sleep(Math.min(500, Math.max(0, deadline - now())));
    if (signal?.aborted) throw new Error("Browser operation cancelled");
    challenge = await probe();
  }
  return { challenge, verified: !challenge.detected, timedOut: challenge.detected && challenge.type === "captcha" && now() >= deadline };
}

export function createKernelController(env, recordEvent) {
  if (!env.CHUSKY_KERNEL_SESSION_ID) return undefined;
  const client = new Kernel({ apiKey: env.KERNEL_API_KEY, maxRetries: 0, timeout: 15_000 });
  const id = env.CHUSKY_KERNEL_SESSION_ID;
  const tracker = new CaptchaTracker();
  let stream;
  let stopped = false;
  let operationSignal;
  // Telemetry is best effort and unordered; live page verification is authoritative.
  void (async () => {
    try {
      stream = await client.browsers.telemetry.stream(id);
      if (stopped) { stream.controller.abort(); return; }
      for await (const item of stream) {
        if (item.event?.category === "captcha") {
          tracker.accept(item.event);
          recordEvent(item.event.type, {
            status: ["success", "failure", "timeout", "abandoned"].includes(item.event.data?.status) ? item.event.data.status : undefined,
            captchaType: ["hcaptcha", "recaptcha_v2", "recaptcha_v3", "turnstile", "geetest", "press_and_hold", "other"].includes(item.event.data?.captcha_type) ? item.event.data.captcha_type : "other",
          });
        }
      }
    } catch { if (!stopped) recordEvent("captcha_telemetry_unavailable"); }
  })();
  const configuredWait = Number(env.CHUSKY_KERNEL_CAPTCHA_WAIT_MS || 20_000);
  const timeoutMs = Number.isFinite(configuredWait) ? Math.min(30_000, Math.max(0, configuredWait)) : 20_000;
  return {
    client, id, tracker,
    setSignal(signal) { operationSignal = signal; },
    async wait(probe) {
      if (env.CHUSKY_KERNEL_STEALTH !== "true") return { challenge: await probe(), verified: false };
      const outcome = await waitForChallengeClear(probe, { timeoutMs, signal: operationSignal });
      recordEvent("captcha_page_verification", { verified: outcome.verified, timedOut: outcome.timedOut });
      return outcome;
    },
    close() { stopped = true; stream?.controller.abort(); },
  };
}
