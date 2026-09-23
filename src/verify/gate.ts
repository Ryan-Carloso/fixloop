import type { DockerRunner } from "../docker/runner.js";

export interface VerifyOptions {
  repoUrl: string;
  testCommand: string[];
  image?: string;
  volumes?: string[];
  network?: string;
}

export interface VerifyVerdict {
  passed: boolean;
  testsPassed: boolean;
  reason?: string;
}

/**
 * Independent verification gate.
 *
 * Takes the diff produced by the repair workflow and verifies it in a
 * FRESH container (not the one the coding agent used). This is the
 * adversarial check: if OpenCode claims "fixed" but the tests still fail,
 * the gate rejects and no PR is created.
 */
export class VerificationGate {
  constructor(
    private runner: DockerRunner,
    private opts: VerifyOptions,
  ) {}

  async verify(diff: string): Promise<VerifyVerdict> {
    const image = this.opts.image ?? "node:22";
    const containerId = await this.runner.start(image, ["sleep", "3600"], {
      volumes: this.opts.volumes,
      network: this.opts.network,
    });
    try {
      // Clone the pristine repo.
      const clone = await this.runner.exec(containerId, [
        "git",
        "clone",
        this.opts.repoUrl,
        "/workspace",
      ]);
      if (clone.exitCode !== 0) {
        return {
          passed: false,
          testsPassed: false,
          reason: `Clone failed: ${clone.stderr.trim()}`,
        };
      }

      // Write the diff to a file and apply it.
      // Base64-encode to avoid shell injection via the diff content.
      const diffB64 = Buffer.from(diff, "utf8").toString("base64");
      const write = await this.runner.exec(containerId, [
        "sh",
        "-c",
        `echo ${diffB64} | base64 -d > /tmp/fix.diff`,
      ]);
      if (write.exitCode !== 0) {
        return {
          passed: false,
          testsPassed: false,
          reason: "Could not write diff to container.",
        };
      }
      const apply = await this.runner.exec(containerId, ["git", "apply", "/tmp/fix.diff"], {
        workdir: "/workspace",
      });
      if (apply.exitCode !== 0) {
        return {
          passed: false,
          testsPassed: false,
          reason: `Diff could not be applied: ${apply.stderr.trim()}`,
        };
      }

      // Run the tests. This is the independent check.
      const test = await this.runner.exec(containerId, this.opts.testCommand, {
        workdir: "/workspace",
      });
      const testsPassed = test.exitCode === 0 && !test.timedOut;
      if (!testsPassed) {
        return {
          passed: false,
          testsPassed: false,
          reason:
            "Independent verification failed: tests failed after applying the fix.",
        };
      }
      return { passed: true, testsPassed: true };
    } finally {
      await this.runner.remove(containerId);
    }
  }
}
