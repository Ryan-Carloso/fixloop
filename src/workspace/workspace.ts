import type { DockerRunner } from "../docker/runner.js";

export interface WorkspaceOptions {
  /** Git URL or local path to clone. */
  repoUrl: string;
  /** Command to run the test suite, e.g. ["npm", "test"]. */
  testCommand: string[];
  /** Docker image with git + runtime. Default "node:22". */
  image?: string;
  /** Bind mounts, e.g. ["/host/fixture:/fixtures/buggy-app"] for local repos. */
  volumes?: string[];
  /** Docker network. Default "none". Use "bridge" for remote repo URLs. */
  network?: string;
}

export interface CloneTestOutcome {
  cloneOk: boolean;
  testsPassed: boolean;
  testStdout: string;
  testStderr: string;
}

/**
 * Orchestrates the RED phase: clone a repo into an ephemeral container
 * and run its test suite. The container is always destroyed afterwards.
 */
export class RepairWorkspace {
  constructor(
    private runner: DockerRunner,
    private opts: WorkspaceOptions,
  ) {}

  async cloneAndTest(): Promise<CloneTestOutcome> {
    const image = this.opts.image ?? "node:22";
    const containerId = await this.runner.start(image, ["sleep", "3600"], {
      volumes: this.opts.volumes,
      network: this.opts.network,
    });
    try {
      const clone = await this.runner.exec(containerId, [
        "git",
        "clone",
        this.opts.repoUrl,
        "/workspace",
      ]);
      if (clone.exitCode !== 0) {
        return {
          cloneOk: false,
          testsPassed: false,
          testStdout: "",
          testStderr: clone.stderr,
        };
      }
      const test = await this.runner.exec(
        containerId,
        this.opts.testCommand,
        { workdir: "/workspace" },
      );
      return {
        cloneOk: true,
        testsPassed: test.exitCode === 0 && !test.timedOut,
        testStdout: test.stdout,
        testStderr: test.stderr,
      };
    } finally {
      await this.runner.remove(containerId);
    }
  }
}
