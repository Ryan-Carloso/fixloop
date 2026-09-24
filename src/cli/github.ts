import { Octokit } from "octokit";
import { redactSecrets } from "./redact.js";
import type { Check } from "./preflight.js";

/**
 * Read-only GitHub API surface used for setup verification.
 * Deliberately exposes no write operations: verification must never
 * create branches or PRs.
 */
export interface GitHubApi {
  getAuthenticatedUser(): Promise<{ login: string }>;
  getRepository(
    owner: string,
    repo: string,
  ): Promise<{
    defaultBranch: string;
    permissions: { push: boolean };
    private: boolean;
  }>;
  listRepositories(): Promise<Array<{ fullName: string; defaultBranch: string }>>;
  /** Names of files/directories at the repository root (for stack detection). */
  listRootFiles(owner: string, repo: string): Promise<string[]>;
}

export interface GitHubVerification {
  ok: boolean;
  /** login of the authenticated user, when authentication succeeded. */
  login?: string;
  defaultBranch?: string;
  checks: Check[];
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

function safeMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

/** Octokit-backed implementation of the read-only verification API. */
export function createGitHubApi(token: string): GitHubApi {
  const octokit = new Octokit({ auth: token });
  return {
    async getAuthenticatedUser() {
      const { data } = await octokit.rest.users.getAuthenticated();
      return { login: data.login };
    },
    async getRepository(owner: string, repo: string) {
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return {
        defaultBranch: data.default_branch,
        permissions: { push: data.permissions?.push === true },
        private: data.private === true,
      };
    },
    async listRepositories() {
      const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
        per_page: 100,
      });
      return repos.map((r) => ({
        fullName: r.full_name,
        defaultBranch: r.default_branch ?? "main",
      }));
    },
    async listRootFiles(owner: string, repo: string) {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path: "" });
      if (!Array.isArray(data)) return [];
      return data.map((e) => e.name);
    },
  };
}

export function parseRepository(input: string): { owner: string; repo: string } | undefined {
  const m = input.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return undefined;
  return { owner: m[1], repo: m[2] };
}

export function validateRepository(input: string): true | string {
  return parseRepository(input)
    ? true
    : "Enter the repository as owner/repo, e.g. my-user/my-app";
}

/**
 * Verify a GitHub token against a repository. Read-only: uses auth,
 * repo metadata and permission flags only.
 */
export async function verifyGitHub(
  token: string,
  repository: string,
  api?: GitHubApi,
): Promise<GitHubVerification> {
  const client = api ?? createGitHubApi(token);
  const checks: Check[] = [];
  const parsed = parseRepository(repository);
  if (!parsed) {
    return {
      ok: false,
      checks: [
        {
          name: "Authentication valid",
          ok: false,
          hint: `Invalid repository format: '${repository}'. Use owner/repo.`,
        },
      ],
    };
  }
  const { owner, repo } = parsed;

  // 1. Authentication.
  let login: string | undefined;
  try {
    const user = await client.getAuthenticatedUser();
    login = user.login;
    checks.push({
      name: "Authentication valid",
      ok: true,
      detail: `Authenticated as ${login}`,
    });
  } catch (err) {
    const hint =
      statusOf(err) === 401 || statusOf(err) === 403
        ? "The token was rejected. Check that it is correct and not expired, then try again."
        : `Could not reach GitHub: ${safeMessage(err)}`;
    checks.push({ name: "Authentication valid", ok: false, hint });
    return { ok: false, checks };
  }

  // 2. Repository access + 3. contents readable (metadata read proves it).
  let defaultBranch = "main";
  let canPush = false;
  try {
    const info = await client.getRepository(owner, repo);
    defaultBranch = info.defaultBranch;
    canPush = info.permissions.push;
    checks.push({
      name: "Repository accessible",
      ok: true,
      detail: `${owner}/${repo} (default branch: ${defaultBranch})`,
    });
    checks.push({
      name: "Repository contents readable",
      ok: true,
      detail: "Repository metadata readable via the API",
    });
  } catch (err) {
    const hint =
      statusOf(err) === 404
        ? `GitHub cannot find '${owner}/${repo}' for this token. Check the name, and make sure the token (or GitHub App installation) has access to it.`
        : `Could not read '${owner}/${repo}': ${safeMessage(err)}`;
    checks.push({ name: "Repository accessible", ok: false, hint });
    return { ok: false, login, checks };
  }

  // 4. PR capability, inferred from push permission (no test PR created).
  if (canPush) {
    checks.push({
      name: "Pull request access available",
      ok: true,
      detail: "Token can push branches (required to open fix PRs)",
    });
  } else {
    checks.push({
      name: "Pull request access available",
      ok: false,
      hint: "The token cannot push to this repository. Grant it contents:write permission (fine-grained PAT) or repo scope (classic PAT), then re-run verification.",
    });
  }

  return { ok: canPush, login, defaultBranch, checks };
}
