import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  JobQueue,
  JobStore,
  dedupKey,
  type Job,
  type JobHandler,
  type JobStatus,
} from "../src/jobs/jobs.js";
import type { ErrorContext } from "../src/providers/error-provider.js";

function sampleCtx(issue: string): ErrorContext {
  return {
    provider: "bugsink",
    issueId: issue,
    project: "my-app",
    exception: { type: "ValueError", message: "bad" },
  };
}

function makeJob(issue: string, repo = "my-app"): Job {
  const now = new Date().toISOString();
  return {
    id: `job-${issue}`,
    dedupKey: dedupKey("bugsink", repo, issue),
    provider: "bugsink",
    repository: repo,
    issueId: issue,
    status: "QUEUED",
    errorContext: sampleCtx(issue),
    createdAt: now,
    updatedAt: now,
  };
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

describe("dedupKey", () => {
  it("combines provider, repository and issue id", () => {
    expect(dedupKey("bugsink", "my-app", "abc")).toBe("bugsink:my-app:abc");
  });
});

describe("JobStore", () => {
  it("stores and retrieves jobs", () => {
    const store = new JobStore();
    const job = makeJob("1");
    store.create(job);
    expect(store.get("job-1")).toEqual(job);
    expect(store.get("missing")).toBeUndefined();
  });

  it("lists jobs newest-first", () => {
    const store = new JobStore();
    const older = { ...makeJob("1"), createdAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...makeJob("2"), createdAt: "2026-01-02T00:00:00.000Z" };
    store.create(older);
    store.create(newer);
    const ids = store.list().map((j) => j.id);
    expect(ids).toEqual(["job-2", "job-1"]);
  });

  it("filters by status when one is given", () => {
    const store = new JobStore();
    store.create({ ...makeJob("1"), status: "FAILED" });
    store.create({ ...makeJob("2"), status: "QUEUED" });
    expect(store.list("FAILED").map((j) => j.id)).toEqual(["job-1"]);
    expect(store.list("QUEUED").map((j) => j.id)).toEqual(["job-2"]);
    expect(store.list()).toHaveLength(2);
  });

  it("updateStatus changes status and bumps updatedAt", async () => {
    const store = new JobStore();
    const job = makeJob("1");
    store.create(job);
    await tick(2);
    store.updateStatus("job-1", "RUNNING");
    const updated = store.get("job-1")!;
    expect(updated.status).toBe("RUNNING");
    expect(updated.updatedAt >= job.updatedAt).toBe(true);
  });

  it.each([
    ["QUEUED", true],
    ["RUNNING", true],
    ["REPRODUCING", true],
    ["FIXING", true],
    ["VERIFYING", true],
    ["PR_CREATED", true],
    ["NEEDS_HUMAN_REVIEW", false],
    ["FAILED", false],
    ["TIMED_OUT", false],
  ] as Array<[JobStatus, boolean]>)(
    "findActiveByDedupKey treats %s as %s",
    (status, expected) => {
      const store = new JobStore();
      const job = makeJob("1");
      store.create(job);
      store.updateStatus("job-1", status);
      const found = store.findActiveByDedupKey(job.dedupKey);
      expect(found !== undefined).toBe(expected);
    },
  );
});

describe("JobQueue", () => {
  it("accepts a new job and starts it right away", async () => {
    const store = new JobStore();
    const queue = new JobQueue(store, async () => {});
    const res = queue.enqueue(makeJob("1"));
    expect(res.accepted).toBe(true);
    expect(res.deduped).toBe(false);
    expect(res.job.id).toBe("job-1");
    // The in-process worker picks the job up synchronously on enqueue.
    await tick();
    expect(store.get("job-1")!.status).toBe("RUNNING");
  });

  it("deduplicates while an active job exists for the same key", async () => {
    const store = new JobStore();
    const queue = new JobQueue(store, async () => {});
    const first = queue.enqueue(makeJob("1"));
    const second = queue.enqueue(makeJob("1"));
    expect(second.accepted).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(store.list()).toHaveLength(1);
  });

  it("accepts a new job after the previous one reached a terminal state", async () => {
    const store = new JobStore();
    const queue = new JobQueue(store, async () => {});
    queue.enqueue(makeJob("1"));
    store.updateStatus("job-1", "FAILED");
    const res = queue.enqueue({ ...makeJob("1"), id: "job-1b" });
    expect(res.accepted).toBe(true);
    expect(res.job.id).toBe("job-1b");
  });

  it("processes jobs one at a time, in FIFO order", async () => {
    const store = new JobStore();
    const events: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const resolvers = new Map<string, () => void>();
    const handler: JobHandler = async (job) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      events.push(`start:${job.id}`);
      await new Promise<void>((r) => resolvers.set(job.id, r));
      events.push(`end:${job.id}`);
      concurrent--;
    };
    const queue = new JobQueue(store, handler);

    queue.enqueue(makeJob("1"));
    queue.enqueue(makeJob("2"));
    queue.enqueue(makeJob("3"));
    await tick(50);

    // Only the first job runs; the others wait.
    expect(events).toEqual(["start:job-1"]);
    expect(maxConcurrent).toBe(1);

    resolvers.get("job-1")!();
    await tick(50);
    expect(events).toEqual(["start:job-1", "end:job-1", "start:job-2"]);

    resolvers.get("job-2")!();
    await tick(50);
    resolvers.get("job-3")!();
    await tick(50);
    expect(events).toEqual([
      "start:job-1",
      "end:job-1",
      "start:job-2",
      "end:job-2",
      "start:job-3",
      "end:job-3",
    ]);
    expect(maxConcurrent).toBe(1);
  });

  it("marks the job FAILED when the handler throws, and keeps processing", async () => {
    const store = new JobStore();
    let calls = 0;
    const handler: JobHandler = async (job) => {
      calls++;
      if (job.id === "job-1") throw new Error("boom");
    };
    const queue = new JobQueue(store, handler);
    queue.enqueue(makeJob("1"));
    queue.enqueue(makeJob("2"));
    await tick(50);
    expect(store.get("job-1")!.status).toBe("FAILED");
    expect(store.get("job-1")!.note).toMatch(/boom/);
    expect(calls).toBe(2);
    expect(store.get("job-2")!.status).toBe("RUNNING");
  });

  it("sanitizes secrets out of the FAILED note at capture", async () => {
    const store = new JobStore();
    const handler: JobHandler = async () => {
      throw new Error("deploy failed: api_key=supersecret123");
    };
    const queue = new JobQueue(store, handler);
    queue.enqueue(makeJob("9"));
    await tick(50);
    expect(store.get("job-9")!.status).toBe("FAILED");
    expect(store.get("job-9")!.note).toBe(
      "deploy failed: api_key=[REDACTED]",
    );
    expect(store.get("job-9")!.note).not.toContain("supersecret123");
  });

  it("different issues do not deduplicate each other", () => {
    const store = new JobStore();
    const queue = new JobQueue(store, async () => {});
    expect(queue.enqueue(makeJob("1")).accepted).toBe(true);
    expect(queue.enqueue(makeJob("2")).accepted).toBe(true);
    expect(store.list()).toHaveLength(2);
  });
});

describe("ACTIVE_STATUSES", () => {
  it("covers every non-terminal status", () => {
    const terminal: JobStatus[] = ["NEEDS_HUMAN_REVIEW", "FAILED", "TIMED_OUT"];
    for (const s of terminal) expect(ACTIVE_STATUSES.has(s)).toBe(false);
    expect(ACTIVE_STATUSES.has("QUEUED")).toBe(true);
    expect(ACTIVE_STATUSES.has("PR_CREATED")).toBe(true);
  });
});
