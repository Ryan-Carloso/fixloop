import { execFile } from "node:child_process";
import { arch, cpus, platform, release, totalmem } from "node:os";

export interface SystemInfo {
  os: string;
  arch: string;
  cpus: number;
  totalMemBytes: number;
  freeDiskBytes: number;
  nodeVersion: string;
}

export interface Check {
  /** Short label, e.g. "Docker installed". */
  name: string;
  ok: boolean;
  /** Extra info shown on success, e.g. the version. */
  detail?: string;
  /** Actionable remediation shown on failure. */
  hint?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(cmd: string, args: string[]): Promise<CommandResult>;
}

/** Real runner backed by child_process.execFile. */
export const systemRunner: CommandRunner = {
  run(cmd: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & {
            code?: number;
            stdout?: string;
            stderr?: string;
          };
          if (e.code === "ENOENT") {
            reject(Object.assign(new Error(`command not found: ${cmd}`), { code: "ENOENT" }));
            return;
          }
          reject(
            Object.assign(new Error(`command failed: ${cmd}`), {
              code: "EEXIT",
              exitCode: e.code,
              stdout: String(e.stdout ?? ""),
              stderr: String(e.stderr ?? ""),
            }),
          );
          return;
        }
        resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  },
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${bytes} B`;
}

export async function detectSystem(
  runner: CommandRunner = systemRunner,
): Promise<SystemInfo> {
  let freeDiskBytes = 0;
  try {
    // df -k --output=avail <dir>: second line is available KiB.
    const df = await runner.run("df", ["-k", "--output=avail", process.cwd()]);
    const line = df.stdout.trim().split("\n")[1]?.trim();
    const kib = Number(line);
    if (Number.isFinite(kib)) freeDiskBytes = kib * 1024;
  } catch {
    // Disk info is best-effort; the wizard still works without it.
  }
  return {
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpus: cpus().length,
    totalMemBytes: totalmem(),
    freeDiskBytes,
    nodeVersion: process.version,
  };
}

export function formatSystemLine(info: SystemInfo): string {
  const parts = [
    info.os,
    info.arch,
    `${info.cpus} CPU${info.cpus === 1 ? "" : "s"}`,
    `${formatBytes(info.totalMemBytes)} RAM`,
  ];
  if (info.freeDiskBytes > 0) {
    parts.push(`${formatBytes(info.freeDiskBytes)} disk available`);
  }
  return parts.join(" · ");
}

export async function checkDocker(
  runner: CommandRunner = systemRunner,
): Promise<Check> {
  let version: string | undefined;
  try {
    const out = await runner.run("docker", ["--version"]);
    const m = out.stdout.match(/Docker version ([\d.]+)/);
    version = m?.[1] ?? out.stdout.trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        name: "Docker installed",
        ok: false,
        hint: "Install Docker: https://docs.docker.com/engine/install/ then re-run fixloop setup.",
      };
    }
    return {
      name: "Docker installed",
      ok: false,
      hint: "Could not run `docker --version`. Make sure Docker is installed and on PATH.",
    };
  }
  try {
    await runner.run("docker", ["info"]);
  } catch {
    return {
      name: "Docker daemon running",
      ok: false,
      detail: version ? `Docker ${version} installed` : undefined,
      hint: "Docker is installed but the daemon is not running. Start the Docker daemon, then re-run fixloop setup.",
    };
  }
  return { name: "Docker", ok: true, detail: `Docker ${version} · daemon running` };
}

export async function checkGit(
  runner: CommandRunner = systemRunner,
): Promise<Check> {
  try {
    const out = await runner.run("git", ["--version"]);
    const m = out.stdout.match(/git version ([\d.]+)/);
    return {
      name: "Git",
      ok: true,
      detail: m ? `Git ${m[1]}` : out.stdout.trim(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        name: "Git",
        ok: false,
        hint: "Install Git: https://git-scm.com/downloads then re-run fixloop setup.",
      };
    }
    return { name: "Git", ok: false, hint: "Could not run `git --version`." };
  }
}

export async function checkNodeVersion(): Promise<Check> {
  const major = Number(process.version.replace(/^v/, "").split(".")[0]);
  if (major >= 22) {
    return { name: "Node.js", ok: true, detail: `Node.js ${process.version}` };
  }
  return {
    name: "Node.js",
    ok: false,
    detail: `Node.js ${process.version}`,
    hint: "FixLoop requires Node.js 22 or newer. Install it from https://nodejs.org/ then re-run fixloop setup.",
  };
}
