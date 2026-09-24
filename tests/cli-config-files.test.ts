import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupFile,
  buildEnv,
  buildYaml,
  detectExisting,
  saveInstall,
  writeFileAtomic,
  type WizardConfig,
  type WizardSecrets,
} from "../src/cli/config-files.js";

const CFG: WizardConfig = {
  provider: "bugsink",
  providerProject: "my-app",
  publicUrl: "https://fixloop.example.com",
  repository: "my-user/my-app",
  defaultBranch: "main",
  commands: { install: "pnpm install --frozen-lockfile", test: "pnpm test" },
  githubAuthMethod: "token",
  aiProvider: "anthropic",
  model: "claude-sonnet-4-20250514",
  runnerImage: "fixloop-runner:latest",
};

const SECRETS: WizardSecrets = {
  webhookSecret: "whsec-abc123",
  githubToken: "ghp_def456",
  aiApiKey: "sk-ant-ghi789",
};

describe("buildYaml", () => {
  it("produces a valid repositories config", () => {
    const yaml = buildYaml(CFG);
    expect(yaml).toContain("my-user/my-app");
    expect(yaml).toContain("my-app");
    expect(yaml).toContain("pnpm test");
    expect(yaml).toContain("provider: bugsink");
  });

  it("never contains secret values", () => {
    const yaml = buildYaml(CFG);
    for (const s of Object.values(SECRETS)) {
      expect(yaml).not.toContain(s as string);
    }
    expect(yaml).not.toMatch(/ghp_/);
    expect(yaml).not.toMatch(/sk-ant-/);
  });
});

describe("buildEnv", () => {
  it("writes secrets as KEY=value lines", () => {
    const env = buildEnv(SECRETS, {}, "anthropic");
    expect(env).toContain("FIXLOOP_WEBHOOK_SECRET=whsec-abc123");
    expect(env).toContain("GITHUB_TOKEN=ghp_def456");
    expect(env).toContain("ANTHROPIC_API_KEY=sk-ant-ghi789");
  });

  it("preserves unrelated existing keys", () => {
    const env = buildEnv(SECRETS, { FIXLOOP_PORT: "3000" }, "anthropic");
    expect(env).toContain("FIXLOOP_PORT=3000");
    expect(env).toContain("GITHUB_TOKEN=ghp_def456");
  });

  it("updates managed keys instead of duplicating them", () => {
    const env = buildEnv(SECRETS, { GITHUB_TOKEN: "old" }, "anthropic");
    const matches = env.match(/^GITHUB_TOKEN=/gm);
    expect(matches).toHaveLength(1);
    expect(env).toContain("GITHUB_TOKEN=ghp_def456");
  });
});

describe("writeFileAtomic", () => {
  it("writes content via temp file + rename, cleaning up the temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-cfg-"));
    const target = join(dir, "fixloop.config.yaml");
    writeFileAtomic(target, "hello: 1\n");
    expect(readFileSync(target, "utf8")).toBe("hello: 1\n");
    // No temp files left behind.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  it("replaces existing content atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-cfg-"));
    const target = join(dir, "f");
    writeFileAtomic(target, "old");
    writeFileAtomic(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
  });
});

describe("backupFile", () => {
  it("copies the existing file to a timestamped backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-cfg-"));
    const target = join(dir, "fixloop.config.yaml");
    writeFileSync(target, "old");
    const backup = backupFile(target);
    expect(backup).toBeDefined();
    expect(readFileSync(backup!, "utf8")).toBe("old");
    expect(backup).toMatch(/\.bak\./);
  });

  it("returns undefined when there is nothing to back up", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-cfg-"));
    expect(backupFile(join(dir, "missing"))).toBeUndefined();
  });
});

describe("detectExisting", () => {
  it("reports a fresh directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-cfg-"));
    const found = detectExisting(dir);
    expect(found.hasConfig).toBe(false);
    expect(found.hasEnv).toBe(false);
  });

  it("parses an existing config without exposing secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixloop-cfg-"));
    writeFileSync(join(dir, "fixloop.config.yaml"), buildYaml(CFG));
    writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=ghp_secret\nFIXLOOP_PORT=3000\n");
    const found = detectExisting(dir);
    expect(found.hasConfig).toBe(true);
    expect(found.hasEnv).toBe(true);
    expect(found.config?.repositories["my-app"]?.github.repository).toBe("my-user/my-app");
    // Only key names are exposed, never values.
    expect(found.envKeys).toContain("GITHUB_TOKEN");
    expect(JSON.stringify(found)).not.toContain("ghp_secret");
  });
});

describe("saveInstall", () => {
  let dir: string;
  afterEach(() => {
    // keep temp dirs; they live under the OS tmpdir
  });

  it("writes config.yaml and .env, with .env restricted to owner-only", () => {
    dir = mkdtempSync(join(tmpdir(), "fixloop-cfg-"));
    saveInstall(dir, CFG, SECRETS);
    expect(readFileSync(join(dir, "fixloop.config.yaml"), "utf8")).toContain("my-user/my-app");
    const envContent = readFileSync(join(dir, ".env"), "utf8");
    expect(envContent).toContain("GITHUB_TOKEN=ghp_def456");
    const mode = statSync(join(dir, ".env")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("backs up existing files before replacing them", () => {
    dir = mkdtempSync(join(tmpdir(), "fixloop-cfg-"));
    writeFileSync(join(dir, "fixloop.config.yaml"), "old: config\n");
    writeFileSync(join(dir, ".env"), "OLD=1\n");
    saveInstall(dir, CFG, SECRETS);
    expect(readFileSync(join(dir, "fixloop.config.yaml"), "utf8")).toContain("my-user/my-app");
    const files: string[] = readdirSync(dir);
    expect(files.some((f) => f.startsWith("fixloop.config.yaml.bak."))).toBe(true);
    expect(files.some((f) => f.startsWith(".env.bak."))).toBe(true);
  });
});
