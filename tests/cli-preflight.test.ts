import { describe, expect, it } from "vitest";
import {
  checkDocker,
  checkGit,
  detectSystem,
  type CommandRunner,
} from "../src/cli/preflight.js";

function fakeRunner(
  handlers: Record<string, { exitCode: number; stdout: string }>,
): CommandRunner {
  return {
    async run(cmd: string, args: string[]) {
      const key = `${cmd} ${args.join(" ")}`;
      const hit = handlers[key];
      if (!hit) throw Object.assign(new Error(`command not found: ${cmd}`), { code: "ENOENT" });
      if (hit.exitCode !== 0) {
        const err = new Error(`exit ${hit.exitCode}`) as Error & { exitCode: number; stdout: string };
        err.exitCode = hit.exitCode;
        err.stdout = hit.stdout;
        throw err;
      }
      return { exitCode: 0, stdout: hit.stdout, stderr: "" };
    },
  };
}

describe("detectSystem", () => {
  it("reports OS, arch, CPU count and memory from the host", async () => {
    const info = await detectSystem();
    expect(info.os.length).toBeGreaterThan(0);
    expect(info.arch.length).toBeGreaterThan(0);
    expect(info.cpus).toBeGreaterThan(0);
    expect(info.totalMemBytes).toBeGreaterThan(0);
    expect(info.nodeVersion).toMatch(/^v\d+/);
  });
});

describe("checkDocker", () => {
  it("passes when docker is installed and the daemon responds", async () => {
    const runner = fakeRunner({
      "docker --version": { exitCode: 0, stdout: "Docker version 28.2.2, build abc123\n" },
      "docker info": { exitCode: 0, stdout: "Server Version: 28.2.2\n" },
    });
    const check = await checkDocker(runner);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("28.2.2");
  });

  it("fails with an install hint when docker is not on PATH", async () => {
    const runner = fakeRunner({});
    const check = await checkDocker(runner);
    expect(check.ok).toBe(false);
    expect(check.hint).toMatch(/install docker/i);
  });

  it("fails with a start-daemon hint when the daemon is down", async () => {
    const runner = fakeRunner({
      "docker --version": { exitCode: 0, stdout: "Docker version 28.2.2, build abc123\n" },
      "docker info": { exitCode: 1, stdout: "Cannot connect to the Docker daemon" },
    });
    const check = await checkDocker(runner);
    expect(check.ok).toBe(false);
    expect(check.hint).toMatch(/daemon/i);
  });
});

describe("checkGit", () => {
  it("passes and reports the git version", async () => {
    const runner = fakeRunner({
      "git --version": { exitCode: 0, stdout: "git version 2.45.2\n" },
    });
    const check = await checkGit(runner);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("2.45.2");
  });

  it("fails with an install hint when git is missing", async () => {
    const check = await checkGit(fakeRunner({}));
    expect(check.ok).toBe(false);
    expect(check.hint).toMatch(/install git/i);
  });
});
