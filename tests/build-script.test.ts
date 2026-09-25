import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("scripts/copy-schema.mjs", () => {
  it("copies a schema file to the destination dir (cross-platform build step)", () => {
    // Runs against a temp dir: the unit test must not write build output
    // into the repo as a side effect of `vitest run`.
    const dir = mkdtempSync(join(tmpdir(), "fixloop-copy-schema-"));
    const src = join(dir, "schema.sql");
    const dest = join(dir, "nested", "schema.sql");
    writeFileSync(src, "CREATE TABLE t (id TEXT PRIMARY KEY);\n");

    execFileSync(process.execPath, [
      `${repoRoot}/scripts/copy-schema.mjs`,
      src,
      dest,
    ]);

    expect(readFileSync(dest, "utf8")).toBe(
      "CREATE TABLE t (id TEXT PRIMARY KEY);\n",
    );
  });

  it("is wired into the build script (default paths run at build time)", () => {
    // The default src -> dist copy runs as part of `npm run build`, not
    // under vitest, so the unit test stays side-effect free.
    const pkg = JSON.parse(
      readFileSync(`${repoRoot}/package.json`, "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toContain("node scripts/copy-schema.mjs");
  });
});
