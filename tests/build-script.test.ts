import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("scripts/copy-schema.mjs", () => {
  it("copies src/db/schema.sql to dist/db/schema.sql (cross-platform build step)", () => {
    execFileSync(process.execPath, [`${repoRoot}/scripts/copy-schema.mjs`]);
    expect(readFileSync(`${repoRoot}/dist/db/schema.sql`, "utf8")).toBe(
      readFileSync(`${repoRoot}/src/db/schema.sql`, "utf8"),
    );
  });
});
