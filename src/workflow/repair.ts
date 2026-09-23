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

      // Capture the diff for the PR.
      let diff: string | undefined;
      if (greenProven) {
        const diffResult = await this.runner.exec(
          containerId,
          ["git", "diff"],
          { workdir: "/workspace" },
        );
        if (diffResult.exitCode === 0) {
          diff = diffResult.stdout;
        }
      }

      return { redProven: true, fixApplied: true, greenProven, diff };
    } finally {
      await this.runner.remove(containerId);
    }
  }
}
