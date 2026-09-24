import { sanitizeForPr } from "../fixloop.js";

/**
 * Redact secret-looking patterns from arbitrary text (logs, summaries,
 * doctor output, errors). Reuses the PR-body sanitizer so there is one
 * redaction rule set.
 */
export function redactSecrets(text: string): string {
  return sanitizeForPr(text);
}

/** Masked display form of a secret: never contains the secret itself. */
export function maskSecret(secret: string): string {
  if (!secret) return "(not set)";
  return "*".repeat(12);
}

/**
 * Replace every verbatim occurrence of a known secret with a mask.
 * Defense-in-depth for CLI output: the wizard never interpolates secrets
 * by construction, and this scrubs them if one ever slips through.
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4 && out.includes(s)) {
      out = out.split(s).join("***");
    }
  }
  return out;
}

/** True if any of the given secrets appears verbatim in the text. */
export function containsSecret(text: string, secrets: string[]): boolean {
  return secrets.some((s) => s.length > 0 && text.includes(s));
}

/**
 * Throw if any secret appears verbatim in the text. Used by tests to prove
 * CLI output never leaks entered secrets.
 */
export function assertNoSecrets(text: string, secrets: string[]): void {
  for (const s of secrets) {
    if (s.length > 0 && text.includes(s)) {
      throw new Error(
        `secret leaked into output: ...${s.slice(-4)} (last 4 chars shown)`,
      );
    }
  }
}
