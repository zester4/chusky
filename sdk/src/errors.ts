export class ChuskyError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(message: string, options: { status?: number; code?: string; requestId?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ChuskyError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
  }
}

export class ChuskyAuthenticationError extends ChuskyError {
  constructor(message: string, options: ConstructorParameters<typeof ChuskyError>[1] = {}) { super(message, options); this.name = "ChuskyAuthenticationError"; }
}

export class ChuskyRateLimitError extends ChuskyError {
  readonly retryAfter?: number;
  constructor(message: string, options: ConstructorParameters<typeof ChuskyError>[1] & { retryAfter?: number } = {}) { super(message, options); this.name = "ChuskyRateLimitError"; this.retryAfter = options.retryAfter; }
}
