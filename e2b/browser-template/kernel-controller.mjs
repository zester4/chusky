import Kernel from "@onkernel/sdk";

/** Bounded metadata only; solver answers and page contents are never retained. */
const SOLVE_STATUSES = ["success", "failure", "timeout", "abandoned"];
const CHALLENGE_STATUSES = ["solved", "failure", "timeout", "abandoned"];
const CAPTCHA_TYPES = ["hcaptcha", "recaptcha_v2", "recaptcha_v3", "turnstile", "geetest", "press_and_hold", "other"];
const CAPTCHA_PROVIDERS = ["hcaptcha", "recaptcha_v2", "recaptcha_v3", "turnstile", "geetest", "arkose", "human", "other"];

function boundedId(value) {
  return typeof value === "string" && value && value.length <= 200 ? value : undefined;
}

function captchaType(data = {}) {
  if (CAPTCHA_TYPES.includes(data.captcha_type)) return data.captcha_type;
  if (data.task_kind === "press_and_hold" || data.captcha_provider === "human") return "press_and_hold";
  if (CAPTCHA_TYPES.includes(data.captcha_provider)) return data.captcha_provider;
  if (CAPTCHA_PROVIDERS.includes(data.captcha_provider)) return data.captcha_provider;
  return "other";
}

export class CaptchaTracker {
  constructor(now = Date.now, deadlineMs = 20_000) {
    this.now = now;
    this.deadlineMs = deadlineMs;
    this.tasks = new Map();
    this.solveResults = [];
    this.challengeResults = [];
    this.sequence = 0;
  }

  cursor() { return this.sequence; }

  accept(event) {
    const data = event?.data ?? {};
    if (!["captcha_solve_started", "captcha_solve_result", "captcha_challenge_result"].includes(event?.type)) return;
    const sequence = ++this.sequence;
    const id = boundedId(data.task_id);
    if (event.type === "captcha_solve_started") {
      if (!id) return;
      const task = this.tasks.get(id) ?? { at: this.now() };
      task.captchaType = captchaType(data);
      this.tasks.set(id, task);
    } else if (event.type === "captcha_solve_result") {
      const status = SOLVE_STATUSES.includes(data.status) ? data.status : undefined;
      if (!status) return;
      const task = id ? (this.tasks.get(id) ?? { at: this.now() }) : undefined;
      if (task) {
        task.status = status;
        task.captchaType = captchaType(data);
        this.tasks.set(id, task);
      }
      this.solveResults.push({ sequence, status, captchaType: captchaType(data) });
    } else {
      const status = CHALLENGE_STATUSES.includes(data.status) ? data.status : undefined;
      if (!status) return;
      this.challengeResults.push({ sequence, status, captchaType: captchaType(data) });
    }
    if (this.tasks.size > 100) this.tasks.delete(this.tasks.keys().next().value);
    if (this.solveResults.length > 100) this.solveResults.shift();
    if (this.challengeResults.length > 100) this.challengeResults.shift();
  }

  terminalSince(sequence = 0) {
    const terminal = [
      ...this.solveResults,
      ...this.challengeResults,
    ].filter(item => item.sequence > sequence).sort((left, right) => left.sequence - right.sequence);
    return terminal.at(-1);
  }

  snapshot() {
    return {
      pending: [...this.tasks.values()].some(task => !task.status && this.now() - task.at < this.deadlineMs),
      results: this.solveResults.map(item => item.status),
      challengeResults: this.challengeResults.map(item => item.status),
      pageVerificationRequired: true,
    };
  }
}

export async function waitForChallengeClear(probe, { timeoutMs, signal, tracker, afterSequence = 0, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  if (signal?.aborted) throw new Error("Browser operation cancelled");
  const deadline = now() + timeoutMs;
  let challenge = await probe();
  while (challenge.detected && challenge.type === "captcha" && now() < deadline) {
    if (signal?.aborted) throw new Error("Browser operation cancelled");
    const terminal = tracker?.terminalSince(afterSequence);
    if (terminal && ["failure", "timeout", "abandoned"].includes(terminal.status)) {
      return { challenge, verified: false, timedOut: terminal.status === "timeout", terminalStatus: terminal.status };
    }
    await sleep(Math.min(500, Math.max(0, deadline - now())));
    if (signal?.aborted) throw new Error("Browser operation cancelled");
    challenge = await probe();
  }
  const terminal = tracker?.terminalSince(afterSequence);
  return {
    challenge,
    verified: !challenge.detected,
    timedOut: challenge.detected && challenge.type === "captcha" && now() >= deadline,
    ...(terminal?.status ? { terminalStatus: terminal.status } : {}),
  };
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
      // The browser daemon can finish attaching after the first navigation. Replay
      // retained events so a challenge result emitted during that attach race is not
      // lost; the tracker keeps only bounded status/type metadata.
      stream = await client.browsers.telemetry.stream(id, { replay: "all" });
      if (stopped) { stream.controller.abort(); return; }
      for await (const item of stream) {
        if (item.event?.category === "captcha") {
          tracker.accept(item.event);
          recordEvent(item.event.type, {
            status: [...SOLVE_STATUSES, ...CHALLENGE_STATUSES].includes(item.event.data?.status) ? item.event.data.status : undefined,
            captchaType: captchaType(item.event.data),
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
      const afterSequence = tracker.cursor();
      const outcome = await waitForChallengeClear(probe, { timeoutMs, signal: operationSignal, tracker, afterSequence });
      recordEvent("captcha_page_verification", { verified: outcome.verified, timedOut: outcome.timedOut, terminalStatus: outcome.terminalStatus });
      return outcome;
    },
    close() { stopped = true; stream?.controller.abort(); },
  };
}
