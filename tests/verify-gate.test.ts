import { describe, expect, it, vi, beforeEach } from "vitest";
import { VerificationGate } from "../src/verify/gate.js";
import type { DockerRunner, CommandResult } from "../src/docker/runner.js";

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
    start: vi.fn(async () => "verify-container"),
    exec: vi.fn(async () => result()),
    remove: vi.fn(async () => undefined),
  } as unknown as DockerRunner & {
    start: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VerificationGate", () => {
  it("passes when the fix makes tests go GREEN in a fresh container", async () => {
    const runner = mockRunner();
    // Clone, write diff, apply diff, run tests (GREEN).
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 })) // git clone
      .mockResolvedValueOnce(result({ exitCode: 0 })) // write diff
      .mockResolvedValueOnce(result({ exitCode: 0 })) // git apply
      .mockResolvedValueOnce(result({ exitCode: 0, stdout: "PASS" })); // tests
    const gate = new VerificationGate(runner, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const verdict = await gate.verify("diff --git a/src/math.js...");
    expect(verdict.passed).toBe(true);
    expect(verdict.testsPassed).toBe(true);
    expect(runner.remove).toHaveBeenCalledWith("verify-container");
  });

  it("fails when tests are still RED after applying the fix (adversarial)", async () => {
    const runner = mockRunner();
    // OpenCode claimed FIXED, but independent verification shows RED.
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 })) // git clone
      .mockResolvedValueOnce(result({ exitCode: 0 })) // write diff
      .mockResolvedValueOnce(result({ exitCode: 0 })) // git apply
      .mockResolvedValueOnce(result({ exitCode: 1, stdout: "FAIL" })); // tests RED
    const gate = new VerificationGate(runner, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const verdict = await gate.verify("bogus diff");
    expect(verdict.passed).toBe(false);
    expect(verdict.testsPassed).toBe(false);
    expect(verdict.reason).toContain("tests failed");
  });

  it("fails when the diff cannot be applied", async () => {
    const runner = mockRunner();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 })) // git clone
      .mockResolvedValueOnce(result({ exitCode: 0 })) // write diff
      .mockResolvedValueOnce(result({ exitCode: 128, stderr: "patch failed" })); // git apply fails
    const gate = new VerificationGate(runner, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const verdict = await gate.verify("invalid diff");
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("applied");
  });

  it("uses a fresh container, not the repair container", async () => {
    const runner = mockRunner();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const gate = new VerificationGate(runner, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    await gate.verify("diff...");
    // A new container was started (not reusing the repair one).
    expect(runner.start).toHaveBeenCalled();
    const startCall = runner.start.mock.calls[0];
    // Fresh container runs detached sleep, same as repair.
    expect(startCall[1]).toEqual(["sleep", "3600"]);
  });

  it("fails when clone fails", async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValueOnce(
      result({ exitCode: 128, stderr: "not found" }),
    );
    const gate = new VerificationGate(runner, {
      repoUrl: "/bad/repo",
      testCommand: ["npm", "test"],
    });
    const verdict = await gate.verify("diff...");
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("Clone failed");
  });

  it("fails when the diff cannot be written", async () => {
    const runner = mockRunner();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: "disk full" }));
    const gate = new VerificationGate(runner, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const verdict = await gate.verify("diff...");
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("write diff");
  });

  it("base64-encodes the diff to prevent shell injection", async () => {
    const runner = mockRunner();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const gate = new VerificationGate(runner, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    // A diff containing shell metacharacters and the old heredoc terminator.
    const maliciousDiff = "diff...\nFIXLOOP_EOF\n$(rm -rf /)\n`evil`";
    await gate.verify(maliciousDiff);
    const writeCall = runner.exec.mock.calls[1];
    const shellCmd = writeCall[1][2] as string;
    // The raw diff must NOT appear in the shell command.
    expect(shellCmd).not.toContain("FIXLOOP_EOF");
    expect(shellCmd).not.toContain("$(rm");
    // It should be base64-encoded.
    expect(shellCmd).toContain("base64 -d");
  });
});
