import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  PostgresJobStore,
  HYDRATE_ROW_LIMIT,
  loadSchemaSql,
  makePool,
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

// Mock pg.Pool so connect() can be exercised without a database when no
// DbClient is injected. All other tests inject a fake DbClient, so the
// mock only affects the pool-construction test below.
const pgControl = vi.hoisted(() => {
  const query = vi.fn(async () => ({ rows: [] as Record<string, unknown>[] }));
  const end = vi.fn(async () => {});
  // The fake pool only needs the DbClient surface plus .on, which
  // makePool() calls to attach the idle-client error listener.
  const on = vi.fn((_event: string, _handler: (err: Error) => void) => {});
  // Fake dedicated lock client (pg.PoolClient surface: query + release).
  const lockQuery = vi.fn(
    async () => ({ rows: [{ acquired: true }] }) as {
      rows: Record<string, unknown>[];
    },
  );
  const lockRelease = vi.fn(() => {});
  const poolConnect = vi.fn(async () => ({
    query: lockQuery,
    release: lockRelease,
  }));
  const Pool = vi.fn((_config: unknown) => ({
    query,
    end,
    on,
    connect: poolConnect,
  }));
  return { query, end, Pool, on, poolConnect, lockQuery, lockRelease };
});

vi.mock("pg", () => ({
  default: { Pool: pgControl.Pool },
}));
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

  it("preserves unknown error_context keys on hydration", async () => {
    // Future providers may add fields beyond the schema; they must survive
    // a restart instead of being silently stripped by validation.
    const { client, rowsQueue } = mockDb();
    const job = makeJob({ status: "FAILED" });
    rowsQueue.push([
      {
        ...jobRow(job),
        error_context: { ...job.errorContext, futureField: "kept" },
      },
    ]);
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    expect(
      (store.get(job.id)?.errorContext as Record<string, unknown>)
        .futureField,
    ).toBe("kept");
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

describe("PostgresJobStore.connect pool cleanup", () => {
  it("builds the pool with a bounded connection timeout", async () => {
    // pg waits forever on connect by default; a black-holed DATABASE_URL
    // must fail fast instead of hanging boot.
    pgControl.Pool.mockClear();
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
    );
    expect(store).toBeInstanceOf(PostgresJobStore);
    expect(pgControl.Pool).toHaveBeenCalledWith(
      expect.objectContaining({ connectionTimeoutMillis: 5000 }),
    );
  });

  it("ends the pool (best-effort) when schema application fails", async () => {
    const { query } = mockDb();
    const end = vi.fn(async () => {});
    const client: DbClient = { query, end };
    query
      .mockResolvedValueOnce({ rows: [] }) // connectivity probe ok
      .mockRejectedValueOnce(
        new Error("permission denied for schema public"),
      ); // schema fails
    await expect(
      PostgresJobStore.connect("postgres://localhost:5432/fixloop", client),
    ).rejects.toThrow(/permission denied/);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("ends the pool (best-effort) when hydration fails", async () => {
    const { query } = mockDb();
    const end = vi.fn(async () => {});
    const client: DbClient = { query, end };
    query
      .mockResolvedValueOnce({ rows: [] }) // probe ok
      .mockResolvedValueOnce({ rows: [] }) // schema ok
      .mockRejectedValueOnce(new Error("boom")); // hydration SELECT fails
    await expect(
      PostgresJobStore.connect("postgres://localhost:5432/fixloop", client),
    ).rejects.toThrow(/boom/);
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("PostgresJobStore shutdown observability", () => {
  it("warns when the shutdown flush times out with writes pending", async () => {
    const query = vi.fn(async (text: string) => {
      if (
        text.includes("SELECT 1") ||
        text.includes("CREATE TABLE") ||
        text.includes("FROM fixloop_jobs")
      ) {
        return { rows: [] as Record<string, unknown>[] };
      }
      return new Promise<never>(() => {}); // UPSERT hangs: flush() never drains
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = await PostgresJobStore.connect(
        "postgres://localhost:5432/fixloop",
        { query } as DbClient,
      );
      store.create(makeJob());
      await store.close(20);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("timed out"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and does not hang when pool teardown stalls", async () => {
    const { client } = mockDb();
    const hangingEnd = {
      ...client,
      end: () => new Promise<void>(() => {}), // end() never resolves
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = await PostgresJobStore.connect(
        "postgres://localhost:5432/fixloop",
        hangingEnd,
      );
      await store.close(20);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("pool teardown timed out"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a summary of skipped corrupt rows during hydration", async () => {
    const { client, rowsQueue } = mockDb();
    rowsQueue.push([
      { id: "bad-1", status: "BOGUS", error_context: {} },
      { id: "bad-2", status: "QUEUED", error_context: "not-an-object" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await PostgresJobStore.connect(
        "postgres://localhost:5432/fixloop",
        client,
      );
      const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain("skipped 2 corrupt row(s)");
      expect(messages).toContain("DELETE FROM fixloop_jobs");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("makePool", () => {
  it("attaches an idle-client error listener to the pool", () => {
    makePool("postgres://localhost:5432/fixloop");
    // Without this listener, node-postgres throws an unhandled 'error'
    // event and the process exits on idle-client connection failures.
    expect(pgControl.on).toHaveBeenCalledWith("error", expect.any(Function));
  });
});

describe("PostgresJobStore restart notifications", () => {
  it("notifies repair_failed for jobs orphaned by a restart", async () => {
    const { client, rowsQueue } = mockDb();
    const orphan = makeJob({ status: "RUNNING" });
    rowsQueue.push([jobRow(orphan)]);
    const notify = vi.fn(async () => {});
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
      { notify },
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "repair_failed",
        reason: "interrupted by server restart",
      }),
    );
    // The job still goes through crash recovery as before.
    expect(store.get(orphan.id)?.status).toBe("FAILED");
    expect(store.get(orphan.id)?.note).toBe("interrupted by server restart");
  });

  it("does not fail hydration when the restart notifier throws", async () => {
    const { client, rowsQueue } = mockDb();
    rowsQueue.push([jobRow(makeJob({ status: "RUNNING" }))]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = await PostgresJobStore.connect(
        "postgres://localhost:5432/fixloop",
        client,
        {
          notify: async () => {
            throw new Error("discord down");
          },
        },
      );
      expect(store).toBeInstanceOf(PostgresJobStore);
      // The fire-and-forget guard caught the throw and warned.
      await new Promise((r) => setTimeout(r, 10));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("notification failed"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("PostgresJobStore hydration cap", () => {
  it("never hydrates more than HYDRATE_ROW_LIMIT rows", async () => {
    const { client, rowsQueue } = mockDb();
    // QUEUED rows also exercise crash recovery on the capped set.
    rowsQueue.push(
      Array.from({ length: HYDRATE_ROW_LIMIT + 5 }, () =>
        jobRow(makeJob({ status: "QUEUED" })),
      ),
    );
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    expect(store.list()).toHaveLength(HYDRATE_ROW_LIMIT);
  });
});

describe("PostgresJobStore single-instance advisory lock", () => {
  it("takes the advisory lock on a dedicated client when using a real pool", async () => {
    await PostgresJobStore.connect("postgres://localhost:5432/fixloop");
    expect(pgControl.poolConnect).toHaveBeenCalled();
    expect(pgControl.lockQuery).toHaveBeenCalledWith(
      expect.stringContaining("pg_try_advisory_lock"),
      [expect.any(Number)],
    );
  });

  it("refuses to start when the advisory lock is held", async () => {
    pgControl.lockQuery.mockResolvedValueOnce({ rows: [{ acquired: false }] });
    await expect(
      PostgresJobStore.connect("postgres://localhost:5432/fixloop"),
    ).rejects.toThrow(
      "another instance is already using this Postgres database",
    );
    // Best-effort cleanup: the lock client is released and the pool ended.
    expect(pgControl.lockRelease).toHaveBeenCalled();
    expect(pgControl.end).toHaveBeenCalled();
  });

  it("releases the advisory lock on close()", async () => {
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
    );
    await store.close();
    expect(pgControl.lockQuery).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_unlock"),
      [expect.any(Number)],
    );
    expect(pgControl.lockRelease).toHaveBeenCalled();
  });

  it("skips the lock entirely for injected DbClients", async () => {
    const { client } = mockDb();
    pgControl.poolConnect.mockClear();
    await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    expect(pgControl.poolConnect).not.toHaveBeenCalled();
  });
});
