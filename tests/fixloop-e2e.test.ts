import { describe, expect, it, vi, beforeEach } from "vitest";
import { FixLoop } from "../src/fixloop.js";
import { sanitizeForPr } from "../src/redact.js";
import type { DockerRunner, CommandResult } from "../src/docker/runner.js";
import type { CodingAgent } from "../src/agent/opencode.js";
import type { ErrorContext } from "../src/providers/error-provider.js";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

function mockRunner() {
  return {
    start: vi.fn(async () => "container-1"),
    exec: vi.fn(async () => result()),
    remove: vi.fn(async () => undefined),
  } as unknown as DockerRunner & {
    start: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

function mockAgent() {
  return {
    diagnose: vi.fn(async () => ({
      rootCause: "uses subtraction",
      filesToFix: ["src/math.js"],
    })),
    applyFix: vi.fn(async () => true),
  } as CodingAgent & {
    diagnose: ReturnType<typeof vi.fn>;
    applyFix: ReturnType<typeof vi.fn>;
  };
}

function mockGitHub() {
  return {
    createFixPr: vi.fn(async () => ({
      number: 42,
      url: "https://github.com/o/r/pull/42",
    })),
  };
}

const errorContext: ErrorContext = {
  provider: "bugsink",
  issueId: "123",
  exception: { type: "AssertionError", message: "Expected 5, got -1" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sanitizeForPr", () => {
  it("redacts API keys", () => {
    const input = "Failed with key sk-abc123def456ghi789";
    expect(sanitizeForPr(input)).not.toContain("sk-abc123");
    expect(sanitizeForPr(input)).toContain("[REDACTED]");
  });

  it("redacts GitHub tokens", () => {
    const input = "Token ghp_abc123def456ghi789jkl expired";
    expect(sanitizeForPr(input)).not.toContain("ghp_abc123");
  });

  it("redacts Bearer tokens", () => {
    const input = "Auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    expect(sanitizeForPr(input)).not.toContain("eyJhbGci");
    expect(sanitizeForPr(input)).toContain("Bearer [REDACTED]");
  });

  it("redacts JWTs whose signature ends with a non-word character", () => {
    // Regression: the trailing \b after the secret-prefix alternation
    // failed when a base64url JWT segment ended with "-" or "_" (both
    // non-word chars), so the whole rule was skipped and the raw JWT
    // leaked.
    const header = "eyJ" + "hbGciOiJIUzI1NiJ9";
    const payload = "eyJzdWIiOiIxMjM0NTY3ODkw";
    const sig = "abcdefghi" + "-"; // 9 word chars + trailing dash
    const input = `saw jwt ${header}.${payload}.${sig} in logs`;
    const out = sanitizeForPr(input);
    expect(out).not.toContain(header);
    expect(out).not.toContain(sig);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts quoted multi-word secret values in full", () => {
    // The old value pattern stopped at whitespace even inside quotes, so
    // password="hunter2 admin" leaked `admin`.
    const secret = "hunter2" + " admin";
    const input = `login failed: password="${secret}" for user bob`;
    const out = sanitizeForPr(input);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("admin");
    expect(out).toContain('password="[REDACTED]"');
  });

  it("redacts unterminated quoted values", () => {
    // A missing closing quote must not let the value slip through.
    const input = 'truncated dump: password="hunter2';
    const out = sanitizeForPr(input);
    expect(out).not.toContain("hunter2");
  });
  it("redacts Bearer tokens ending in a non-word character", () => {
    // Regression: the trailing \b after [a-zA-Z0-9._-]{10,} failed when
    // the token ended with "." or "-" (non-word chars), so the whole rule
    // was skipped and the raw token leaked.
    const token = "abcdefghi" + "."; // 9 word chars + a trailing dot
    const input = `Auth failed: Bearer ${token}`;
    expect(sanitizeForPr(input)).not.toContain("abcdefghi");
    expect(sanitizeForPr(input)).toContain("Bearer [REDACTED]");
  });

  it("redacts password in key=value", () => {
    const input = "Login failed: password=supersecret123";
    expect(sanitizeForPr(input)).not.toContain("supersecret123");
  });

  it("redacts credentials embedded in URLs", () => {
    const input =
      "connect ECONNREFUSED postgres://admin:hunter2@db:5432/fixloop";
    const redacted = sanitizeForPr(input);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("postgres://[REDACTED]@db:5432/fixloop");
  });

  it("redacts credentials with an empty username", () => {
    const input = "dial error redis://:hunter2@cache:6379/0";
    const redacted = sanitizeForPr(input);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("redis://[REDACTED]@cache:6379/0");
  });

  it("redacts access-key-style usernames in URLs", () => {
    // Usernames can themselves be sensitive: access-key IDs passed as the
    // user, database owners, personal identifiers.
    const user = "AKIA" + "IOSFODNN7EXAMPLE";
    const input = `auth failed for https://${user}:wJalrXUtnFEMI@api.example.com`;
    const redacted = sanitizeForPr(input);
    expect(redacted).not.toContain(user);
    expect(redacted).toContain("https://[REDACTED]@api.example.com");
  });

  it("redacts JSON-quoted secrets", () => {
    const input =
      'request failed with body {"password":"hunter2","api_key": "sk-live-abc123"}';
    const redacted = sanitizeForPr(input);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("sk-live-abc123");
  });

  it("redacts compound secret keys", () => {
    // client_secret= / access_token= / api_key_id= never matched the old
    // bare-keyword pattern (no word boundary inside the compound name).
    const input =
      'auth failed: {"client_secret": "abc123", "access_token": "tok456"} api_key_id=key789';
    const redacted = sanitizeForPr(input);
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("tok456");
    expect(redacted).not.toContain("key789");
  });

  it("preserves JSON structure when redacting key=value secrets", () => {
    // The old replacement destroyed the quotes and separator
    // ({"password":"hunter2"} -> {"password=[REDACTED]}); keep the text
    // valid-looking so log context stays readable.
    expect(sanitizeForPr('{"password":"hunter2","user":"bob"}')).toBe(
      '{"password":"[REDACTED]","user":"bob"}',
    );
  });

  it("redacts webhook URLs — the token posts as the bot", () => {
    const input =
      "env dump: DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123/supersecrettoken";
    const redacted = sanitizeForPr(input);
    expect(redacted).not.toContain("supersecrettoken");
    expect(redacted).toContain("/webhooks/[redacted]");
  });

  it("redacts modern token formats and JWTs", () => {
    const input = [
      "github_pat_abcdefghij1234567890ABCDEFGH",
      "glpat-x1234567890abcdefghi",
      "npm_abc123def456ghi789jkl012mno345pqr",
      "ghs_abc123def456ghi789jkl012mno345pqr",
      "ghu_abc123def456ghi789jkl012mno345pqr",
      "ghr_abc123def456ghi789jkl012mno345pqr",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(" ");
    const redacted = sanitizeForPr(input);
    expect(redacted).not.toContain("github_pat_");
    expect(redacted).not.toContain("glpat-");
    expect(redacted).not.toContain("npm_abc123");
    expect(redacted).not.toContain("ghs_abc123");
    expect(redacted).not.toContain("ghu_abc123");
    expect(redacted).not.toContain("ghr_abc123");
    expect(redacted).not.toContain("eyJhbGci");
  });

  it("leaves credential-less URLs intact", () => {
    // A bare /webhooks/<id> (single segment) carries no token.
    const input = "GET https://discord.com/api/webhooks/12345 returned 200";
    expect(sanitizeForPr(input)).toBe(input);
  });

  it("leaves normal messages intact", () => {
    const input = "Expected 5, got -1";
    expect(sanitizeForPr(input)).toBe(input);
  });
});

describe("FixLoop end-to-end", () => {
  it("goes from error to PR when RED→GREEN is verified", async () => {
    const runner = mockRunner();
    const agent = mockAgent();
    const github = mockGitHub();
    // Repair: clone, RED, GREEN, diff, name-only, cat.
    // Verify: clone, write diff, apply, GREEN.
    // Note: agent.diagnose/applyFix are mocked, so no runner.exec for them.
    runner.exec
      .mockResolvedValueOnce(result()) // repair: clone
      .mockResolvedValueOnce(result({ exitCode: 1 })) // repair: RED
      .mockResolvedValueOnce(result({ exitCode: 0 })) // repair: GREEN
      .mockResolvedValueOnce(result({ stdout: "diff..." })) // repair: git diff
      .mockResolvedValueOnce(result({ stdout: "M\tsrc/math.js\n" })) // --name-status
      .mockResolvedValueOnce(result({ stdout: "fixed content" })) // cat file
      .mockResolvedValueOnce(result()) // verify: clone
      .mockResolvedValueOnce(result()) // verify: write diff
      .mockResolvedValueOnce(result()) // verify: apply diff
      .mockResolvedValueOnce(result({ exitCode: 0 })); // verify: GREEN

    const fixloop = new FixLoop(runner, agent, github as never, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
      owner: "owner",
      repo: "repo",
    });
    const outcome = await fixloop.handleError(errorContext);

    expect(outcome.prCreated).toBe(true);
    expect(outcome.prUrl).toContain("pull/42");
    expect(github.createFixPr).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFiles: [{ path: "src/math.js", content: "fixed content" }],
      }),
    );
  });

  it("does NOT create a PR when verification fails (adversarial)", async () => {
    const runner = mockRunner();
    const agent = mockAgent();
    const github = mockGitHub();
    // Repair succeeds (RED→GREEN), but independent verification shows RED.
    // Note: agent.diagnose/applyFix are mocked, so no runner.exec for them.
    runner.exec
      .mockResolvedValueOnce(result()) // repair: clone
      .mockResolvedValueOnce(result({ exitCode: 1 })) // repair: RED
      .mockResolvedValueOnce(result({ exitCode: 0 })) // repair: GREEN
      .mockResolvedValueOnce(result({ stdout: "diff..." })) // repair: git diff
      .mockResolvedValueOnce(result({ stdout: "M\tsrc/math.js\n" })) // --name-status
      .mockResolvedValueOnce(result({ stdout: "fixed" })) // cat
      .mockResolvedValueOnce(result()) // verify: clone
      .mockResolvedValueOnce(result()) // verify: write diff
      .mockResolvedValueOnce(result()) // verify: apply diff
      .mockResolvedValueOnce(result({ exitCode: 1, stdout: "FAIL" })); // verify: RED!

    const fixloop = new FixLoop(runner, agent, github as never, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
      owner: "owner",
      repo: "repo",
    });
    const outcome = await fixloop.handleError(errorContext);

    expect(outcome.prCreated).toBe(false);
    expect(outcome.reason).toContain("verification");
    expect(github.createFixPr).not.toHaveBeenCalled();
  });

  it("does NOT create a PR when RED cannot be proven", async () => {
    const runner = mockRunner();
    const agent = mockAgent();
    const github = mockGitHub();
    runner.exec
      .mockResolvedValueOnce(result()) // clone
      .mockResolvedValueOnce(result({ exitCode: 0 })); // tests PASS (no bug)

    const fixloop = new FixLoop(runner, agent, github as never, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
      owner: "owner",
      repo: "repo",
    });
    const outcome = await fixloop.handleError(errorContext);

    expect(outcome.prCreated).toBe(false);
    expect(github.createFixPr).not.toHaveBeenCalled();
  });
});
