import type { Octokit } from "octokit";

export interface ChangedFile {
  path: string;
  content: string;
}

export interface CreatePrOptions {
  branch: string;
  base: string;
  title: string;
  body: string;
  changedFiles: ChangedFile[];
}

export interface PullRequest {
  number: number;
  url: string;
}

/**
 * GitHub client for creating fix branches and pull requests.
 * Uses Octokit; the token is provided by the caller (from Secure Vault).
 *
 * The fix is pushed via the Git Data API (blobs → tree → commit → ref),
 * so the PR contains the actual changes, not an empty branch.
 */
export class GitHubClient {
  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
  ) {}

  async createFixPr(opts: CreatePrOptions): Promise<PullRequest> {
    if (opts.changedFiles.length === 0) {
      throw new Error("Cannot create PR with no changed files.");
    }

    // Get the base branch SHA.
    let baseSha: string;
    try {
      const ref = await this.octokit.rest.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${opts.base}`,
      });
      baseSha = ref.data.object.sha;
    } catch {
      throw new Error(`Base branch '${opts.base}' does not exist.`);
    }

    // Create blobs for each changed file.
    const blobs = await Promise.all(
      opts.changedFiles.map(async (file) => {
        const blob = await this.octokit.rest.git.createBlob({
          owner: this.owner,
          repo: this.repo,
          content: file.content,
          encoding: "utf-8",
        });
        return { path: file.path, sha: blob.data.sha };
      }),
    );

    // Create a tree with the new blobs.
    // Note: File deletions are not supported in the MVP. If the fix deletes
    // a file, it will be skipped (the repair workflow filters them out).
    const tree = await this.octokit.rest.git.createTree({
      owner: this.owner,
      repo: this.repo,
      base_tree: baseSha,
      tree: blobs.map((b) => ({
        path: b.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: b.sha,
      })),
    });

    // Create a commit.
    const commit = await this.octokit.rest.git.createCommit({
      owner: this.owner,
      repo: this.repo,
      message: opts.title,
      tree: tree.data.sha,
      parents: [baseSha],
    });

    // Create the fix branch pointing to the new commit.
    await this.octokit.rest.git.createRef({
      owner: this.owner,
      repo: this.repo,
      ref: `refs/heads/${opts.branch}`,
      sha: commit.data.sha,
    });

    // Open the PR.
    const pr = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      head: opts.branch,
      base: opts.base,
      title: opts.title,
      body: opts.body,
    });

    return {
      number: pr.data.number,
      url: pr.data.html_url,
    };
  }
}
