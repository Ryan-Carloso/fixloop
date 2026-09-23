import type { DockerRunner } from "../docker/runner.js";
import type { CodingAgent } from "../agent/opencode.js";
import type { ErrorContext } from "../providers/error-provider.js";

export interface RepairOptions {
  repoUrl: string;
  testCommand: string[];
  image?: string;
  volumes?: string[];
  network?: string;
}

export interface RepairOutcome {
  /** True if the test suite failed before the fix (bug reproduced). */
  redProven: boolean;
  /** True if the agent attempted a fix. */
  fixApplied: boolean;
  /** True if the test suite passed after the fix. */
  greenProven: boolean;
  /** Unified diff of the fix, if any. */
  diff?: string;
  /** Changed files with their new content, for PR creation. */
  changedFiles?: Array<{ path: string; content: string }>;
}

/**
 * Orchestrates the RED → GREEN repair workflow:
 * 1. Clone the repo into an ephemeral container.
 * 2. Run tests to prove RED (bug reproduces).
 * 3. Diagnose with the coding agent.
 * 4. Apply a minimal fix.
 * 5. Re-run tests to prove GREEN.
 * The container is always destroyed afterwards.
 */
export class RepairWorkflow {
  constructor(
    private runner: DockerRunner,
    private agent: CodingAgent,
    private opts: RepairOptions,
  ) {}

  async repair(error: ErrorContext): Promise<RepairOutcome> {
    const image = this.opts.image ?? "node:22";
    const containerId = await this.runner.start(image, ["sleep", "3600"], {
      volumes: this.opts.volumes,
      network: this.opts.network,
    });
    try {
      // Clone.
      const clone = await this.runner.exec(containerId, [
        "git",
        "clone",
        this.opts.repoUrl,
        "/workspace",
      ]);
      if (clone.exitCode !== 0) {
        throw new Error(`Clone failed: ${clone.stderr.trim()}`);
      }

      // Prove RED: tests must fail before the fix.
      const red = await this.runner.exec(containerId, this.opts.testCommand, {
        workdir: "/workspace",
      });
      const redProven = red.exitCode !== 0 || red.timedOut;
      if (!redProven) {
        return { redProven: false, fixApplied: false, greenProven: false };
      }

      // Diagnose and fix.
      const diagnosis = await this.agent.diagnose(containerId, error);
      const fixApplied = await this.agent.applyFix(containerId, diagnosis);
      if (!fixApplied) {
        return { redProven: true, fixApplied: false, greenProven: false };
      }

      // Prove GREEN: tests must pass after the fix.
      const green = await this.runner.exec(containerId, this.opts.testCommand, {
        workdir: "/workspace",
      });
      const greenProven = green.exitCode === 0 && !green.timedOut;

      // Capture the diff and changed files for the PR.
      let diff: string | undefined;
      let changedFiles: Array<{ path: string; content: string }> | undefined;
      if (greenProven) {
        const diffResult = await this.runner.exec(
          containerId,
          ["git", "diff"],
          { workdir: "/workspace" },
        );
        if (diffResult.exitCode === 0) {
          diff = diffResult.stdout;
        }
        // Get the list of changed files and their new content.
        // Use --name-status to detect deletions; deleted files are skipped
        // (not supported in MVP — the GitHub client only handles modifications).
        const namesResult = await this.runner.exec(
          containerId,
          ["git", "diff", "--name-status"],
          { workdir: "/workspace" },
        );
        if (namesResult.exitCode === 0) {
          const lines = namesResult.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          changedFiles = [];
          for (const line of lines) {
            const [status, file] = line.split(/\s+/, 2);
            if (!file) continue;
            if (status === "D") {
              // Skip deleted files (MVP limitation).
              continue;
            }
            const catResult = await this.runner.exec(
              containerId,
              ["cat", `/workspace/${file}`],
            );
            if (catResult.exitCode === 0) {
              changedFiles.push({ path: file, content: catResult.stdout });
            }
          }
        }
      }

      return { redProven: true, fixApplied: true, greenProven, diff, changedFiles };
    } finally {
      await this.runner.remove(containerId);
    }
  }
}
