import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakePrompter, PromptCancelled } from "../src/cli/prompts.js";
import { assertNoSecrets } from "../src/cli/redact.js";
import { runSetup } from "../src/cli/setup.js";
import type { GitHubApi } from "../src/cli/github.js";
import type { RunnerDocker } from "../src/cli/docker-check.js";

const GITHUB_TOKEN = "ghp_setuptesttoken123";
const AI_KEY = "sk-ant-setuptestkey-123";

function fakeGitHub(): GitHubApi {
  return {
    async getAuthenticatedUser() {
      return { login: "octocat" };
    },
    async getRepository() {
      return { defaultBranch: "main", private: false, permissions: { push: true } };
    },
    async listRepositories() {
      return [{ fullName: "octocat/api", defaultBranch: "main" }];
    },
    async listRootFiles() {
      return ["pnpm-lock.yaml", "package.json"];
    },
  };
}

function fakeDocker(): RunnerDocker {
  return {
    async run(_image, command, _opts) {
      const [cmd, ...args] = command;
      if (cmd === "id") return { exitCode: 0, stdout: "1000\n", stderr: "", timedOut: false };
      if (cmd === "git") return { exitCode: 0, stdout: "git version 2.45.0\n", stderr: "", timedOut: false };
      if (cmd === "opencode" && args[0] === "--version")
        return { exitCode: 0, stdout: "opencode 1.2.3\n", stderr: "", timedOut: false };
      if (cmd === "opencode" && args[0] === "run")
        return { exitCode: 0, stdout: "OK\n", stderr: "", timedOut: false };
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
    async start() {
      return "abc123";
    },
    async remove() {},
    async exists() {
      return false;
    },
  };
}

function fakeCommandRunner() {
  return {
    run: async (cmd: string, _args: string[]) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "ok", stderr: "" };
      if (cmd === "git") return { exitCode: 0, stdout: "git version 2.45.0", stderr: "" };
      throw new Error(`unexpected command: ${cmd}`);
    },
  };
}

/** Full happy-path answer sequence for the wizard prompts, in order. */
function happyPathAnswers(): Array<string | boolean> {
  return [
    "bugsink", // provider
    "my-app", // BugSink project name
    true, // generate webhook token
    "https://fixloop.example.com", // public URL
    "token", // GitHub auth method
    GITHUB_TOKEN, // GitHub token
    "octocat/api", // repository
    true, // use detected commands
    "anthropic", // AI provider
    AI_KEY, // AI API key
    "anthropic/claude-sonnet-4-5", // model
    "fixloop-runner:latest", // runner image
    true, // run AI probe
    true, // save configuration
    false, // start now
  ];
}

function makeDir() {
  return mkdtempSync(join(tmpdir(), "fixloop-setup-"));
}

describe("runSetup happy path", () => {
  it("writes yaml + env atomically, never leaks secrets to output", async () => {
    const dir = makeDir();
    const lines: string[] = [];
    const result = await runSetup({
      dir,
      prompter: new FakePrompter(happyPathAnswers()),
      commandRunner: fakeCommandRunner(),
      docker: fakeDocker(),
      createGitHubApi: () => fakeGitHub(),
      output: (l) => lines.push(l),
      generateToken: () => "fixed-webhook-token-abcdef123456",
      startServer: async () => true,
    });

    expect(result.saved).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.webhookUrl).toBe("https://fixloop.example.com/webhooks/bugsink");

    const yaml = readFileSync(join(dir, "fixloop.config.yaml"), "utf8");
    expect(yaml).toContain("octocat/api");
    expect(yaml).toContain("bugsink");
    expect(yaml).toContain("https://fixloop.example.com");
    expect(yaml).toContain("my-app");
    expect(yaml).toContain("anthropic/claude-sonnet-4-5");
    expect(yaml).toContain("fixloop-runner:latest");
    expect(yaml).not.toContain(GITHUB_TOKEN);
    expect(yaml).not.toContain(AI_KEY);

    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain(`GITHUB_TOKEN=${GITHUB_TOKEN}`);
    expect(env).toContain(`ANTHROPIC_API_KEY=${AI_KEY}`);
    expect(env).toContain("FIXLOOP_WEBHOOK_SECRET=fixed-webhook-token-abcdef123456");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);

    const output = lines.join("\n");
    expect(output).toContain("https://fixloop.example.com/webhooks/bugsink");
    assertNoSecrets(output, [GITHUB_TOKEN, AI_KEY, "fixed-webhook-token-abcdef123456"]);
  });

  it("offers manual repository entry when the token cannot list repos", async () => {
    const dir = makeDir();
    const lines: string[] = [];
    const noList: GitHubApi = {
      ...fakeGitHub(),
      async listRepositories() {
        throw new Error("forbidden");
      },
    };
    const result = await runSetup({
      dir,
      prompter: new FakePrompter([
        "bugsink",
        "my-app",
        true,
        "https://fixloop.example.com",
        "token",
        GITHUB_TOKEN,
        "octocat/manual", // typed manually
        true,
        "anthropic",
        AI_KEY,
        "anthropic/claude-sonnet-4-5",
        "fixloop-runner:latest",
        false, // skip AI probe
        true, // save
        false, // start
      ]),
      commandRunner: fakeCommandRunner(),
      docker: fakeDocker(),
      createGitHubApi: () => noList,
      output: (l) => lines.push(l),
      generateToken: () => "tok",
    });
    expect(result.saved).toBe(true);
    expect(readFileSync(join(dir, "fixloop.config.yaml"), "utf8")).toContain("octocat/manual");
  });
});

describe("runSetup existing configuration", () => {
  it("cancel leaves existing files untouched", async () => {
    const dir = makeDir();
    const before = "port: 9999\n";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "fixloop.config.yaml"), before);
    const lines: string[] = [];
    const result = await runSetup({
      dir,
      prompter: new FakePrompter(["cancel"]),
      commandRunner: fakeCommandRunner(),
      docker: fakeDocker(),
      createGitHubApi: () => fakeGitHub(),
      output: (l) => lines.push(l),
    });
    expect(result.saved).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(readFileSync(join(dir, "fixloop.config.yaml"), "utf8")).toBe(before);
  });

  it("update choice re-runs the wizard and backs up the old config", async () => {
    const dir = makeDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "fixloop.config.yaml"), "port: 9999\n");
    const result = await runSetup({
      dir,
      prompter: new FakePrompter(["update", ...happyPathAnswers()]),
      commandRunner: fakeCommandRunner(),
      docker: fakeDocker(),
      createGitHubApi: () => fakeGitHub(),
      output: () => {},
      generateToken: () => "tok2",
    });
    expect(result.saved).toBe(true);
    const backups = (await import("node:fs")).readdirSync(dir).filter((f) => f.includes(".bak."));
    expect(backups.length).toBeGreaterThan(0);
  });
});

describe("runSetup cancellation", () => {
  it("Ctrl+C mid-flow writes nothing", async () => {
    const dir = makeDir();
    class BoomPrompter extends FakePrompter {
      override async input() {
        throw new PromptCancelled("SIGINT");
      }
    }
    const lines: string[] = [];
    const result = await runSetup({
      dir,
      prompter: new BoomPrompter(["bugsink"]),
      commandRunner: fakeCommandRunner(),
      docker: fakeDocker(),
      createGitHubApi: () => fakeGitHub(),
      output: (l) => lines.push(l),
    });
    expect(result.cancelled).toBe(true);
    expect(result.saved).toBe(false);
    expect(existsSync(join(dir, "fixloop.config.yaml"))).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(lines.join("\n")).toMatch(/cancelled/i);
  });
});

describe("runSetup assumeUpdate (fixloop configure)", () => {
  it("skips the existing-config menu and updates in place", async () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "fixloop.config.yaml"),
      "provider: bugsink\npublicUrl: https://old.example.com\nrepositories: {}\n",
    );
    writeFileSync(join(dir, ".env"), "FIXLOOP_WEBHOOK_SECRET=old-secret\n", { mode: 0o600 });
    const lines: string[] = [];
    const result = await runSetup({
      dir,
      prompter: new FakePrompter(happyPathAnswers()),
      commandRunner: fakeCommandRunner(),
      docker: fakeDocker(),
      createGitHubApi: () => fakeGitHub(),
      output: (l) => lines.push(l),
      generateToken: () => "fixed-webhook-token-abcdef123456",
      startServer: async () => true,
      assumeUpdate: true,
    });
    // If the menu had been shown, the answer stream would misalign and the
    // run would fail — saving cleanly proves the menu was skipped.
    expect(result.saved).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(readFileSync(join(dir, "fixloop.config.yaml"), "utf8")).toContain(
      "https://fixloop.example.com",
    );
  });
});
