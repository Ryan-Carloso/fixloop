import { describe, expect, it, vi, beforeEach } from "vitest";
import { RepairWorkspace } from "../src/workspace/workspace.js";
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
    start: vi.fn(async () => "container-123"),
    exec: vi.fn(async () => result()),
    remove: vi.fn(async () => undefined),
    run: vi.fn(async () => result()),
  } as unknown as DockerRunner & {
    start: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RepairWorkspace", () => {
  it("clones the repo, runs tests, and reports RED on failure", async () => {
    const runner = mockRunner();
    // Clone succeeds, tests fail (RED).
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 })) // git clone
      .mockResolvedValueOnce(
        result({ exitCode: 1, stdout: "failing tests", stderr: "" }), // npm test
      );
    const ws = new RepairWorkspace(runner, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const outcome = await ws.cloneAndTest();
    expect(outcome.testsPassed).toBe(false);
    expect(outcome.cloneOk).toBe(true);
    // Verify the clone command.
    const cloneCall = runner.exec.mock.calls[0];
    expect(cloneCall[0]).toBe("container-123");
    expect(cloneCall[1]).toContain("git");
    expect(cloneCall[1]).toContain("clone");
    // Container is always cleaned up.
    expect(runner.remove).toHaveBeenCalledWith("container-123");
  });

  it("reports GREEN when tests pass", async () => {
    const runner = mockRunner();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0, stdout: "passing" }));
    const ws = new RepairWorkspace(runner, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const outcome = await ws.cloneAndTest();
    expect(outcome.testsPassed).toBe(true);
    expect(runner.remove).toHaveBeenCalledWith("container-123");
  });

  it("cleans up the container even if clone fails", async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValueOnce(
      result({ exitCode: 128, stderr: "repository not found" }),
    );
    const ws = new RepairWorkspace(runner, {
      repoUrl: "/bad/repo",
      testCommand: ["npm", "test"],
    });
    const outcome = await ws.cloneAndTest();
    expect(outcome.cloneOk).toBe(false);
    expect(runner.remove).toHaveBeenCalledWith("container-123");
  });

  it("passes volumes and network through to the container", async () => {
    const runner = mockRunner();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: 0 }));
    const ws = new RepairWorkspace(runner, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
      volumes: ["/host/fixtures:/fixtures"],
      network: "bridge",
    });
    await ws.cloneAndTest();
    expect(runner.start).toHaveBeenCalledWith(
      "node:22",
      ["sleep", "3600"],
      expect.objectContaining({
        volumes: ["/host/fixtures:/fixtures"],
        network: "bridge",
      }),
    );
  });

  it("reports tests as failed when the test run times out", async () => {
    const runner = mockRunner();
    runner.exec
      .mockResolvedValueOnce(result({ exitCode: 0 }))
      .mockResolvedValueOnce(result({ exitCode: null, timedOut: true }));
    const ws = new RepairWorkspace(runner, {
      repoUrl: "/fixtures/buggy-app",
      testCommand: ["npm", "test"],
    });
    const outcome = await ws.cloneAndTest();
    expect(outcome.cloneOk).toBe(true);
    expect(outcome.testsPassed).toBe(false);
    expect(runner.remove).toHaveBeenCalledWith("container-123");
  });
});
