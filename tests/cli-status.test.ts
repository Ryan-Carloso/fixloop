import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoSecrets } from "../src/cli/redact.js";
import { runStatus } from "../src/cli/status.js";

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

const GITHUB_TOKEN = "ghp_statustesttoken123";
const AI_KEY = "sk-ant-statustestkey-123";

function writeInstall(dir: string) {
  writeFileSync(join(dir, "fixloop.config.yaml"), YAML);
  writeFileSync(
    join(dir, ".env"),
    `FIXLOOP_WEBHOOK_SECRET=webhook-secret-xyz\nGITHUB_TOKEN=${GITHUB_TOKEN}\nANTHROPIC_API_KEY=${AI_KEY}\n`,
    { mode: 0o600 },
  );
}

describe("runStatus", () => {
  it("shows concise status without ever printing secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-status-"));
    writeInstall(dir);
    const lines: string[] = [];
    const result = await runStatus({
      dir,
      commandRunner: {
        run: async (cmd: string) => {
          if (cmd === "docker") return { exitCode: 0, stdout: "ok", stderr: "" };
          throw new Error(`unexpected: ${cmd}`);
        },
      },
      http: async () => ({ ok: true }),
      output: (l) => lines.push(l),
    });

    expect(result.ok).toBe(true);
    const output = lines.join("\n");
    expect(output).toContain("octocat/api");
    expect(output).toContain("https://fixloop.example.com");
    assertNoSecrets(output, [GITHUB_TOKEN, AI_KEY, "webhook-secret-xyz"]);
    // Names are fine; values are masked.
    expect(output).toContain("GITHUB_TOKEN: ************");
  });

  it("reports missing configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-status-"));
    const lines: string[] = [];
    const result = await runStatus({ dir, output: (l) => lines.push(l) });
    expect(result.ok).toBe(false);
    expect(lines.join("\n")).toMatch(/missing|fixloop setup/);
  });

  it("reports a missing secret without printing other secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-status-"));
    writeFileSync(join(dir, "fixloop.config.yaml"), YAML);
    writeFileSync(join(dir, ".env"), `GITHUB_TOKEN=${GITHUB_TOKEN}\n`, { mode: 0o600 });
    const lines: string[] = [];
    const result = await runStatus({
      dir,
      commandRunner: { run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }) },
      http: async () => ({ ok: true }),
      output: (l) => lines.push(l),
    });
    expect(result.ok).toBe(false);
    const output = lines.join("\n");
    expect(output).toContain("FIXLOOP_WEBHOOK_SECRET: (missing)");
    assertNoSecrets(output, [GITHUB_TOKEN]);
  });
});
