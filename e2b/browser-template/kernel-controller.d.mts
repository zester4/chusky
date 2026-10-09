export class CaptchaTracker {
  constructor(now?: () => number, deadlineMs?: number);
  accept(event: { type: string; data?: { task_id?: string; status?: string } }): void;
  snapshot(): { pending: boolean; results: string[]; pageVerificationRequired: boolean };
}
export function waitForChallengeClear(probe: () => Promise<{ detected: boolean; type?: string }>, options: { timeoutMs: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<{ challenge: { detected: boolean; type?: string }; verified: boolean; timedOut: boolean }>;
