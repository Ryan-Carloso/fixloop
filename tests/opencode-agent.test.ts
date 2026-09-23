import { describe, expect, it, vi, beforeEach } from "vitest";
import { OpenCodeAgent } from "../src/agent/opencode.js";
import type { DockerRunner, CommandResult } from "../src/docker/runner.js";
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
    exec: vi.fn(async () => result()),
  } as unknown as DockerRunner & {
    exec: ReturnType<typeof vi.fn>;
  };
}

const errorContext: ErrorContext = {
  provider: "bugsink",
  issueId: "123",
  exception: {
    type: "AssertionError",
    message: "Expected 5, got -1",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OpenCodeAgent", () => {
  it("runs opencode diagnose and parses the root cause", async () => {
    const runner = mockRunner();
    const diagnosisJson = JSON.stringify({
      rootCause: "add() uses subtraction instead of addition",
      filesToFix: ["src/math.js"],
    });
    runner.exec
      .mockResolvedValueOnce(result({ stdout: "", exitCode: 0 })) // opencode run
      .mockResolvedValueOnce(result({ stdout: diagnosisJson, exitCode: 0 })); // cat
    const agent = new OpenCodeAgent(runner);
    const diagnosis = await agent.diagnose("container-123", errorContext);
    expect(diagnosis.rootCause).toContain("subtraction");
    expect(diagnosis.filesToFix).toContain("src/math.js");
    // Verify opencode was invoked with the error context.
    const execCall = runner.exec.mock.calls[0];
    expect(execCall[0]).toBe("container-123");
    expect(execCall[1]).toContain("opencode");
    expect(execCall[1]).toContain("run");
    // Verify the diagnosis file was read.
    expect(runner.exec.mock.calls[1][1]).toEqual(["cat", "/tmp/diagnosis.json"]);
  });

  it("applies a fix via opencode and reports success", async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValueOnce(
      result({ stdout: "Fixed src/math.js", exitCode: 0 }),
    );
    const agent = new OpenCodeAgent(runner);
    const applied = await agent.applyFix("container-123", {
      rootCause: "uses subtraction",
      filesToFix: ["src/math.js"],
    });
    expect(applied).toBe(true);
    const execCall = runner.exec.mock.calls[0];
    expect(execCall[1]).toContain("opencode");
  });

  it("returns false when opencode fails to apply the fix", async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValueOnce(
      result({ exitCode: 1, stderr: "model error" }),
    );
    const agent = new OpenCodeAgent(runner);
    const applied = await agent.applyFix("container-123", {
      rootCause: "x",
      filesToFix: [],
    });
    expect(applied).toBe(false);
  });

  it("returns false when applyFix times out", async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValueOnce(
      result({ exitCode: null, timedOut: true }),
    );
    const agent = new OpenCodeAgent(runner);
    const applied = await agent.applyFix("container-123", {
      rootCause: "x",
      filesToFix: [],
    });
    expect(applied).toBe(false);
  });

  it("throws when diagnose exits non-zero", async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValueOnce(
      result({ exitCode: 1, stderr: "connection failed" }),
    );
    const agent = new OpenCodeAgent(runner);
    await expect(agent.diagnose("container-123", errorContext)).rejects.toThrow(
      /opencode diagnose failed/,
    );
  });

  it("throws when opencode does not write the diagnosis file", async () => {
    const runner = mockRunner();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: "no such file" }));
    const agent = new OpenCodeAgent(runner);
    await expect(agent.diagnose("container-123", errorContext)).rejects.toThrow(
      /did not write/,
    );
  });

  it("throws when the diagnosis file contains invalid JSON", async () => {
    const runner = mockRunner();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ stdout: "not json", exitCode: 0 }));
    const agent = new OpenCodeAgent(runner);
    await expect(agent.diagnose("container-123", errorContext)).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it("uses defaults when diagnosis JSON is missing fields", async () => {
    const runner = mockRunner();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ stdout: "{}", exitCode: 0 }));
    const agent = new OpenCodeAgent(runner);
    const diagnosis = await agent.diagnose("container-123", errorContext);
    expect(diagnosis.rootCause).toBe("unknown");
    expect(diagnosis.filesToFix).toEqual([]);
  });
});
