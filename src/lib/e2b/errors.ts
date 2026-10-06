/** Errors raised by the owner-scoped E2B browser adapter. */
export class E2BBrowserError extends Error {
  readonly code: string;

  constructor(message: string, code = "browser_error") {
    super(message);
    this.name = "E2BBrowserError";
    this.code = code;
  }
}

export class E2BBrowserHandoffWaitingError extends E2BBrowserError {
  readonly handoffId: string;
  readonly expiresAt: number;

  constructor(handoffId: string, expiresAt: number) {
    super("A private browser handoff is waiting for the owner. Do not interact with or navigate the page until the owner returns and completes the handoff.", "handoff_waiting_for_owner");
    this.name = "E2BBrowserHandoffWaitingError";
    this.handoffId = handoffId;
    this.expiresAt = expiresAt;
  }
}
