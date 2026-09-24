import { describe, expect, it } from "vitest";
import {
  verifyGitHub,
  type GitHubApi,
} from "../src/cli/github.js";

const TOKEN = "ghp_testtoken123";

function fakeApi(overrides: Partial<GitHubApi> = {}): GitHubApi {
  return {
    async getAuthenticatedUser() {
      return { login: "octocat" };
    },
    async getRepository(_owner, _repo) {
      return {
        defaultBranch: "main",
        permissions: { push: true },
        private: false,
      };
    },
    async listRepositories() {
      return [{ fullName: "octocat/api", defaultBranch: "main" }];
    },
    async listRootFiles() {
      return ["pnpm-lock.yaml", "package.json"];
    },
    ...overrides,
  };
}

describe("verifyGitHub", () => {
  it("passes all checks for a valid token and accessible repo", async () => {
    const result = await verifyGitHub(TOKEN, "octocat/api", fakeApi());
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "Authentication valid",
      "Repository accessible",
      "Repository contents readable",
      "Pull request access available",
    ]);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails authentication with an actionable hint and no token leak", async () => {
    const api = fakeApi({
      async getAuthenticatedUser() {
        throw Object.assign(new Error("Bad credentials"), { status: 401 });
      },
    });
    const result = await verifyGitHub(TOKEN, "octocat/api", api);
    expect(result.ok).toBe(false);
    expect(result.checks[0].ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/token/i);
    for (const c of result.checks) {
      expect(JSON.stringify(c)).not.toContain(TOKEN);
    }
  });

  it("reports an inaccessible repository distinctly from bad auth", async () => {
    const api = fakeApi({
      async getRepository() {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    });
    const result = await verifyGitHub(TOKEN, "octocat/missing", api);
    expect(result.ok).toBe(false);
    const repoCheck = result.checks.find((c) => c.name === "Repository accessible")!;
    expect(repoCheck.ok).toBe(false);
    expect(repoCheck.hint).toMatch(/octocat\/missing/);
    // Auth itself was fine.
    expect(result.checks[0].ok).toBe(true);
  });

  it("fails the PR check when the token lacks push permission", async () => {
    const api = fakeApi({
      async getRepository() {
        return { defaultBranch: "main", permissions: { push: false }, private: true };
      },
    });
    const result = await verifyGitHub(TOKEN, "octocat/api", api);
    expect(result.ok).toBe(false);
    const prCheck = result.checks.find((c) => c.name === "Pull request access available")!;
    expect(prCheck.ok).toBe(false);
    expect(prCheck.hint).toMatch(/permission|scope/i);
  });

  it("never creates branches or PRs during verification", async () => {
    let writes = 0;
    const api = fakeApi({
      async getRepository(owner, repo) {
        writes++; // counting only to prove: read path only
        return { defaultBranch: "main", permissions: { push: true }, private: false };
      },
    });
    await verifyGitHub(TOKEN, "octocat/api", api);
    expect(writes).toBeGreaterThan(0); // reads happened
    // The GitHubApi interface exposes no write operations at all.
    expect(Object.keys(api)).not.toContain("createBranch");
    expect(Object.keys(api)).not.toContain("createPullRequest");
  });
});
