import { describe, expect, it } from "vitest";
import {
  adaptDockerRunner,
  validateRunner,
  type RunnerDocker,
} from "../src/cli/docker-check.js";
import { DockerRunner } from "../src/docker/runner.js";

interface Scripted {
  onRun?: (command: string[]) => { exitCode: number; stdout: string; stderr?: string };
}

function fakeDocker(script: Scripted & { uid?: string; cleanedUp?: boolean } = {}): RunnerDocker {
  return {
    async run(_image, command, _opts) {
      if (script.onRun) return { timedOut: false, ...script.onRun(command) };
      const [cmd, ...args] = command;
      if (cmd === "id") return { exitCode: 0, stdout: `${script.uid ?? "1000"}\n`, stderr: "", timedOut: false };
      if (cmd === "git") return { exitCode: 0, stdout: "git version 2.45.0\n", stderr: "", timedOut: false };
      if (cmd === "opencode") return { exitCode: 0, stdout: "opencode 1.2.3\n", stderr: "", timedOut: false };
      if (cmd === "true") return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      if (cmd === "sh") return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      void args;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
    async start() {
      return "deadbeef1234";
    },
    async remove() {},
    async exists() {
      return !(script.cleanedUp ?? true);
    },
  };
}

describe("validateRunner", () => {
  it("passes all checks for a healthy runner image", async () => {
    const result = await validateRunner({ docker: fakeDocker(), image: "fixloop-runner:latest" });
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "Container starts",
      "Running as non-root",
      "Git available",
      "OpenCode available",
      "Workspace writable",
      "Network available",
      "Container cleaned up",
    ]);
  });

  it("fails non-root when the image runs as uid 0", async () => {
    const result = await validateRunner({ docker: fakeDocker({ uid: "0" }), image: "img" });
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "Running as non-root")!;
    expect(check.ok).toBe(false);
    expect(check.hint).toMatch(/non-root|USER/i);
  });

  it("fails when git is missing from the image", async () => {
    const docker = fakeDocker({
      onRun: (command) =>
        command[0] === "git"
          ? { exitCode: 127, stdout: "", stderr: "git: not found" }
          : { exitCode: 0, stdout: "ok\n" },
    });
    const result = await validateRunner({ docker, image: "img" });
    const check = result.checks.find((c) => c.name === "Git available")!;
    expect(check.ok).toBe(false);
    expect(check.hint).toMatch(/git/i);
  });

  it("reports leftover containers when cleanup fails", async () => {
    const result = await validateRunner({
      docker: fakeDocker({ cleanedUp: false }),
      image: "img",
    });
    const check = result.checks.find((c) => c.name === "Container cleaned up")!;
    expect(check.ok).toBe(false);
  });

  it("still attempts cleanup when the existence check throws", async () => {
    let removed = 0;
    const docker = fakeDocker({});
    const tracking: RunnerDocker = {
      ...docker,
      async remove(id: string) {
        removed++;
        await docker.remove(id);
      },
      async exists() {
        throw new Error("docker ps exploded");
      },
    };
    const result = await validateRunner({ docker: tracking, image: "img" });
    expect(removed).toBeGreaterThan(0);
    const check = result.checks.find((c) => c.name === "Container cleaned up")!;
    expect(check.ok).toBe(false);
  });
});

describe("adaptDockerRunner", () => {
  it("adapts the real DockerRunner to the RunnerDocker interface", () => {
    const adapter = adaptDockerRunner(new DockerRunner());
    expect(typeof adapter.run).toBe("function");
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.remove).toBe("function");
    expect(typeof adapter.exists).toBe("function");
  });
});
