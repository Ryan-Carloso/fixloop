import { describe, expect, it, vi, beforeEach } from "vitest";
import { RepairWorkflow } from "../src/workflow/repair.js";
import type { DockerRunner, CommandResult } from "../src/docker/runner.js";
import type { CodingAgent, Diagnosis } from "../src/agent/opencode.js";
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
    start: vi.fn(async () => "container-123"),
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

const errorContext: ErrorContext = {
  provider: "bugsink",
  issueId: "123",
  exception: { type: "AssertionError", message: "Expected 5, got -1" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RepairWorkflow", () => {
  it("proves RED, applies fix, and proves GREEN", async () => {
    const runner = mockRunner();
    const agent = mockAgent();
    // Sequence: clone, test(RED), test(GREEN), git diff, diff --name-status, cat file.
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 })) // git clone
      .mockResolvedValueOnce(result({ exitCode: 1, stdout: "FAIL" })) // test RED
      .mockResolvedValueOnce(result({ exitCode: 0 })) // test GREEN
      .mockResolvedValueOnce(result({ stdout: "diff...", exitCode: 0 })) // git diff
      .mockResolvedValueOnce(result({ stdout: "M\tsrc/math.js\n", exitCode: 0 })) // --name-status
      .mockResolvedValueOnce(
        result({ stdout: "export function add(a,b){return a+b;}", exitCode: 0 }),
      ); // cat file
    const workflow = new RepairWorkflow(runner, agent, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const outcome = await workflow.repair(errorContext);
    expect(outcome.redProven).toBe(true);
    expect(outcome.greenProven).toBe(true);
    expect(outcome.fixApplied).toBe(true);
    expect(outcome.changedFiles).toHaveLength(1);
    expect(outcome.changedFiles![0].path).toBe("src/math.js");
    expect(agent.diagnose).toHaveBeenCalled();
    expect(agent.applyFix).toHaveBeenCalled();
    expect(runner.remove).toHaveBeenCalledWith("container-123");
  });

  it("does not attempt a fix when RED cannot be proven", async () => {
    const runner = mockRunner();
    const agent = mockAgent();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 })) // git clone
      .mockResolvedValueOnce(result({ exitCode: 0, stdout: "PASS" })); // test GREEN (no bug)
    const workflow = new RepairWorkflow(runner, agent, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const outcome = await workflow.repair(errorContext);
    expect(outcome.redProven).toBe(false);
    expect(outcome.fixApplied).toBe(false);
    expect(agent.diagnose).not.toHaveBeenCalled();
  });

  it("reports failure when GREEN cannot be proven after fix", async () => {
    const runner = mockRunner();
    const agent = mockAgent();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 })) // clone
      .mockResolvedValueOnce(result({ exitCode: 1 })) // RED
      .mockResolvedValueOnce(result({ exitCode: 1, stdout: "still FAIL" })); // still RED
    const workflow = new RepairWorkflow(runner, agent, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const outcome = await workflow.repair(errorContext);
    expect(outcome.redProven).toBe(true);
    expect(outcome.greenProven).toBe(false);
    expect(outcome.fixApplied).toBe(true);
  });

  it("cleans up even when diagnosis throws", async () => {
    const runner = mockRunner();
    const agent = mockAgent();
    agent.diagnose.mockRejectedValueOnce(new Error("llm down"));
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 1 }));
    const workflow = new RepairWorkflow(runner, agent, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    await expect(workflow.repair(errorContext)).rejects.toThrow(/llm down/);
    expect(runner.remove).toHaveBeenCalledWith("container-123");
  });

  it("throws when clone fails", async () => {
    const runner = mockRunner();
    const agent = mockAgent();
    runner.exec.mockResolvedValueOnce(
      result({ exitCode: 128, stderr: "not found" }),
    );
    const workflow = new RepairWorkflow(runner, agent, {
      repoUrl: "/bad/repo",
      testCommand: ["npm", "test"],
    });
    await expect(workflow.repair(errorContext)).rejects.toThrow(/Clone failed/);
    expect(runner.remove).toHaveBeenCalledWith("container-123");
  });

  it("returns early when the agent cannot apply a fix", async () => {
    const runner = mockRunner();
    const agent = mockAgent();
    agent.applyFix.mockResolvedValueOnce(false);
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 1 }));
    const workflow = new RepairWorkflow(runner, agent, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const outcome = await workflow.repair(errorContext);
    expect(outcome.redProven).toBe(true);
    expect(outcome.fixApplied).toBe(false);
    expect(outcome.greenProven).toBe(false);
  });
});
