/**
 * Secret redaction for anything that leaves the machine (PR bodies,
 * Discord embeds, API notes). Pure string functions — this is a leaf
 * module on purpose: low-level code (jobs, notify) must not import the
 * orchestrator (fixloop.ts) just to redact a string.
 */

/**
 * Sanitizes an error message for inclusion in a public PR body.
 * Redacts patterns that look like secrets (API keys, tokens, passwords).
 */
export function sanitizeForPr(text: string): string {
  return (
    text
      // API keys, tokens, secrets (common prefixes).
      .replace(
        /\b(sk-[a-zA-Z0-9_-]{10,}|ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|xox[bap]-[a-zA-Z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
        "[REDACTED]",
      )
      // Generic key=value with secret-like keys. Tolerates JSON-style
      // quoting around the key and the separator ({"password":"..."}),
      // which error text echoing HTTP bodies commonly carries.
      .replace(
        /\b(api[_-]?key|token|secret|password|passwd|pwd)\s*['"]?\s*[:=]\s*['"]?\s*[^'"\s,;]+['"]?/gi,
        "$1=[REDACTED]",
      )
      // Bearer tokens.
      .replace(/\bBearer\s+[a-zA-Z0-9._-]{10,}\b/g, "Bearer [REDACTED]")
      // Credentials embedded in URLs (postgres://user:pass@host/db).
      // The username may be empty (postgres://:pass@host, redis://:pass@host).
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)[^@\s/]+@/gi,
        "$1[REDACTED]@",
      )
  );
}
