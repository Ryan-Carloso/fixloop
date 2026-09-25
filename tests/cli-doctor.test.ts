import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor.js";
import { assertNoSecrets } from "../src/cli/redact.js";
import type { GitHubApi } from "../src/cli/github.js";
import type { RunnerDocker } from "../src/cli/docker-check.js";

const GITHUB_TOKEN = "ghp_doctortesttoken123";
const AI_KEY = "sk-ant-doctortestkey-123";

const YAML = `provider: bugsink
publicUrl: https://fixloop.example.com
githubAuthMethod: token
aiProvider: anthropic
model: anthropic/claude-sonnet-4-5
runnerImage: fixloop-runner:latest
repositories:
  my-app:
    providerProject: my-app
    github:
      repository: octocat/api
      defaultBranch: main
    commands:
      install: pnpm install --frozen-lockfile
      test: pnpm test
`;

const ENV = `FIXLOOP_WEBHOOK_SECRET=webhook-secret-123
GITHUB_TOKEN=${GITHUB_TOKEN}
ANTHROPIC_API_KEY=${AI_KEY}
`;

function healthyGitHub(): GitHubApi {
  return {
    async getAuthenticatedUser() {
      return { login: "octocat" };
    },
    async getRepository() {
      return { defaultBranch: "main", private: false, permissions: { push: true } };
    },
    async listRepositories() {
      return [];
    },
    async listRootFiles() {
      return [];
    },
  };
}

function healthyDocker(): RunnerDocker {
  return {
    async run(_image, command) {
      const [cmd] = command;
      if (cmd === "id") return { exitCode: 0, stdout: "1000\n", stderr: "", timedOut: false };
      return { exitCode: 0, stdout: "git version 2.45.0\n", stderr: "", timedOut: false };
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

function deps(dir: string, overrides: Record<string, unknown> = {}) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      dir,
      commandRunner: {
        run: async (cmd: string) => {
          if (cmd === "docker" || cmd === "git")
            return { exitCode: 0, stdout: "ok", stderr: "" };
          throw new Error(`unexpected: ${cmd}`);
        },
      },
      docker: healthyDocker(),
      createGitHubApi: () => healthyGitHub(),
      output: (l: string) => lines.push(l),
      // Every HTTP endpoint answers: API healthy, webhook route alive.
      http: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
      env: { FIXLOOP_PORT: "3000" },
      ...overrides,
    },
  };
}

function writeInstall(dir: string, yaml = YAML, env = ENV) {
  writeFileSync(join(dir, "fixloop.config.yaml"), yaml);
  writeFileSync(join(dir, ".env"), env, { mode: 0o600 });
}

describe("runDoctor", () => {
  it("reports all green for a healthy install and never prints secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-doctor-"));
    writeInstall(dir);
    const { lines, deps: d } = deps(dir);
    const result = await runDoctor(d);

    expect(result.ok).toBe(true);
    expect(result.checks.length).toBeGreaterThan(5);
    const names = result.checks.map((c) => c.name);
    expect(names).toContain("Configuration");
    expect(names).toContain("Required secrets");
    expect(names).toContain("GitHub");
    expect(names).toContain("Webhook endpoint");
    expect(names).toContain("API health");

    const output = lines.join("\n");
    assertNoSecrets(output, [GITHUB_TOKEN, AI_KEY, "webhook-secret-123"]);
    // Secret names are fine to mention.
    expect(output).toContain("GITHUB_TOKEN");
  });

  it("fails configuration and secrets checks when files are missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-doctor-"));
    const { deps: d } = deps(dir);
    const result = await runDoctor(d);

    expect(result.ok).toBe(false);
    const config = result.checks.find((c) => c.name === "Configuration")!;
    expect(config.ok).toBe(false);
    expect(config.hint).toMatch(/fixloop setup/);
    const secrets = result.checks.find((c) => c.name === "Required secrets")!;
    expect(secrets.ok).toBe(false);
  });

  it("reports partial failure: GitHub repo inaccessible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-doctor-"));
    writeInstall(dir);
    const badGitHub: GitHubApi = {
      ...healthyGitHub(),
      async getRepository() {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    };
    const { deps: d } = deps(dir, { createGitHubApi: () => badGitHub });
    const result = await runDoctor(d);

    expect(result.ok).toBe(false);
    const github = result.checks.find((c) => c.name === "GitHub")!;
    expect(github.ok).toBe(false);
    expect(github.hint).toMatch(/not found|access/i);
    // Unrelated checks still pass.
    expect(result.checks.find((c) => c.name === "Configuration")!.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "Required secrets")!.ok).toBe(true);
  });

  it("reports API down when /health is unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-doctor-"));
    writeInstall(dir);
    const { lines, deps: d } = deps(dir, {
      http: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const result = await runDoctor(d);

    const api = result.checks.find((c) => c.name === "API health")!;
    expect(api.ok).toBe(false);
    expect(api.hint).toMatch(/running|start/i);
    expect(result.ok).toBe(false);
    assertNoSecrets(lines.join("\n"), [GITHUB_TOKEN, AI_KEY, "webhook-secret-123"]);
  });

  it("detects an unreachable webhook endpoint (404 = route missing)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-doctor-"));
    writeInstall(dir);
    const { deps: d } = deps(dir, {
      http: (async (url: string) => {
        if (String(url).includes("/webhooks/")) return { ok: false, status: 404 };
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch,
    });
    const result = await runDoctor(d);
    const webhook = result.checks.find((c) => c.name === "Webhook endpoint")!;
    expect(webhook.ok).toBe(false);
    expect(webhook.hint).toMatch(/404|route/i);
  });

  it("is diagnostic-only: touches nothing on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-doctor-"));
    writeInstall(dir);
    const { readdirSync } = await import("node:fs");
    const before = readdirSync(dir).sort();
    const { deps: d } = deps(dir);
    await runDoctor(d);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("skips the Discord webhook check when DISCORD_WEBHOOK_URL is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-doctor-"));
    writeInstall(dir);
    const { deps: d } = deps(dir);
    const result = await runDoctor(d);
    expect(result.checks.find((c) => c.name === "Discord webhook")).toBeUndefined();
  });

  it("reports the Discord webhook reachable when the URL answers 200", async () => {
    const discordUrl = "https://discord.com/api/webhooks/EXAMPLE";
    const dir = mkdtempSync(join(tmpdir(), "fixloop-doctor-"));
    writeInstall(dir, YAML, `${ENV}DISCORD_WEBHOOK_URL=${discordUrl}\n`);
    const { lines, deps: d } = deps(dir);
    const result = await runDoctor(d);
    const check = result.checks.find((c) => c.name === "Discord webhook")!;
    expect(check.ok).toBe(true);
    assertNoSecrets(lines.join("\n"), [discordUrl]);
  });

  it("flags a Discord webhook URL that does not answer 200", async () => {
    const discordUrl = "https://discord.com/api/webhooks/EXAMPLE";
    const dir = mkdtempSync(join(tmpdir(), "fixloop-doctor-"));
    writeInstall(dir, YAML, `${ENV}DISCORD_WEBHOOK_URL=${discordUrl}\n`);
    const { deps: d } = deps(dir, {
      http: (async (url: string) => {
        if (String(url).includes("discord.com")) return { ok: false, status: 404 };
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch,
    });
    const result = await runDoctor(d);
    const check = result.checks.find((c) => c.name === "Discord webhook")!;
    expect(check.ok).toBe(false);
    expect(check.hint).toMatch(/DISCORD_WEBHOOK_URL/);
  });

  it("reports the Discord webhook unreachable when the request throws", async () => {
    const discordUrl = "https://discord.com/api/webhooks/EXAMPLE";
    const dir = mkdtempSync(join(tmpdir(), "fixloop-doctor-"));
    writeInstall(dir, YAML, `${ENV}DISCORD_WEBHOOK_URL=${discordUrl}\n`);
    const { lines, deps: d } = deps(dir, {
      http: (async (url: string) => {
        if (String(url).includes("discord.com"))
          throw new Error("getaddrinfo ENOTFOUND discord.com");
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch,
    });
    const result = await runDoctor(d);
    const check = result.checks.find((c) => c.name === "Discord webhook")!;
    expect(check.ok).toBe(false);
    expect(check.hint).toMatch(/DISCORD_WEBHOOK_URL/);
    assertNoSecrets(lines.join("\n"), [discordUrl]);
  });
});
