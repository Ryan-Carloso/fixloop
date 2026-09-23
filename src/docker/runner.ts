import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunOptions {
  /** Wall-clock limit for the container. Default 5 minutes. */
  timeoutMs?: number;
  /** CPU limit. Default "1". */
  cpus?: number | string;
  /** Memory limit. Default "512m". */
  memory?: string;
  /** PID limit. Default 100. */
  pidsLimit?: number;
  /** Docker network. Default "none" (no network access). */
  network?: string;
  /** Environment variables to pass into the container. */
  env?: Record<string, string>;
  /** Working directory inside the container. */
  workdir?: string;
}

export interface StartOptions {
  /** CPU limit. Default "1". */
  cpus?: number | string;
  /** Memory limit. Default "512m". */
  memory?: string;
  /** PID limit. Default 100. */
  pidsLimit?: number;
  /** Docker network. Default "none" (no network access). */
  network?: string;
  /** Environment variables to pass into the container. */
  env?: Record<string, string>;
  /** Working directory inside the container. */
  workdir?: string;
  /** Bind mounts, e.g. ["/host/path:/container/path"]. */
  volumes?: string[];
  /** Wall-clock limit for the start command itself. Default 60s. */
  timeoutMs?: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  workdir?: string;
  env?: Record<string, string>;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Cap captured output to avoid unbounded memory growth. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Runs ephemeral Docker containers (`docker run --rm`).
 *
 * Every container is launched with resource limits and no network access
 * unless the caller opts in. A timeout kills the container process and the
 * result reports `timedOut: true`. Containers are always ephemeral (`--rm`),
 * so no explicit destroy step can be forgotten.
 */
export class DockerRunner {
  async run(
    image: string,
    command: string[],
    opts: RunOptions = {},
  ): Promise<CommandResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Give the container a known identity so a timeout can kill it explicitly.
    // Killing the docker CLI alone would orphan the container on the daemon.
    const workdir = mkdtempSync(join(tmpdir(), "fixloop-"));
    const cidfile = join(workdir, "cid");
    const args = [
      "run",
      "--rm",
      `--cidfile=${cidfile}`,
      `--cpus=${opts.cpus ?? 1}`,
      `--memory=${opts.memory ?? "512m"}`,
      `--pids-limit=${opts.pidsLimit ?? 100}`,
      `--network=${opts.network ?? "none"}`,
    ];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      args.push("--env", `${k}=${v}`);
    }
    if (opts.workdir) args.push("--workdir", opts.workdir);
    args.push(image, ...command);
    try {
      return await this.spawnDocker(args, timeoutMs, cidfile);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  /** Runs a command inside an already-running container. */
  async exec(
    containerId: string,
    command: string[],
    opts: ExecOptions = {},
  ): Promise<CommandResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = ["exec"];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      args.push("--env", `${k}=${v}`);
    }
    if (opts.workdir) args.push("--workdir", opts.workdir);
    args.push(containerId, ...command);
    return this.spawnDocker(args, timeoutMs);
  }

  /**
   * Starts a detached container and returns its ID.
   * Unlike run(), the container is NOT --rm; the caller must remove() it.
   * Used for multi-step workflows (clone, then test, then fix).
   */
  async start(
    image: string,
    command: string[],
    opts: StartOptions = {},
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    // Use a cidfile so a timeout/hang can clean up the container explicitly.
    const workdir = mkdtempSync(join(tmpdir(), "fixloop-"));
    const cidfile = join(workdir, "cid");
    const args = [
      "run",
      "-d",
      `--cidfile=${cidfile}`,
      `--cpus=${opts.cpus ?? 1}`,
      `--memory=${opts.memory ?? "512m"}`,
      `--pids-limit=${opts.pidsLimit ?? 100}`,
      `--network=${opts.network ?? "none"}`,
    ];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      args.push("--env", `${k}=${v}`);
    }
    for (const v of opts.volumes ?? []) {
      args.push("-v", v);
    }
    if (opts.workdir) args.push("--workdir", opts.workdir);
    args.push(image, ...command);
    try {
      const result = await this.spawnDocker(args, timeoutMs, cidfile);
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to start container: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        );
      }
      const id = result.stdout.trim();
      if (!id) {
        throw new Error("Docker did not return a container ID.");
      }
      return id;
    } catch (err) {
      // If start failed/timed out, try to clean up via the cidfile.
      try {
        const cid = readFileSync(cidfile, "utf8").trim();
        if (cid) {
          await this.remove(cid);
        }
      } catch {
        // No cidfile or already gone; nothing to clean.
      }
      throw err;
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  /**
   * Best-effort destroy. Never throws: callers use this in cleanup paths
   * where the container may already be gone.
   */
  async remove(containerId: string): Promise<void> {
    try {
      await this.spawnDocker(["rm", "-f", containerId], 30_000);
    } catch {
      // The container is already gone or Docker is unreachable; nothing to do.
    }
  }

  private spawnDocker(
    args: string[],
    timeoutMs: number,
    /** Path to a docker --cidfile; on timeout the container is rm -f'd. */
    cidfile?: string,
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        reject(
          new Error(
            `Failed to start docker CLI: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;

      const appendCapped = (
        chunk: Buffer,
        current: string,
        truncated: boolean,
      ): [string, boolean] => {
        if (truncated) return [current, true];
        const next = current + chunk.toString();
        if (next.length > MAX_OUTPUT_BYTES) {
          return [next.slice(0, MAX_OUTPUT_BYTES), true];
        }
        return [next, false];
      };

      const killContainer = () => {
        if (!cidfile) return;
        try {
          const cid = readFileSync(cidfile, "utf8").trim();
          if (cid) {
            // Best effort: the container may already be gone.
            spawn("docker", ["rm", "-f", cid], {
              stdio: "ignore",
            }).on("error", () => {});
          }
        } catch {
          // No cidfile yet (container never started); nothing to kill.
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the container explicitly: killing the CLI alone would orphan it.
        killContainer();
        proc.kill("SIGKILL");
      }, timeoutMs);
      // Do not keep the event loop alive just for the kill timer.
      timer.unref?.();

      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      proc.stdout?.on("data", (d: Buffer) => {
        [stdout, stdoutTruncated] = appendCapped(d, stdout, stdoutTruncated);
      });
      proc.stderr?.on("data", (d: Buffer) => {
        [stderr, stderrTruncated] = appendCapped(d, stderr, stderrTruncated);
      });
      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          fail(
            new Error(
              "Docker CLI not found. Install Docker and make sure `docker` is on PATH.",
            ),
          );
        } else {
          fail(err);
        }
      });
      proc.on("close", (exitCode, signal) => {
        finish({ exitCode, signal, stdout, stderr, timedOut });
      });
    });
  }
}
