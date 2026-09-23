import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findRepository,
  loadConfig,
  type FixLoopConfig,
} from "../src/config/config.js";

const exampleConfig: FixLoopConfig = {
  repositories: {
    "my-app": {
      providerProject: "my-app",
      github: { repository: "my-user/my-app", defaultBranch: "main" },
      commands: {
        install: "pnpm install --frozen-lockfile",
        test: "pnpm test",
        lint: "pnpm lint",
        typecheck: "pnpm typecheck",
      },
    },
  },
};

describe("loadConfig", () => {
  it("parses a YAML config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixloop-"));
    const path = join(dir, "fixloop.config.yaml");
    await writeFile(
      path,
      `repositories:\n  my-app:\n    providerProject: my-app\n    github:\n      repository: my-user/my-app\n      defaultBranch: main\n    commands:\n      install: pnpm install --frozen-lockfile\n      test: pnpm test\n`,
    );
    const cfg = loadConfig(path);
    expect(cfg.repositories["my-app"].github.repository).toBe("my-user/my-app");
    expect(cfg.repositories["my-app"].commands.test).toBe("pnpm test");
  });

  it("validates the shipped example config", () => {
    const cfg = loadConfig("fixloop.config.example.yaml");
    expect(Object.keys(cfg.repositories).length).toBeGreaterThan(0);
  });

  it("rejects invalid configs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixloop-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, `repositories:\n  my-app:\n    github: {}\n`);
    expect(() => loadConfig(path)).toThrow();
  });

  it("throws a clear error when the file does not exist", () => {
    expect(() => loadConfig("/nonexistent/fixloop.yaml")).toThrow(/not found/i);
  });
});

describe("findRepository", () => {
  it("maps a provider project name to its repository entry", () => {
    const found = findRepository(exampleConfig, "my-app");
    expect(found?.key).toBe("my-app");
    expect(found?.config.github.repository).toBe("my-user/my-app");
  });

  it("returns undefined when nothing matches", () => {
    expect(findRepository(exampleConfig, "unknown")).toBeUndefined();
    expect(findRepository(exampleConfig, undefined)).toBeUndefined();
  });
});
