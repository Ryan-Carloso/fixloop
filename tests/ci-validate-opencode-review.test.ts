import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * The OpenCode review workflow ships with a structural validator
 * (.github/scripts/validate-opencode-review.py) that guards its design
 * decisions. This test locks the validator into the repo's suite so the
 * workflow cannot silently rot: the validator must pass against the
 * committed workflow file.
 */
describe("opencode-review workflow validator", () => {
  it("passes all structural checks against the committed workflow", async () => {
    const { stdout } = await execFileAsync(
      "python3",
      [".github/scripts/validate-opencode-review.py"],
      { cwd: new URL("..", import.meta.url).pathname, timeout: 30000 },
    );
    expect(stdout).toContain("All checks passed.");
    expect(stdout).not.toContain("[FAIL]");
  });
});
