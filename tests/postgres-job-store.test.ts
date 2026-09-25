import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  PostgresJobStore,
  loadSchemaSql,
  rowToJob,
  type DbClient,
} from "../src/db/postgres.js";

// Lets one test simulate a missing dist/db/schema.sql (packaging bug)
// without touching the real filesystem.
const schemaReadControl = vi.hoisted(() => ({ fail: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realRead = actual.readFileSync as (
    p: string | URL,
    o?: unknown,
  ) => string;
  return {
    ...actual,
    readFileSync: ((p: string | URL, o?: unknown) => {
      if (schemaReadControl.fail) {
        throw new Error("ENOENT: no such file or directory, open 'schema.sql'");
      }
      return realRead(p, o);
    }) as typeof actual.readFileSync,
  };
});
import { buildServer } from "../src/server.js";
import {
  dedupKey,
  newJobId,
  type Job,
} from "../src/jobs/jobs.js";

/** Minimal in-memory fake of the DbClient surface (pg.Pool satisfies it). */
function mockDb() {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const rowsQueue: Array<Record<string, unknown>[]> = [];
  const query = vi.fn(
    async (
      text: string,
      params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }> => {
      queries.push({ text, params });
      // Only the hydration SELECT carries rows in these tests; the
      // connectivity probe and the schema application return none.
      if (!text.includes("FROM fixloop_jobs")) return { rows: [] };
      return { rows: rowsQueue.shift() ?? [] };
    },
  );
  const client: DbClient = { query };
  return { query, queries, rowsQueue, client };
}

/** Lets the fire-and-forget write-behind chain settle. */
function flushWriteBehind(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id: newJobId(),
    dedupKey: dedupKey("bugsnink", "demo/repo", "ISSUE-1"),
    provider: "bugsnink",
    repository: "demo/repo",
    issueId: "ISSUE-1",
    status: "QUEUED",
    // Real ErrorContext shape (no cast): fixtures must rot loudly if the
    // interface grows required fields.
    errorContext: {
      provider: "bugsnink",
      issueId: "ISSUE-1",
      project: "demo/repo",
      exception: { type: "Boom", message: "boom" },
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function jobRow(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    dedup_key: job.dedupKey,
    provider: job.provider,
    repository: job.repository,
    issue_id: job.issueId,
    status: job.status,
    error_context: job.errorContext,
    note: job.note ?? null,
    pr_url: job.prUrl ?? null,
    created_at: new Date(job.createdAt),
    updated_at: new Date(job.updatedAt),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  schemaReadControl.fail = false;
});

describe("loadSchemaSql", () => {
  it("matches src/db/schema.sql on disk", () => {
    const onDisk = readFileSync(
      new URL("../src/db/schema.sql", import.meta.url),
      "utf8",
    );
    expect(loadSchemaSql()).toBe(onDisk);
  });

  it("creates the fixloop_jobs table with the expected columns", () => {
    const schemaSql = loadSchemaSql();
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS fixloop_jobs");
    for (const column of [
      "id",
      "dedup_key",
      "provider",
      "repository",
      "issue_id",
      "status",
      "error_context",
      "note",
      "pr_url",
      "created_at",
      "updated_at",
    ]) {
      expect(schemaSql).toContain(column);
    }
  });

  it("is read lazily at connect() time, not at module import", async () => {
    // Regression test: the schema used to be read synchronously at module
    // import, hard-crashing zero-config deployments when dist/db/schema.sql
    // was missing. connect() must be the only reader.
    const { client } = mockDb();
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    expect(store).toBeInstanceOf(PostgresJobStore);
  });

  it("throws a clear error when the schema file is missing", async () => {
    const { client } = mockDb();
    schemaReadControl.fail = true;
    try {
      await expect(
        PostgresJobStore.connect("postgres://localhost:5432/fixloop", client),
      ).rejects.toThrow(/could not load the Postgres schema file/);
    } finally {
      schemaReadControl.fail = false;
    }
  });

  it("declares id as TEXT so any app-generated string id persists", () => {
    expect(loadSchemaSql()).toContain("id            TEXT PRIMARY KEY");
  });
});

describe("PostgresJobStore.connect", () => {
  it("fails fast with a clear error when Postgres is unreachable", async () => {
    const { client, query } = mockDb();
    query.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await expect(
      PostgresJobStore.connect("postgres://localhost:5432/fixloop", client),
    ).rejects.toThrow(/could not reach postgres/i);
  });

  it("surfaces pg AggregateError details instead of an empty message", async () => {
    const { client, query } = mockDb();
    const aggregate = new AggregateError(
      [Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })],
      "connection failed",
    );
    query.mockRejectedValueOnce(aggregate);
    await expect(
      PostgresJobStore.connect("postgres://localhost:5432/fixloop", client),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("applies the schema on boot", async () => {
    const { client, queries } = mockDb();
    await PostgresJobStore.connect("postgres://localhost:5432/fixloop", client);
    const schemaQuery = queries.find((q) =>
      q.text.includes("CREATE TABLE IF NOT EXISTS fixloop_jobs"),
    );
    expect(schemaQuery).toBeDefined();
  });

  it("ends the pool (best-effort) when the connectivity probe fails", async () => {
    const { query } = mockDb();
    const end = vi.fn(async () => {});
    const client: DbClient = { query, end };
    query.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await expect(
      PostgresJobStore.connect("postgres://localhost:5432/fixloop", client),
    ).rejects.toThrow(/could not reach postgres/i);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("still throws the clear error when pool end() itself fails", async () => {
    const { query } = mockDb();
    const end = vi.fn(async () => {
      throw new Error("already ended");
    });
    const client: DbClient = { query, end };
    query.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await expect(
      PostgresJobStore.connect("postgres://localhost:5432/fixloop", client),
    ).rejects.toThrow(/could not reach postgres/i);
  });

  it("hydrates existing jobs so history survives restarts", async () => {
    const { client, rowsQueue } = mockDb();
    const job = makeJob({ status: "FAILED", note: "fix did not verify" });
    rowsQueue.push([jobRow(job)]);
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    expect(store.get(job.id)).toMatchObject({
      id: job.id,
      status: "FAILED",
      note: "fix did not verify",
      provider: "bugsnink",
    });
  });
});

describe("rowToJob", () => {
  it("maps snake_case columns to the Job interface", () => {
    const job = makeJob({
      status: "NEEDS_HUMAN_REVIEW",
      note: "take a look",
      prUrl: "https://github.com/o/r/pull/42",
    });
    const mapped = rowToJob(jobRow(job), job.status, job.errorContext);
    expect(mapped).toEqual({
      id: job.id,
      dedupKey: job.dedupKey,
      provider: job.provider,
      repository: job.repository,
      issueId: job.issueId,
      status: "NEEDS_HUMAN_REVIEW",
      errorContext: job.errorContext,
      note: "take a look",
      prUrl: "https://github.com/o/r/pull/42",
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });

  it("turns null note/pr_url into undefined and Date timestamps into ISO strings", () => {
    const job = makeJob();
    const mapped = rowToJob(
      {
        ...jobRow(job),
        note: null,
        pr_url: null,
        created_at: new Date("2026-09-25T10:00:00.000Z"),
        updated_at: new Date("2026-09-25T10:05:00.000Z"),
      },
      job.status,
      job.errorContext,
    );
    expect(mapped.note).toBeUndefined();
    expect(mapped.prUrl).toBeUndefined();
    expect(mapped.createdAt).toBe("2026-09-25T10:00:00.000Z");
    expect(mapped.updatedAt).toBe("2026-09-25T10:05:00.000Z");
  });
});

describe("PostgresJobStore persistence", () => {
  it("create() writes the job with an INSERT using bound parameters", async () => {
    const { client, queries } = mockDb();
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    queries.length = 0;
    const job = makeJob({ note: "hello" });
    const created = store.create(job);
    await flushWriteBehind();

    expect(created).toBe(job);
    expect(store.get(job.id)).toBe(job);
    expect(queries).toHaveLength(1);
    const { text, params } = queries[0];
    expect(text).toContain("INSERT INTO fixloop_jobs");
    // Values travel as bound parameters, never interpolated into the SQL.
    expect(text).not.toContain(job.id);
    expect(params).toEqual([
      job.id,
      job.dedupKey,
      job.provider,
      job.repository,
      job.issueId,
      "QUEUED",
      JSON.stringify(job.errorContext),
      "hello",
      null,
      job.createdAt,
      job.updatedAt,
    ]);
  });

  it("updateStatus() upserts the new status and returns the updated job", async () => {
    const { client, queries } = mockDb();
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    const job = makeJob();
    store.create(job);
    await flushWriteBehind();
    queries.length = 0;

    const updated = store.updateStatus(job.id, "PR_CREATED", {
      prUrl: "https://github.com/o/r/pull/7",
    });
    await flushWriteBehind();

    expect(updated?.status).toBe("PR_CREATED");
    expect(updated?.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain("ON CONFLICT (id) DO UPDATE");
    expect(queries[0].params?.[5]).toBe("PR_CREATED");
    expect(queries[0].params?.[8]).toBe("https://github.com/o/r/pull/7");
  });

  it("updateStatus() on an unknown id returns undefined and writes nothing", async () => {
    const { client, queries } = mockDb();
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    queries.length = 0;
    expect(store.updateStatus("nope", "FAILED")).toBeUndefined();
    expect(queries).toHaveLength(0);
  });

  it("commits write-behind persists for the same job in dispatch order", async () => {
    // pg.Pool runs concurrent queries on separate connections with no
    // cross-connection commit ordering, so floating persists could commit
    // out of order and resurrect stale status after a restart. The store
    // must serialize persists per job id.
    const pending: Array<() => void> = [];
    const committed: string[] = [];
    const query = vi.fn(
      async (
        text: string,
        params?: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }> => {
        if (text.includes("INSERT INTO fixloop_jobs")) {
          // Gate every write so the test controls commit order.
          await new Promise<void>((resolve) => pending.push(resolve));
          committed.push(String(params?.[5]));
        }
        return { rows: [] };
      },
    );
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      { query },
    );
    const job = makeJob();
    store.create(job); // persist #1 (QUEUED)
    store.updateStatus(job.id, "FAILED"); // persist #2 (FAILED)

    // Release commits in reverse dispatch order; a correct per-id chain
    // still commits QUEUED before FAILED.
    for (let i = 0; i < 10 && committed.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      pending.splice(0).reverse().forEach((resolve) => resolve());
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(committed).toEqual(["QUEUED", "FAILED"]);
  });

  it("flush() waits for in-flight write-behind chains before resolving", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = vi.fn(
      async (
        text: string,
      ): Promise<{ rows: Record<string, unknown>[] }> => {
        if (text.includes("INSERT INTO fixloop_jobs")) await gate;
        return { rows: [] };
      },
    );
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      { query },
    );
    store.create(makeJob());
    await flushWriteBehind(); // let the write reach the gate

    let flushed = false;
    const flushing = store.flush().then(() => {
      flushed = true;
    });
    await flushWriteBehind();
    expect(flushed).toBe(false); // write still gated
    release();
    await flushing;
    expect(flushed).toBe(true);
  });

  it("close() flushes pending writes and ends the pool", async () => {
    const { query } = mockDb();
    const end = vi.fn(async () => {});
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      { query, end },
    );
    const job = makeJob();
    store.create(job);
    await store.close();
    expect(end).toHaveBeenCalledTimes(1);
    // The gated write committed before the pool closed.
    expect(
      query.mock.calls.some(
        ([text, params]) =>
          text.includes("INSERT INTO fixloop_jobs") &&
          (params as unknown[])[0] === job.id,
      ),
    ).toBe(true);
  });

  it("flush() drains writes enqueued while it is already flushing", async () => {
    // Regression: flush() must not snapshot the chains once — a transition
    // landing between the snapshot and db.end() would otherwise be lost.
    const order: string[] = [];
    const query = vi.fn(
      async (
        text: string,
        params?: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }> => {
        if (text.includes("INSERT INTO fixloop_jobs")) {
          const id = params?.[0] as string;
          order.push(`start:${id}`);
          await new Promise((r) => setTimeout(r, 20)); // slow write
          order.push(`end:${id}`);
        }
        return { rows: [] };
      },
    );
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      { query },
    );
    const job = makeJob();
    store.create(job);
    const flushing = store.flush(); // snapshot taken synchronously here
    store.updateStatus(job.id, "FAILED", { note: "late" }); // lands mid-flush
    await flushing;
    expect(order).toEqual([
      `start:${job.id}`,
      `end:${job.id}`,
      `start:${job.id}`,
      `end:${job.id}`,
    ]);
  });

  it("close() does not hang forever on a stuck write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = vi.fn(
      async (
        text: string,
      ): Promise<{ rows: Record<string, unknown>[] }> => {
        if (text.includes("INSERT INTO fixloop_jobs")) await gate;
        return { rows: [] };
      },
    );
    const end = vi.fn(async () => {});
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      { query, end },
    );
    store.create(makeJob());
    await flushWriteBehind(); // let the write reach the gate

    // The write never commits; close() must still resolve via its timeout
    // and end the pool instead of hanging shutdown.
    await store.close(50);
    expect(end).toHaveBeenCalledTimes(1);
    release();
  });

  it("keeps working (in-memory) when a write fails, and warns loudly", async () => {
    const { client, query } = mockDb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    query.mockRejectedValueOnce(new Error("disk is on fire"));
    const job = makeJob();

    const created = store.create(job);
    // Let the floating write-behind promise settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(created).toBe(job);
    expect(store.get(job.id)).toBe(job);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Postgres"),
      expect.any(Error),
    );
  });

  it("recovers jobs orphaned mid-repair as FAILED so they stop blocking dedup", async () => {
    // Crash recovery: a row stuck in a transient status (the process died
    // mid-repair) must not stay "active" forever, or findActiveByDedupKey
    // would silently drop every future repair for the same issue.
    const { client, rowsQueue, queries } = mockDb();
    const key = dedupKey("bugsnink", "demo/repo", "ISSUE-9");
    const orphaned = makeJob({ dedupKey: key, status: "VERIFYING" });
    rowsQueue.push([jobRow(orphaned)]);
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    await flushWriteBehind();

    expect(store.get(orphaned.id)).toMatchObject({
      status: "FAILED",
      note: "interrupted by server restart",
    });
    expect(store.findActiveByDedupKey(key)).toBeUndefined();
    // The correction is written back to Postgres, not just the Map.
    const correction = queries.find(
      (q) => q.params?.[0] === orphaned.id && q.params?.[5] === "FAILED",
    );
    expect(correction?.text).toContain("ON CONFLICT (id) DO UPDATE");
  });

  it("keeps PR_CREATED rows blocking dedup across restarts", async () => {
    // The fix PR exists on GitHub whether or not we restarted: re-repairing
    // would open a duplicate.
    const { client, rowsQueue } = mockDb();
    const key = dedupKey("bugsnink", "demo/repo", "ISSUE-9");
    rowsQueue.push([
      jobRow(
        makeJob({
          dedupKey: key,
          status: "PR_CREATED",
          prUrl: "https://github.com/o/r/pull/7",
        }),
      ),
    ]);
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    expect(store.findActiveByDedupKey(key)?.status).toBe("PR_CREATED");
  });

  it("skips rows with an invalid status instead of poisoning the store", async () => {    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client, rowsQueue } = mockDb();
      const good = makeJob({ status: "FAILED" });
      rowsQueue.push([
        jobRow(good),
        { ...jobRow(makeJob()), status: "bogus" },
      ]);
      const store = await PostgresJobStore.connect(
        "postgres://localhost:5432/fixloop",
        client,
      );
      expect(store.get(good.id)?.status).toBe("FAILED");
      expect(store.list()).toHaveLength(1); // the bogus row never hydrated
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid status"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("skips rows with a corrupt error_context instead of trusting the cast", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client, rowsQueue } = mockDb();
      const good = makeJob({ status: "FAILED" });
      rowsQueue.push([
        jobRow(good),
        { ...jobRow(makeJob()), error_context: { provider: 42 } },
      ]);
      const store = await PostgresJobStore.connect(
        "postgres://localhost:5432/fixloop",
        client,
      );
      expect(store.get(good.id)?.status).toBe("FAILED");
      expect(store.list()).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid error_context"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("lists newest-first from hydrated rows", async () => {
    const { client, rowsQueue } = mockDb();
    const older = makeJob({
      createdAt: "2026-09-24T10:00:00.000Z",
      updatedAt: "2026-09-24T10:00:00.000Z",
    });
    const newer = makeJob({
      createdAt: "2026-09-25T10:00:00.000Z",
      updatedAt: "2026-09-25T10:00:00.000Z",
    });
    rowsQueue.push([jobRow(older), jobRow(newer)]);
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    expect(store.list().map((j) => j.id)).toEqual([newer.id, older.id]);
  });
});

describe("PostgresJobStore with the HTTP layer", () => {
  it("serves hydrated jobs from GET /jobs and GET /jobs/:id", async () => {
    const { client, rowsQueue } = mockDb();
    const job = makeJob({ status: "FAILED" });
    rowsQueue.push([jobRow(job)]);
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    const app = buildServer({ store, webhookSecret: "test-secret" });
    const headers = { "x-fixloop-webhook-token": "test-secret" };

    const listRes = await app.inject({ method: "GET", url: "/jobs", headers });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toMatchObject([{ id: job.id, status: "FAILED" }]);

    const getRes = await app.inject({
      method: "GET",
      url: `/jobs/${job.id}`,
      headers,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toMatchObject({ id: job.id });
  });
});
