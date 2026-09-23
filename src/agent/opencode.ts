import type { DockerRunner } from "../docker/runner.js";
import type { ErrorContext } from "../providers/error-provider.js";

export interface Diagnosis {
  rootCause: string;
  filesToFix: string[];
}

/**
 * Abstraction for an AI coding agent that can diagnose and fix bugs
 * inside a container. The MVP uses the OpenCode CLI.
 */
export interface CodingAgent {
  diagnose(containerId: string, error: ErrorContext): Promise<Diagnosis>;
  applyFix(containerId: string, diagnosis: Diagnosis): Promise<boolean>;
}

/**
 * Uses `opencode run` inside the container to diagnose and fix bugs.
 * The container image must have the opencode CLI installed.
 */
export class OpenCodeAgent implements CodingAgent {
  constructor(private runner: DockerRunner) {}

  async diagnose(
    containerId: string,
    error: ErrorContext,
  ): Promise<Diagnosis> {
    const prompt = [
      "Diagnose the root cause of this error.",
      `Error: ${error.exception.type}: ${error.exception.message}`,
      `Issue: ${error.issueId}`,
      "Repository is at /workspace.",
      'Write your diagnosis as JSON to /tmp/diagnosis.json with the format: {"rootCause": "...", "filesToFix": ["..."]}',
      "Do not output any other text.",
    ].join("\n");
    const runResult = await this.runner.exec(
      containerId,
      ["opencode", "run", "--format", "json", prompt],
      { workdir: "/workspace" },
    );
    if (runResult.exitCode !== 0) {
      throw new Error(`opencode diagnose failed: ${runResult.stderr.trim()}`);
    }
    // Read the diagnosis file instead of parsing the event stream.
    const catResult = await this.runner.exec(containerId, [
      "cat",
      "/tmp/diagnosis.json",
    ]);
    if (catResult.exitCode !== 0) {
      throw new Error("opencode did not write /tmp/diagnosis.json.");
    }
    let parsed: { rootCause?: string; filesToFix?: string[] };
    try {
      parsed = JSON.parse(catResult.stdout.trim()) as {
        rootCause?: string;
        filesToFix?: string[];
      };
    } catch {
      throw new Error("opencode wrote invalid JSON to /tmp/diagnosis.json.");
    }
    return {
      rootCause: parsed.rootCause ?? "unknown",
      filesToFix: parsed.filesToFix ?? [],
    };
  }

  async applyFix(
    containerId: string,
    diagnosis: Diagnosis,
  ): Promise<boolean> {
    const prompt = [
      "Apply a minimal fix for this bug. Do not refactor unrelated code.",
      `Root cause: ${diagnosis.rootCause}`,
      `Files: ${diagnosis.filesToFix.join(", ")}`,
      "Repository is at /workspace.",
    ].join("\n");
    const result = await this.runner.exec(
      containerId,
      ["opencode", "run", "--format", "json", "--auto", prompt],
      { workdir: "/workspace" },
    );
    return result.exitCode === 0 && !result.timedOut;
  }
}
