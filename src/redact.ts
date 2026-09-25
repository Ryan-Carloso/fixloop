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
      // API keys, tokens, secrets (common prefixes). Includes modern
      // formats: fine-grained GitHub PATs, GitHub app/user/refresh
      // tokens, GitLab and npm tokens, JWTs.
      .replace(
        /\b(sk-[a-zA-Z0-9_-]{10,}|ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|gh[sur]_[a-zA-Z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,}|xox[bap]-[a-zA-Z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
        "[REDACTED]",
      )
      // Generic key=value with secret-like keys. The keyword may sit
      // inside a compound name (client_secret, access_token, api_key_id:
      // no word boundary before the keyword there), so match the full key
      // around it. Quotes and the separator are captured and re-emitted so
      // JSON-like text keeps its structure ({"password":"hunter2"} ->
      // {"password":"[REDACTED]"} instead of {"password=[REDACTED]}).
      .replace(
        /\b([\w.-]*(?:api[_-]?key|token|secret|password|passwd|pwd)[\w.-]*)\s*(['"]?)\s*([:=])\s*(['"]?)([^\s,;}\]'"]+)(['"]?)/gi,
        "$1$2$3$4[REDACTED]$6",
      )
      // Bearer tokens.
      .replace(/\bBearer\s+[a-zA-Z0-9._-]{10,}\b/g, "Bearer [REDACTED]")
      // Credentials embedded in URLs (postgres://user:pass@host/db).
      // The username may be empty (postgres://:pass@host, redis://:pass@host).
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)[^@\s/]+@/gi,
        "$1[REDACTED]@",
      )
      // Webhook URLs (https://discord.com/api/webhooks/<id>/<token>): the
      // trailing token is a bearer credential for posting as the bot. A
      // failure reason echoing DISCORD_WEBHOOK_URL=... matches neither the
      // key=value rule (unknown key name) nor the URL-credential rule, so
      // without this the token would be posted into the Discord channel.
      // Two path segments required: a bare /webhooks/<id> carries no secret.
      .replace(/\/webhooks\/[^\s"'/]+\/[^\s"']+/gi, "/webhooks/[redacted]")
      // Percent-encoded form (some client errors surface the URL encoded
      // rather than raw).
      .replace(/%2Fwebhooks%2F[^\s"']+/gi, "[redacted]")
  );
}
