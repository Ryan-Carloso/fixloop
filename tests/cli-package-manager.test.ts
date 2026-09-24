import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPackageManager } from "../src/cli/package-manager.js";

function dirWith(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "fixloop-pm-"));
  for (const f of files) writeFileSync(join(dir, f), "");
  return dir;
}

describe("detectPackageManager", () => {
  it("detects pnpm from pnpm-lock.yaml", () => {
    const d = detectPackageManager(dirWith("pnpm-lock.yaml", "package.json"));
    expect(d.manager).toBe("pnpm");
    expect(d.install).toBe("pnpm install --frozen-lockfile");
    expect(d.test).toBe("pnpm test");
  });

  it("detects npm from package-lock.json", () => {
    const d = detectPackageManager(dirWith("package-lock.json"));
    expect(d.manager).toBe("npm");
    expect(d.install).toBe("npm ci");
  });

  it("detects yarn from yarn.lock", () => {
    const d = detectPackageManager(dirWith("yarn.lock"));
    expect(d.manager).toBe("yarn");
    expect(d.install).toContain("yarn install");
  });

  it("detects bun from bun.lock", () => {
    const d = detectPackageManager(dirWith("bun.lock"));
    expect(d.manager).toBe("bun");
  });

  it("detects python from pyproject.toml", () => {
    const d = detectPackageManager(dirWith("pyproject.toml"));
    expect(d.manager).toBe("python");
    expect(d.test).toContain("pytest");
  });

  it("returns unknown with empty commands when nothing is detected", () => {
    const d = detectPackageManager(dirWith("README.md"));
    expect(d.manager).toBe("unknown");
    expect(d.install).toBe("");
    expect(d.test).toBe("");
  });

  it("prefers pnpm when multiple lockfiles exist", () => {
    const d = detectPackageManager(dirWith("pnpm-lock.yaml", "package-lock.json"));
    expect(d.manager).toBe("pnpm");
  });
});
