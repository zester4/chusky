/** Errors raised by the owner-scoped E2B browser adapter. */
export class E2BBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2BBrowserError";
  }
}
