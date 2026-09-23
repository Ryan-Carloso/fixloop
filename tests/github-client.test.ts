import { describe, expect, it, vi, beforeEach } from "vitest";
import { GitHubClient } from "../src/github/client.js";

function mockOctokit() {
  return {
    rest: {
      git: {
        getRef: vi.fn(async () => ({
          data: { object: { sha: "abc123" } },
        })),
        createRef: vi.fn(async () => ({ data: {} })),
        createBlob: vi.fn(async () => ({ data: { sha: "blob123" } })),
        createTree: vi.fn(async () => ({ data: { sha: "tree123" } })),
        createCommit: vi.fn(async () => ({ data: { sha: "commit123" } })),
      },
      pulls: {
        create: vi.fn(async () => ({
          data: { number: 42, html_url: "https://github.com/o/r/pull/42" },
        })),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GitHubClient", () => {
  it("creates a branch with the fix and opens a PR", async () => {
    const octokit = mockOctokit();
    const client = new GitHubClient(octokit as never, "owner", "repo");
    const pr = await client.createFixPr({
      branch: "fix/issue-123",
      base: "main",
      title: "fix: add() uses subtraction",
      body: "Fixes #123\n\nRED → GREEN verified.",
      changedFiles: [
        { path: "src/math.js", content: "export function add(a,b){return a+b;}" },
      ],
    });
    expect(pr.number).toBe(42);
    expect(pr.url).toContain("pull/42");
    // Blob was created for the changed file.
    expect(octokit.rest.git.createBlob).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      content: expect.stringContaining("a+b"),
      encoding: "utf-8",
    });
    // Tree and commit were created.
    expect(octokit.rest.git.createTree).toHaveBeenCalled();
    expect(octokit.rest.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "fix: add() uses subtraction",
        parents: ["abc123"],
      }),
    );
    // Branch points to the new commit (not the base).
    expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "refs/heads/fix/issue-123",
      sha: "commit123",
    });
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      head: "fix/issue-123",
      base: "main",
      title: "fix: add() uses subtraction",
      body: expect.stringContaining("RED"),
    });
  });

  it("throws if there are no changed files", async () => {
    const octokit = mockOctokit();
    const client = new GitHubClient(octokit as never, "owner", "repo");
    await expect(
      client.createFixPr({
        branch: "fix/x",
        base: "main",
        title: "t",
        body: "b",
        changedFiles: [],
      }),
    ).rejects.toThrow(/no changed files/);
    expect(octokit.rest.git.createBlob).not.toHaveBeenCalled();
  });

  it("throws if the base branch does not exist", async () => {
    const octokit = mockOctokit();
    octokit.rest.git.getRef.mockRejectedValueOnce(new Error("Not Found"));
    const client = new GitHubClient(octokit as never, "owner", "repo");
    await expect(
      client.createFixPr({
        branch: "fix/x",
        base: "nonexistent",
        title: "t",
        body: "b",
        changedFiles: [{ path: "a.js", content: "x" }],
      }),
    ).rejects.toThrow(/Base branch/);
  });
});
