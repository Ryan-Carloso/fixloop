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

  it("redacts password in key=value", () => {
    const input = "Login failed: password=supersecret123";
    expect(sanitizeForPr(input)).not.toContain("supersecret123");
  });

  it("redacts credentials embedded in URLs", () => {
    const input =
      "connect ECONNREFUSED postgres://admin:hunter2@db:5432/fixloop";
    const redacted = sanitizeForPr(input);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("postgres://admin:[REDACTED]@db:5432/fixloop");
  });

  it("redacts credentials with an empty username", () => {
    const input = "dial error redis://:hunter2@cache:6379/0";
    const redacted = sanitizeForPr(input);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("redis://:[REDACTED]@cache:6379/0");
  });

  it("leaves credential-less URLs intact", () => {
    const input = "GET https://discord.com/api/webhooks/123/abc returned 200";
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
