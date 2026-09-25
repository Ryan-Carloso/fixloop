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
      // tokens, GitLab and npm tokens, JWTs. No trailing word boundary:
      // base64url JWT segments can end with "-" or "_" (non-word chars),
      // and a trailing \b would fail there and skip the whole rule,
      // leaking the token. The character classes already exclude
      // whitespace and quotes, so no boundary is needed.
      .replace(
        /\b(sk-[a-zA-Z0-9_-]{10,}|ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|gh[sur]_[a-zA-Z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,}|xox[bap]-[a-zA-Z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
        "[REDACTED]",
      )
      // Generic key=value with secret-like keys. The keyword may sit
      // inside a compound name (client_secret, access_token, api_key_id:
      // no word boundary before the keyword there), so match the full key
      // around it. A quoted value is consumed whole — including inner
      // spaces — so password="hunter2 admin" redacts fully instead of
      // leaking `admin`. The original quoting is preserved so JSON-like
      // text keeps its structure ({"password":"hunter2"} ->
      // {"password":"[REDACTED]"} instead of {"password=[REDACTED]}).
      // The unquoted branch still accepts stray quotes so an unterminated
      // password="abc never slips through (the quoted branches are tried
      // first, so balanced quotes always win).
      .replace(
        /\b([\w.-]*(?:api[_-]?key|token|secret|password|passwd|pwd)[\w.-]*)\s*(['"]?)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;\}]+)/gi,
        (_match, key: string, quote: string, sep: string, value: string) => {
          const q = value.startsWith('"')
            ? '"'
            : value.startsWith("'")
              ? "'"
              : quote;
          return `${key}${quote}${sep}${q}[REDACTED]${q}`;
        },
      )
      // Bearer tokens: the character class includes "." and "-" (both
      // non-word characters), so a trailing \b would fail to match when
      // the token ends with one of them and the whole rule would be
      // skipped, leaking the token. No trailing boundary is needed: the
      // class already excludes whitespace and quotes.
      .replace(/\bBearer\s+[a-zA-Z0-9._-]{10,}/g, "Bearer [REDACTED]")
      // Credentials embedded in URLs (postgres://user:pass@host/db).
      // The username may be empty (postgres://:pass@host, redis://:pass@host).
      // The whole userinfo is redacted, not just the password: usernames
      // can themselves be sensitive (access-key IDs passed as the user,
      // database owners, personal identifiers).
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/)[^/:\s@]*:[^@\s/]+@/gi,
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
