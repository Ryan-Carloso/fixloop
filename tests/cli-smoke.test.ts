import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoSecrets } from "../src/cli/redact.js";
import { runSmokeTest, type ProbeHttp } from "../src/cli/smoke.js";
import type { GitHubApi } from "../src/cli/github.js";
import type { RunnerDocker } from "../src/cli/docker-check.js";

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

const WEBHOOK_SECRET = "smoke-webhook-secret-123";

function writeInstall(dir: string) {
  writeFileSync(join(dir, "fixloop.config.yaml"), YAML);
  writeFileSync(
    join(dir, ".env"),
    `FIXLOOP_WEBHOOK_SECRET=${WEBHOOK_SECRET}\nGITHUB_TOKEN=ghp_x\nANTHROPIC_API_KEY=sk_x\n`,
    { mode: 0o600 },
  );
}

function doctorFakes(): Record<string, unknown> {
  const github: GitHubApi = {
    async getAuthenticatedUser() {
      return { login: "o" };
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
  const docker: RunnerDocker = {
    async run(_image, command) {
      const [cmd] = command;
      if (cmd === "id") return { exitCode: 0, stdout: "1000\n", stderr: "", timedOut: false };
      return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
    },
    async start() {
      return "abc";
    },
    async remove() {},
    async exists() {
      return false;
    },
  };
  return {
    commandRunner: {
      run: async (cmd: string) => {
        if (cmd === "docker" || cmd === "git")
          return { exitCode: 0, stdout: "ok", stderr: "" };
        throw new Error(`unexpected: ${cmd}`);
      },
    },
    docker,
    createGitHubApi: () => github,
    http: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
    env: { FIXLOOP_PORT: "3000" },
  };
}

function probeHttp(status: number, body: unknown): ProbeHttp {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as ProbeHttp;
}

describe("runSmokeTest", () => {
  it("passes when doctor is green and the probe is accepted without queuing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-smoke-"));
    writeInstall(dir);
    const lines: string[] = [];
    const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const http: ProbeHttp = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      requests.push({ url, headers: init?.headers ?? {}, body: init?.body ?? "" });
      return { ok: true, status: 202, json: async () => ({ received: true, queued: false }) };
    }) as ProbeHttp;

    const result = await runSmokeTest({
      dir,
      output: (l) => lines.push(l),
      http,
      doctorDeps: doctorFakes(),
    });

    expect(result.ok).toBe(true);
    // The probe used the real token header and an unknown project.
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://fixloop.example.com/webhooks/bugsink");
    expect(requests[0].headers["x-fixloop-webhook-token"]).toBe(WEBHOOK_SECRET);
    expect(requests[0].body).toContain("fixloop-smoke-probe-unknown-project");
    const output = lines.join("\n");
    expect(output).toContain("nothing queued");
    assertNoSecrets(output, [WEBHOOK_SECRET]);
  });

  it("aborts without probing when doctor fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-smoke-"));
    // No config files: doctor fails.
    let probed = false;
    const result = await runSmokeTest({
      dir,
      output: () => {},
      http: (async () => {
        probed = true;
        return { ok: true, status: 202, json: async () => ({}) };
      }) as ProbeHttp,
      doctorDeps: doctorFakes(),
    });
    expect(result.ok).toBe(false);
    expect(probed).toBe(false);
  });

  it("fails on 401 with actionable guidance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-smoke-"));
    writeInstall(dir);
    const lines: string[] = [];
    const result = await runSmokeTest({
      dir,
      output: (l) => lines.push(l),
      http: probeHttp(401, { error: "invalid webhook token" }),
      doctorDeps: doctorFakes(),
    });
    expect(result.ok).toBe(false);
    expect(lines.join("\n")).toMatch(/401|token/i);
  });
});
