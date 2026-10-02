/** Errors raised by the owner-scoped E2B browser adapter. */
export class E2BBrowserError extends Error {
  readonly code: string;

  constructor(message: string, code = "browser_error") {
    super(message);
    this.name = "E2BBrowserError";
    this.code = code;
  }
}
