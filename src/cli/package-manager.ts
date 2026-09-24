import { readdirSync } from "node:fs";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun" | "python" | "unknown";

export interface DetectedStack {
  manager: PackageManager;
  /** Suggested install command; empty when nothing could be inferred safely. */
  install: string;
  /** Suggested test command; empty when nothing could be inferred safely. */
  test: string;
  lint?: string;
  typecheck?: string;
}

/**
 * Detect the project stack from a list of file names (e.g. a repo root
 * listing fetched via the GitHub API). Detection order: pnpm, npm, yarn,
 * bun, python. Returns empty command suggestions (never guesses) when unknown.
 */
export function detectFromFiles(files: string[]): DetectedStack {
  const has = (f: string) => files.includes(f);

  if (has("pnpm-lock.yaml")) {
    return {
      manager: "pnpm",
      install: "pnpm install --frozen-lockfile",
      test: "pnpm test",
      lint: "pnpm lint",
      typecheck: "pnpm typecheck",
    };
  }
  if (has("package-lock.json")) {
    return {
      manager: "npm",
      install: "npm ci",
      test: "npm test",
      lint: "npm run lint",
      typecheck: "npm run typecheck",
    };
  }
  if (has("yarn.lock")) {
    return {
      manager: "yarn",
      install: "yarn install --frozen-lockfile",
      test: "yarn test",
      lint: "yarn lint",
      typecheck: "yarn typecheck",
    };
  }
  if (has("bun.lock") || has("bun.lockb")) {
    return {
      manager: "bun",
      install: "bun install --frozen-lockfile",
      test: "bun test",
      lint: "bun run lint",
      typecheck: "bun run typecheck",
    };
  }
  if (has("pyproject.toml") || has("requirements.txt")) {
    return {
      manager: "python",
      install: "pip install -r requirements.txt",
      test: "pytest",
    };
  }
  return { manager: "unknown", install: "", test: "" };
}

/**
 * Detect the project stack from lockfiles in a directory.
 * Detection order matters: pnpm first, then npm, yarn, bun, python.
 * Returns empty command suggestions (never guesses) when unknown.
 */
export function detectPackageManager(repoDir: string): DetectedStack {
  let files: string[];
  try {
    files = readdirSync(repoDir);
  } catch {
    return { manager: "unknown", install: "", test: "" };
  }
  return detectFromFiles(files);
}
