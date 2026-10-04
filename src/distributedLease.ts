export interface DistributedLeaseOperations {
  acquire(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export interface DistributedLeaseOptions {
  acquisitionAttempts?: number;
  retryDelayMs?: number;
  renewalIntervalMs?: number;
  busyMessage: string;
  lostMessage: string;
}

/** Run work under a renewable distributed lease, failing closed on lease loss. */
export async function withDistributedLease<T>(
  lease: DistributedLeaseOperations,
  work: () => Promise<T>,
  options: DistributedLeaseOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.acquisitionAttempts ?? 100));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 100));
  let acquired = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await lease.acquire()) { acquired = true; break; }
    if (attempt + 1 < attempts && retryDelayMs) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  if (!acquired) throw new Error(options.busyMessage);

  let leaseLost = false;
  let renewalInFlight: Promise<void> | undefined;
  const renewal = setInterval(() => {
    if (renewalInFlight) return;
    renewalInFlight = lease.renew().then((renewed) => { if (!renewed) leaseLost = true; }).catch(() => { leaseLost = true; }).finally(() => { renewalInFlight = undefined; });
  }, Math.max(1, Math.floor(options.renewalIntervalMs ?? 10_000)));
  let result: T;
  try {
    result = await work();
  } finally {
    clearInterval(renewal);
    await renewalInFlight;
    await lease.release();
  }
  if (leaseLost) throw new Error(options.lostMessage);
  return result;
}
