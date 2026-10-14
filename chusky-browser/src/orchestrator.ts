import { randomUUID } from "node:crypto";
import type { BrowserAdapter, BrowserObservation, BrowserPolicy, BrowserRunResult, BrowserTask, SessionHandle } from "./contracts.js";
import { planObservation, hasPageProgress } from "./observation.js";
import { defaultBrowserPolicy, assertSafeNavigationTarget, actionRequiresApproval } from "./safety.js";
import { classifyFailure } from "./recovery.js";
import { TraceSink } from "./trace.js";
import { ChallengeManager, type ChallengeOutcome } from "./challenge-manager.js";

export class BrowserOrchestrator {
  private readonly challenges: ChallengeManager;

  constructor(private readonly adapter: BrowserAdapter, private readonly now: () => number = Date.now) {
    this.challenges = new ChallengeManager(adapter, { now });
  }

  async run(task: BrowserTask): Promise<BrowserRunResult> {
    const policy: BrowserPolicy = defaultBrowserPolicy(task.policy);
    const start = this.now();
    assertSafeNavigationTarget(task.startUrl, policy);
    const trace = new TraceSink();
    const completedActions: string[] = [];
    let session: SessionHandle | undefined;
    let finalObservation: BrowserObservation | undefined;
    let challenge: ChallengeOutcome | undefined;
    let retainSession = false;
    let noProgress = 0;
    trace.add({ taskId: task.id, phase: "start", status: "started", provider: this.adapter.id });

    try {
      if (!task.actions.length) throw new Error("browser task requires at least one bounded action");
      session = await this.adapter.start({ ownerScope: task.ownerScope, startUrl: task.startUrl, headful: this.adapter.capabilities.has("live-view") });
      for (const action of task.actions) {
        if (completedActions.length >= policy.maxActions) return this.blocked(task, trace, session, finalObservation, completedActions, "max-actions");
        if (this.now() - start >= policy.maxDurationMs) return this.blocked(task, trace, session, finalObservation, completedActions, "deadline");

        let before = await this.adapter.observe(session, planObservation(finalObservation, completedActions.length ? "changed" : "initial", { screenshotMode: policy.defaultScreenshot }));
        finalObservation = before;
        trace.observation({ taskId: task.id, sessionId: session.id }, before, "succeeded");
        if (before.challenge?.detected) {
          const challengeResult = await this.resolveChallenge(task, trace, session, before, policy);
          challenge = challengeResult.outcome;
          if (challengeResult.status !== "verified") {
            retainSession = challengeResult.status === "user-required";
            return this.blocked(task, trace, session, challengeResult.observation ?? before, completedActions, `challenge-${challengeResult.status}`, challenge);
          }
          before = challengeResult.observation ?? before;
          finalObservation = before;
        }

        if (actionRequiresApproval(action) && !task.approvedActionIds?.includes(action.id)) {
          trace.add({ taskId: task.id, sessionId: session.id, phase: "recover", actionId: action.id, status: "waiting", provider: this.adapter.id, errorCode: "approval-required", recovery: "stop" });
          return this.blocked(task, trace, session, before, completedActions, "approval-required");
        }

        let attemptedRecovery = false;
        while (true) {
          try {
            const actionResult = await this.adapter.act(session, action);
            const after = actionResult.observation ?? await this.adapter.observe(session, planObservation(before, "after-action", { screenshotMode: policy.defaultScreenshot }));
            finalObservation = after;
            trace.observation({ taskId: task.id, sessionId: session.id, actionId: action.id }, after, "succeeded");
            const verification = await this.adapter.verify(session, action.expected ?? [], before, after);
            trace.add({ taskId: task.id, sessionId: session.id, phase: "verify", actionId: action.id, status: verification.verified ? "succeeded" : "failed", provider: this.adapter.id, urlOrigin: after.origin, pageGeneration: after.pageGeneration, accessibilityHash: after.accessibilityHash, screenshotHash: after.screenshot?.hash });
            if (!verification.verified) return this.blocked(task, trace, session, after, completedActions, "postcondition-failed");
            if (hasPageProgress(before, after)) noProgress = 0; else noProgress += 1;
            completedActions.push(action.id);
            if (noProgress >= policy.noProgressLimit) return this.blocked(task, trace, session, after, completedActions, "no-progress");
            break;
          } catch (error) {
            const recovery = classifyFailure(error, action);
            trace.add({ taskId: task.id, sessionId: session.id, phase: "recover", actionId: action.id, status: recovery.next === "stop" ? "failed" : "replanned", provider: this.adapter.id, errorCode: recovery.reason, recovery: recovery.next });
            if (recovery.next === "wait-for-challenge" || recovery.next === "handoff") {
              const challengeResult = await this.resolveChallenge(task, trace, session, finalObservation, policy);
              challenge = challengeResult.outcome;
              if (challengeResult.status === "verified" && recovery.retryAction && !attemptedRecovery) {
                attemptedRecovery = true;
                before = challengeResult.observation ?? before;
                continue;
              }
              retainSession = challengeResult.status === "user-required";
              return this.blocked(task, trace, session, challengeResult.observation ?? finalObservation, completedActions, `challenge-${challengeResult.status}`, challenge);
            }
            if (recovery.retryAction && !attemptedRecovery) {
              attemptedRecovery = true;
              before = await this.adapter.observe(session, planObservation(before, "changed", { screenshotMode: policy.defaultScreenshot }));
              finalObservation = before;
              trace.observation({ taskId: task.id, sessionId: session.id, actionId: action.id }, before, "replanned");
              continue;
            }
            return this.blocked(task, trace, session, finalObservation, completedActions, recovery.next);
          }
        }
      }
      return { taskId: task.id, status: "completed", verified: true, completedActions, finalObservation, events: trace.list(), ...(challenge ? { challenge } : {}) };
    } catch (error) {
      trace.add({ taskId: task.id, phase: "stop", status: "failed", provider: this.adapter.id, errorCode: String(error instanceof Error ? error.message : error).slice(0, 120) });
      return { taskId: task.id, status: "failed", verified: false, completedActions, finalObservation, events: trace.list(), reason: String(error instanceof Error ? error.message : error), ...(challenge ? { challenge } : {}) };
    } finally {
      if (session) {
        trace.add({ taskId: task.id, sessionId: session.id, phase: "stop", status: "started", provider: this.adapter.id });
        if (!retainSession) await this.adapter.stop(session).catch(() => undefined);
      }
    }
  }

  private async resolveChallenge(task: BrowserTask, trace: TraceSink, session: SessionHandle, observation: BrowserObservation, policy: BrowserPolicy) {
    trace.add({ taskId: task.id, sessionId: session.id, phase: "handoff", status: "waiting", provider: this.adapter.id, urlOrigin: observation.origin, pageGeneration: observation.pageGeneration });
    const result = await this.challenges.resolve({ session, observation, policy });
    return result;
  }

  private blocked(task: BrowserTask, trace: TraceSink, session: SessionHandle, finalObservation: BrowserObservation | undefined, completedActions: string[], reason: string, challenge?: ChallengeOutcome): BrowserRunResult {
    return { taskId: task.id, status: reason === "deadline" ? "timed-out" : "blocked", verified: false, completedActions, finalObservation, events: trace.list(), reason, ...(challenge ? { challenge, continuation: { session, challenge } } : {}), nextAction: challenge?.state === "handoff_required" ? "complete handoff and verify" : undefined };
  }
}

export function createActionId(prefix = "action"): string { return `${prefix}_${randomUUID()}`; }
