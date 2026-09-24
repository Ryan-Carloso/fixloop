import { execFile } from "node:child_process";
import type { CommandResult, DockerRunner } from "../docker/runner.js";
import type { Check } from "./preflight.js";

/** Minimal docker surface the runner validation needs. */
export interface RunnerDocker {
  run(
    image: string,
    command: string[],
    opts?: { env?: Record<string, string>; network?: string; timeoutMs?: number },
  ): Promise<CommandResult>;
  start(image: string, command: string[], opts?: { timeoutMs?: number }): Promise<string>;
  remove(containerId: string): Promise<void>;
  exists(containerId: string): Promise<boolean>;
}

/** Adapt the real DockerRunner; `exists` shells out to `docker ps`. */
export function adaptDockerRunner(runner: DockerRunner): RunnerDocker {
  return {
    run: (image, command, opts) =>
      runner.run(image, command, {
        env: opts?.env,
        network: opts?.network,
        timeoutMs: opts?.timeoutMs,
      }),
    start: (image, command, opts) => runner.start(image, command, opts),
    remove: (id) => runner.remove(id),
    exists: (id) =>
      new Promise((resolve) => {
        execFile("docker", ["ps", "-q", "--no-trunc", "--filter", `id=${id}`], (err, stdout) => {
          if (err) return resolve(false);
          resolve(stdout.toString().trim().length > 0);
        });
      }),
  };
}

export interface RunnerValidation {
  ok: boolean;
  checks: Check[];
}

/**
 * Validate the Docker execution environment with a disposable container.
 * Always cleans up the container it starts, even when checks fail.
 */
export async function validateRunner(opts: {
  docker: RunnerDocker;
  image: string;
  timeoutMs?: number;
}): Promise<RunnerValidation> {
  const { docker, image } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const checks: Check[] = [];
  let probeId: string | undefined;

  const fail = (name: string, hint: string): RunnerValidation => {
    checks.push({ name, ok: false, hint });
    return finish(false);
  };

  const finish = (ok: boolean): RunnerValidation => ({ ok, checks });

  try {
    // 1. Container starts.
    try {
      const started = await docker.run(image, ["true"], { timeoutMs });
      if (started.exitCode !== 0 || started.timedOut) {
        return fail(
          "Container starts",
          `The image '${image}' would not start (exit ${started.exitCode}). Check the image name and that it is pulled.`,
        );
      }
    } catch (err) {
      return fail(
        "Container starts",
        `Could not start a container from '${image}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    checks.push({ name: "Container starts", ok: true, detail: image });

    // 2. Non-root execution.
    const idOut = await docker.run(image, ["id", "-u"], { timeoutMs });
    const uid = idOut.stdout.trim();
    if (idOut.exitCode !== 0 || uid === "0" || uid === "") {
      return fail(
        "Running as non-root",
        "The runner image runs as root (uid 0). For production, use an image with a non-root USER so untrusted repair code cannot easily escape with host-equivalent privileges.",
      );
    }
    checks.push({ name: "Running as non-root", ok: true, detail: `uid ${uid}` });

    // 3. Git available.
    const git = await docker.run(image, ["git", "--version"], { timeoutMs });
    if (git.exitCode !== 0) {
      return fail(
        "Git available",
        `Git is not installed in '${image}'. FixLoop clones repositories inside the runner; use an image with git installed.`,
      );
    }
    checks.push({ name: "Git available", ok: true, detail: git.stdout.trim() });

    // 4. OpenCode available.
    const oc = await docker.run(image, ["opencode", "--version"], { timeoutMs });
    if (oc.exitCode !== 0) {
      return fail(
        "OpenCode available",
        `The OpenCode CLI is not installed in '${image}'. Install it in the image (https://opencode.ai/docs) so the coding agent can run.`,
      );
    }
    checks.push({ name: "OpenCode available", ok: true, detail: oc.stdout.trim() });

    // 5. Workspace writable.
    const ws = await docker.run(
      image,
      ["sh", "-c", "touch /tmp/fixloop-write-test && rm /tmp/fixloop-write-test"],
      { timeoutMs },
    );
    if (ws.exitCode !== 0) {
      return fail(
        "Workspace writable",
        "The container could not write to its workspace. Check the image's filesystem permissions.",
      );
    }
    checks.push({ name: "Workspace writable", ok: true });

    // 6. Outbound network (needed for the AI provider).
    const net = await docker.run(
      image,
      ["sh", "-c", "getent hosts example.com || nslookup example.com 2>/dev/null || python3 -c 'import socket; socket.gethostbyname(\"example.com\")'"],
      { network: "bridge", timeoutMs },
    );
    if (net.exitCode !== 0 || net.timedOut) {
      return fail(
        "Network available",
        "The runner could not reach the network (DNS lookup failed). The AI provider needs outbound HTTPS; ensure the Docker network allows it.",
      );
    }
    checks.push({ name: "Network available", ok: true });

    // 7. Container cleanup: start a detached container, remove it, verify it is gone.
    probeId = await docker.start(image, ["sleep", "300"], { timeoutMs });
    await docker.remove(probeId);
    let gone = false;
    try {
      gone = !(await docker.exists(probeId));
    } catch {
      gone = false;
    }
    if (!gone) {
      checks.push({
        name: "Container cleaned up",
        ok: false,
        hint: "The test container was not removed. Check `docker ps -a` for leftovers and Docker daemon health.",
      });
      return finish(false);
    }
    checks.push({ name: "Container cleaned up", ok: true });
    return finish(true);
  } finally {
    if (probeId) {
      // Best effort: never leave the probe container behind.
      await docker.remove(probeId).catch(() => {});
    }
  }
}
