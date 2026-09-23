import { describe, expect, it, vi, beforeEach } from "vitest";
import { DockerRunner } from "../src/docker/runner.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: vi.fn(() => "/tmp/fixloop-test"),
    readFileSync: vi.fn(() => "fake-container-id"),
    rmSync: vi.fn(),
  };
});

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const mockSpawn = vi.mocked(spawn);
const mockReadFileSync = vi.mocked(readFileSync);

function mockProcess(opts: {
  stdout?: string;
  exitCode?: number | null;
}) {
  const handlers: Record<string, ((...args: never[]) => void)[]> = {};
  const proc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((ev: string, cb: (...a: never[]) => void) => {
      (handlers[ev] ??= []).push(cb);
    }),
    kill: vi.fn(() => true),
  };
  queueMicrotask(() => {
    if (opts.stdout) {
      // Invoke the data handlers registered via stdout.on.
      (proc.stdout.on as unknown as { mock: { calls: unknown[][] } }).mock.calls.forEach(
        ([ev, cb]) => {
          if (ev === "data") (cb as (d: Buffer) => void)(Buffer.from(opts.stdout!));
        },
      );
    }
    (handlers["close"] ?? []).forEach((cb) => cb(opts.exitCode ?? 0, null));
  });
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DockerRunner.start", () => {
  it("starts a detached container and returns its id", async () => {
    mockSpawn.mockReturnValueOnce(
      mockProcess({ stdout: "abc123def456\n", exitCode: 0 }) as never,
    );
    const runner = new DockerRunner();
    const id = await runner.start("node:22", ["sleep", "3600"], {});
    expect(id).toBe("abc123def456");
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[0]).toBe("run");
    expect(args).toContain("-d");
    // Detached containers are NOT --rm; the runner removes them explicitly.
    expect(args).not.toContain("--rm");
  });

  it("supports bind mounts for the workspace", async () => {
    mockSpawn.mockReturnValueOnce(
      mockProcess({ stdout: "abc123\n", exitCode: 0 }) as never,
    );
    const runner = new DockerRunner();
    await runner.start("node:22", ["sleep", "3600"], {
      volumes: ["/host/fixture:/workspace"],
    });
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("-v");
    expect(args).toContain("/host/fixture:/workspace");
  });

  it("throws when docker fails to start the container", async () => {
    mockSpawn.mockReturnValueOnce(
      mockProcess({ stdout: "", stderr: "no such image", exitCode: 125 }) as never,
    );
    const runner = new DockerRunner();
    // Simulate the cidfile not existing (container never started).
    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    await expect(runner.start("bad:image", ["true"], {})).rejects.toThrow(
      /Failed to start container/,
    );
  });

  it("throws when docker returns no container ID", async () => {
    mockSpawn.mockReturnValueOnce(
      mockProcess({ stdout: "\n", exitCode: 0 }) as never,
    );
    const runner = new DockerRunner();
    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    await expect(runner.start("node:22", ["true"], {})).rejects.toThrow(
      /did not return a container ID/,
    );
  });
});
