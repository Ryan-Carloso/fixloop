import { describe, expect, it, vi, beforeEach } from "vitest";
import { DockerRunner, type RunOptions } from "../src/docker/runner.js";

// We mock node:child_process to avoid needing a real Docker daemon.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock node:fs so the --cidfile flow is deterministic in tests.
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

const mockSpawn = vi.mocked(spawn);

function mockProcess(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  spawnError?: Error;
  neverExits?: boolean;
}) {
  const handlers: Record<string, ((...args: never[]) => void)[]> = {};
  const proc = {
    stdout: {
      on: vi.fn((ev: string, cb: (...a: never[]) => void) => {
        (handlers[`stdout:${ev}`] ??= []).push(cb);
      }),
    },
    stderr: {
      on: vi.fn((ev: string, cb: (...a: never[]) => void) => {
        (handlers[`stderr:${ev}`] ??= []).push(cb);
      }),
    },
    on: vi.fn((ev: string, cb: (...a: never[]) => void) => {
      (handlers[ev] ??= []).push(cb);
    }),
    kill: vi.fn((_sig?: NodeJS.Signals) => {
      // Simulate the OS delivering the kill: the process exits with the signal.
      queueMicrotask(() => {
        (handlers["close"] ?? []).forEach((cb) => cb(null, "SIGKILL"));
      });
      return true;
    }),
  };
  // Simulate async behavior on next tick.
  queueMicrotask(() => {
    if (opts.spawnError) {
      (handlers["error"] ?? []).forEach((cb) => cb(opts.spawnError));
      return;
    }
    if (opts.stdout) {
      (handlers["stdout:data"] ?? []).forEach((cb) => cb(Buffer.from(opts.stdout)));
    }
    if (opts.stderr) {
      (handlers["stderr:data"] ?? []).forEach((cb) => cb(Buffer.from(opts.stderr)));
    }
    if (!opts.neverExits) {
      (handlers["close"] ?? []).forEach((cb) =>
        cb(opts.exitCode ?? 0, opts.signal ?? null),
      );
    }
  });
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DockerRunner", () => {
  it("runs an ephemeral container and captures output", async () => {
    mockSpawn.mockReturnValueOnce(
      mockProcess({ stdout: "hello\n", exitCode: 0 }) as never,
    );
    const runner = new DockerRunner();
    const result = await runner.run("busybox:latest", ["echo", "hello"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.timedOut).toBe(false);
    // Must use --rm for ephemeral containers.
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(mockSpawn.mock.calls[0][0]).toBe("docker");
    expect(args).toContain("--rm");
    expect(args).toContain("busybox:latest");
  });

  it("applies resource limits and network isolation by default", async () => {
    mockSpawn.mockReturnValueOnce(mockProcess({ exitCode: 0 }) as never);
    const runner = new DockerRunner();
    await runner.run("busybox:latest", ["true"], {});
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--cpus=1");
    expect(args).toContain("--memory=512m");
    expect(args).toContain("--pids-limit=100");
    expect(args).toContain("--network=none");
  });

  it("kills the container and reports timeout when the time limit is hit", async () => {
    const proc = mockProcess({ neverExits: true });
    mockSpawn.mockReturnValueOnce(proc as never);
    // The rm -f for the timed-out container.
    mockSpawn.mockReturnValueOnce(mockProcess({ exitCode: 0 }) as never);
    const runner = new DockerRunner();
    const result = await runner.run("busybox:latest", ["sleep", "60"], {
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    // The container itself must be destroyed, not just the CLI killed.
    const rmCall = mockSpawn.mock.calls.find(
      (c) => (c[1] as string[])[0] === "rm",
    );
    expect(rmCall).toBeDefined();
    expect(rmCall![1]).toContain("fake-container-id");
    expect(rmCall![1]).toContain("-f");
  });

  it("reports non-zero exit codes with stderr", async () => {
    mockSpawn.mockReturnValueOnce(
      mockProcess({ stderr: "boom\n", exitCode: 3 }) as never,
    );
    const runner = new DockerRunner();
    const result = await runner.run("busybox:latest", ["false"], {});
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("boom\n");
    expect(result.timedOut).toBe(false);
  });

  it("throws a clear error when the docker CLI is missing", async () => {
    const err = new Error("spawn docker ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockSpawn.mockReturnValueOnce(mockProcess({ spawnError: err }) as never);
    const runner = new DockerRunner();
    await expect(runner.run("busybox:latest", ["true"], {})).rejects.toThrow(
      /docker/i,
    );
  });

  it("exec runs a command in a running container", async () => {
    mockSpawn.mockReturnValueOnce(
      mockProcess({ stdout: "ok\n", exitCode: 0 }) as never,
    );
    const runner = new DockerRunner();
    const result = await runner.exec("abc123", ["ls", "/"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[0]).toBe("exec");
    expect(args).toContain("abc123");
  });

  it("remove destroys a container even if it already exited", async () => {
    // docker rm -f returns non-zero if the container is gone; runner must not throw.
    mockSpawn.mockReturnValueOnce(mockProcess({ exitCode: 1 }) as never);
    const runner = new DockerRunner();
    await expect(runner.remove("deadbeef")).resolves.toBeUndefined();
  });
});

describe("DockerRunner option defaults", () => {
  it("allows overriding network and resources", async () => {
    mockSpawn.mockReturnValueOnce(mockProcess({ exitCode: 0 }) as never);
    const runner = new DockerRunner();
    const opts: RunOptions = {
      cpus: 2,
      memory: "1g",
      pidsLimit: 200,
      network: "bridge",
    };
    await runner.run("busybox:latest", ["true"], opts);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--cpus=2");
    expect(args).toContain("--memory=1g");
    expect(args).toContain("--pids-limit=200");
    expect(args).toContain("--network=bridge");
  });

  it("passes env vars and workdir to run and exec", async () => {
    mockSpawn.mockReturnValueOnce(mockProcess({ exitCode: 0 }) as never);
    const runner = new DockerRunner();
    await runner.run("busybox:latest", ["true"], {
      env: { FOO: "bar" },
      workdir: "/app",
    });
    let args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--env");
    expect(args).toContain("FOO=bar");
    expect(args).toContain("--workdir");
    expect(args).toContain("/app");

    mockSpawn.mockClear();
    mockSpawn.mockReturnValueOnce(mockProcess({ exitCode: 0 }) as never);
    await runner.exec("abc123", ["true"], {
      env: { BAZ: "qux" },
      workdir: "/src",
    });
    args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("BAZ=qux");
    expect(args).toContain("/src");
  });

  it("uses --cidfile so a timed-out container has a known identity", async () => {
    mockSpawn.mockReturnValueOnce(mockProcess({ exitCode: 0 }) as never);
    const runner = new DockerRunner();
    await runner.run("busybox:latest", ["true"], {});
    const args = mockSpawn.mock.calls[0][1] as string[];
    const cidfile = args.find((a) => a.startsWith("--cidfile="));
    expect(cidfile).toBeDefined();
  });
});
