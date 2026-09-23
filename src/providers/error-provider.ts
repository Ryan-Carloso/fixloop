// Core FixLoop abstractions. All repair logic operates on ErrorContext;
// nothing downstream may depend on a specific provider's payload shape.

export interface ExceptionInfo {
  type: string;
  message: string;
  stacktrace?: string;
}

export interface ErrorContext {
  provider: string;
  issueId: string;
  project?: string;
  exception: ExceptionInfo;
  breadcrumbs?: unknown[];
  environment?: string;
  release?: string;
  commitSha?: string;
  metadata?: Record<string, unknown>;
}

export interface ErrorProvider {
  /** Stable provider name, e.g. "bugsink". Used in dedup keys and logs. */
  readonly name: string;
  /** Validate a raw webhook payload and normalize it into an ErrorContext. */
  parse(payload: unknown): Promise<ErrorContext>;
}

export class ErrorParseError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ErrorParseError";
  }
}
