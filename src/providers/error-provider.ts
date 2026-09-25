// Core FixLoop abstractions. All repair logic operates on ErrorContext;
// nothing downstream may depend on a specific provider's payload shape.
import { z } from "zod";

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

/**
 * Validates an ErrorContext read back from the database. Hydration must
 * never trust a blind cast: a hand-edited or corrupt JSONB row would flow
 * into the typed pipeline wearing a shape it was never checked against.
 * Unknown keys are preserved (.passthrough()), so fields added by future
 * providers survive a restart instead of silently vanishing.
 */
export const errorContextSchema: z.ZodType<ErrorContext> = z
  .object({
    provider: z.string(),
    issueId: z.string(),
    project: z.string().optional(),
    exception: z
      .object({
        type: z.string(),
        message: z.string(),
        stacktrace: z.string().optional(),
      })
      // Nested unknown keys (e.g. a future exception.cause or
      // provider-specific fields) must survive hydration round-trips too:
      // without this they are stripped on read and the stripped shape is
      // re-upserted on the next status write, making the loss permanent.
      .passthrough(),
    breadcrumbs: z.array(z.unknown()).optional(),
    environment: z.string().optional(),
    release: z.string().optional(),
    commitSha: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

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
