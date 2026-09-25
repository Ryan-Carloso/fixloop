import { describe, expect, it, vi } from "vitest";
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
import type { DiscordEvent, JobNotifier } from "../src/notify/discord.js";

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
    await vi.waitFor(() => {
      expect(store.get("job-1")!.status).toBe("RUNNING");
    });
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

  it("applies the patch on an idempotent same-status terminal re-entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new JobStore();
      store.create(makeJob("idem"));
      store.updateStatus("job-idem", "PR_CREATED");
      // A handler attaching the PR URL after the terminal transition is a
      // legitimate idempotent call: apply the patch instead of warning
      // about an "invalid transition" and silently dropping it.
      const updated = store.updateStatus("job-idem", "PR_CREATED", {
        prUrl: "https://github.com/o/r/pull/9",
      });
      expect(updated?.status).toBe("PR_CREATED");
      expect(updated?.prUrl).toBe("https://github.com/o/r/pull/9");
      const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).not.toContain("ignoring transition");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not claim the FAILED transition was ignored on a same-status re-entry", async () => {
    // A handler that reaches FAILED via update() and then throws: the
    // catch's FAILED update is a same-status idempotent re-entry, so the
    // note IS written — the "threw after reaching terminal status"
    // warning (which says the transition was ignored by the guard) must
    // not fire.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new JobStore();
      const handler: JobHandler = async (_job, update) => {
        update("FAILED", { note: "first failure" });
        throw new Error("boom-after-terminal");
      };
      const queue = new JobQueue(store, handler);
      queue.enqueue(makeJob("late-throw"));
      await vi.waitFor(() => {
        expect(store.get("job-late-throw")?.note).toContain(
          "boom-after-terminal",
        );
      });
      const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).not.toContain("threw after reaching terminal status");
    } finally {
      warn.mockRestore();
    }
  });
  it("runs up to `concurrency` jobs at once via overlapping pump() invocations", async () => {
    // pump() awaits each runOne() inside its own loop, so concurrency
    // comes from enqueue() firing one pump() per job: rapid enqueues
    // overlap and run together, bounded by the concurrency cap.
    const store = new JobStore();
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const handler: JobHandler = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight--;
    };
    const queue = new JobQueue(store, handler, 2);
    queue.enqueue(makeJob("c1"));
    queue.enqueue(makeJob("c2"));
    queue.enqueue(makeJob("c3"));
    await vi.waitFor(() => expect(maxInFlight).toBe(2));
    // The third job stays queued while two are active.
    expect(store.get("job-c3")!.status).toBe("QUEUED");
    releaseGate(); // unblock the handlers so stop() can quiesce
    await queue.stop();
  });

  it("ignores transitions out of terminal states", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new JobStore();
      store.create(makeJob("1"));
      store.updateStatus("job-1", "FAILED");
      expect(store.updateStatus("job-1", "RUNNING")).toBeUndefined();
      expect(store.get("job-1")!.status).toBe("FAILED");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("terminal"));
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps PR_CREATED when the handler throws afterwards (no contradictory FAILED)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new JobStore();
      const events: DiscordEvent["kind"][] = [];
      const notifier: JobNotifier = {
        notify: async (event) => {
          events.push(event.kind);
        },
      };
      const handler: JobHandler = async (_job, update) => {
        update("PR_CREATED", { prUrl: "https://github.com/o/r/pull/1" });
        throw new Error("boom after PR");
      };
      const queue = new JobQueue(store, handler, 1, notifier);
      queue.enqueue(makeJob("9"));
      await vi.waitFor(() => {
        expect(store.get("job-9")!.status).toBe("PR_CREATED");
      });
      const job = store.get("job-9")!;
      expect(job.prUrl).toBe("https://github.com/o/r/pull/1");
      // Exactly one pr_created notification; the late FAILED is ignored,
      // so no contradictory repair_failed goes out.
      expect(events.filter((k) => k === "pr_created")).toHaveLength(1);
      expect(events).not.toContain("repair_failed");
      // Dedup still blocks a replacement repair for the same issue.
      expect(store.findActiveByDedupKey(job.dedupKey)?.id).toBe("job-9");
    } finally {
      warn.mockRestore();
    }
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
    // Only the first job runs; the others wait.
    await vi.waitFor(() => {
      expect(events).toEqual(["start:job-1"]);
    });
    expect(maxConcurrent).toBe(1);

    resolvers.get("job-1")!();
    await vi.waitFor(() => {
      expect(events).toEqual(["start:job-1", "end:job-1", "start:job-2"]);
    });

    resolvers.get("job-2")!();
    await vi.waitFor(() => {
      expect(events).toContain("start:job-3");
    });
    resolvers.get("job-3")!();
    await vi.waitFor(() => {
      expect(events).toEqual([
        "start:job-1",
        "end:job-1",
      "start:job-2",
      "end:job-2",
      "start:job-3",
      "end:job-3",
    ]);
    });
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
    await vi.waitFor(() => {
      expect(calls).toBe(2);
      expect(store.get("job-1")!.status).toBe("FAILED");
    });
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
    await vi.waitFor(() => {
      expect(store.get("job-9")!.status).toBe("FAILED");
    });
    expect(store.get("job-9")!.note).toBe(
      "deploy failed: api_key=[REDACTED]",
    );
    expect(store.get("job-9")!.note).not.toContain("supersecret123");
  });

  it("sanitizes notes set explicitly by the handler, not just thrown errors", async () => {
    const store = new JobStore();
    const handler: JobHandler = async (_job, update) => {
      update("NEEDS_HUMAN_REVIEW", { note: "token=supersecret456" });
    };
    const queue = new JobQueue(store, handler);
    queue.enqueue(makeJob("9"));
    await vi.waitFor(() => {
      expect(store.get("job-9")!.status).toBe("NEEDS_HUMAN_REVIEW");
    });
    expect(store.get("job-9")!.note).toBe("token=[REDACTED]");
    expect(store.get("job-9")!.note).not.toContain("supersecret456");
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

describe("JobQueue.stop", () => {
  it("awaits the active handler so its final transition is stored", async () => {
    const store = new JobStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handler: JobHandler = async (_job, update) => {
      await gate;
      update("PR_CREATED", { prUrl: "https://example.com/pr/1" });
    };
    const queue = new JobQueue(store, handler);
    const job = makeJob("stop-1");
    queue.enqueue(job);
    await vi.waitFor(() => {
      expect(store.get(job.id)?.status).toBe("RUNNING");
    });
    let stopped = false;
    const stopping = queue.stop().then(() => {
      stopped = true;
    });
    await tick();
    // The handler is still gated: stop() must not have resolved yet.
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(store.get(job.id)?.status).toBe("PR_CREATED");
  });

  it("logs the sanitized error when the FAILED transition is ignored after a terminal state", async () => {
    const store = new JobStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handler: JobHandler = async (_job, update) => {
        update("PR_CREATED", { prUrl: "https://example.com/pr/1" });
        throw new Error("post-pr boom: password=hunter2");
      };
      const queue = new JobQueue(store, handler);
      queue.enqueue(makeJob("term-1"));
      await vi.waitFor(() => {
        expect(store.get("job-term-1")?.status).toBe("PR_CREATED");
      });
      const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).toContain("ignoring transition");
      expect(warnings).toContain("post-pr boom: password=[REDACTED]");
      expect(warnings).not.toContain("hunter2");
    } finally {
      warn.mockRestore();
    }
  });

  it("prevents new repairs from starting after stop()", async () => {
    const store = new JobStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started: string[] = [];
    const handler: JobHandler = async (job, _update) => {
      started.push(job.id);
      await gate;
    };
    const queue = new JobQueue(store, handler);
    const first = makeJob("stop-2a");
    const second = makeJob("stop-2b");
    queue.enqueue(first);
    queue.enqueue(second);
    await vi.waitFor(() => {
      expect(started).toEqual([first.id]);
    });
    const stopping = queue.stop();
    release();
    await stopping;
    await tick(50);
    // The active repair finished; the queued one never started and stays
    // QUEUED in the store (crash recovery handles it on next boot).
    expect(started).toEqual([first.id]);
    expect(store.get(second.id)?.status).toBe("QUEUED");
  });

  it("persists but does not accept enqueues after stop()", async () => {
    const store = new JobStore();
    const queue = new JobQueue(store, async () => {});
    await queue.stop();
    const job = makeJob("stop-3");
    const result = queue.enqueue(job);
    expect(result.accepted).toBe(false);
    expect(result.deduped).toBe(false);
    // Persisted so crash recovery picks it up on the next boot — but the
    // caller must not be told it was accepted, since no repair will start.
    expect(store.get(job.id)?.status).toBe("QUEUED");
  });
});

describe("JobStore.updateStatus note sanitization", () => {
  it("sanitizes notes inside updateStatus so direct callers can't leak secrets", () => {
    // The queue wrapper used to be the only sanitizer; any direct caller
    // (hydrate, future code) bypassed it and raw error text reached the
    // DB, the API, and Discord. The store is the single sink now.
    const store = new JobStore();
    const job = makeJob("sink-1");
    store.create(job);
    const updated = store.updateStatus(job.id, "RUNNING", {
      note: "boom: password=hunter2",
    });
    expect(updated?.note).toContain("password=[REDACTED]");
    expect(updated?.note).not.toContain("hunter2");
  });

  it("sanitizes the note in the terminal-guard warning for direct callers", () => {
    const store = new JobStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const job = makeJob("sink-2");
      store.create(job);
      store.updateStatus(job.id, "FAILED", { note: "done" });
      // Direct call bypassing the queue wrapper: the terminal guard must
      // still log a redacted note.
      const result = store.updateStatus(job.id, "RUNNING", {
        note: "late: password=hunter2",
      });
      expect(result).toBeUndefined();
      const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).toContain("ignoring transition");
      expect(warnings).toContain("password=[REDACTED]");
      expect(warnings).not.toContain("hunter2");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("JobQueue notification hygiene", () => {
  it("sanitizes third-party notifier rejection messages before logging", async () => {
    // JobNotifier is an injection point: a custom notifier may reject
    // with a secret-bearing message (connection string, token in URL).
    const store = new JobStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const leakyNotifier = {
        notify: async (): Promise<void> => {
          throw new Error("webhook failed: token=ghp_abcdefghij1234567890");
        },
      };
      const queue = new JobQueue(
        store,
        async (_job, update) => {
          update("RUNNING");
        },
        1,
        leakyNotifier,
      );
      queue.enqueue(makeJob("leaky-1"));
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("notification failed"),
        );
      });
      const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).toContain("notification failed");
      expect(warnings).not.toContain("ghp_abcdefghij1234567890");
    } finally {
      warn.mockRestore();
    }
  });

  it("notifies only on actual status changes, not repeat updates", async () => {
    // A handler calling update("RUNNING") twice (e.g. around an internal
    // retry) must not emit duplicate repair_started embeds.
    const store = new JobStore();
    const kinds: string[] = [];
    const notifier = {
      notify: async (event: { kind: string }): Promise<void> => {
        kinds.push(event.kind);
      },
    };
    const queue = new JobQueue(
      store,
      async (_job, update) => {
        update("RUNNING");
        update("RUNNING");
      },
      1,
      notifier,
    );
    queue.enqueue(makeJob("dup-1"));
    await vi.waitFor(() => {
      expect(kinds.filter((k) => k === "repair_started")).toHaveLength(1);
    });
  });

  it("logs the error stack when a handler throws after a terminal state", async () => {
    // The FAILED transition is ignored by the terminal guard (which logs
    // the message via the note); without this, the stack — the part an
    // operator needs to diagnose a post-PR failure — is never logged.
    const store = new JobStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handler: JobHandler = async (_job, update) => {
        update("PR_CREATED", { prUrl: "https://example.com/pr/1" });
        const err = new Error("post-pr boom");
        err.stack = "Error: post-pr boom\n    at diagnosis-marker";
        throw err;
      };
      const queue = new JobQueue(store, handler);
      queue.enqueue(makeJob("termstack-1"));
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("at diagnosis-marker"),
        );
      });
      const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).toContain("at diagnosis-marker");
    } finally {
      warn.mockRestore();
    }
  });

  it("hands custom notifiers only the narrow job reference", async () => {
    // JobNotifier is a public interface: custom implementations are
    // third-party code. The full Job carries raw errorContext (which may
    // hold unredacted secrets), but the declared event type promises only
    // the four identifier fields — so hand over exactly those.
    const store = new JobStore();
    const events: DiscordEvent[] = [];
    const notifier: JobNotifier = {
      notify: async (event) => {
        events.push(event);
      },
    };
    const handler: JobHandler = async (_job, update) => {
      update("RUNNING");
      update("FAILED", { note: "boom" });
    };
    const queue = new JobQueue(store, handler, 1, notifier);
    queue.enqueue(makeJob("narrow-1"));
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThan(0);
    });
    for (const event of events) {
      expect(Object.keys(event.job).sort()).toEqual([
        "id",
        "issueId",
        "provider",
        "repository",
      ]);
    }
    expect(events[0].job).toMatchObject({
      id: "job-narrow-1",
      issueId: "narrow-1",
      provider: "bugsink",
      repository: "my-app",
    });
  });
});
