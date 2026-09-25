import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  PostgresJobStore,
  loadSchemaSql,
  rowToJob,
  type DbClient,
} from "../src/db/postgres.js";
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
    const mapped = rowToJob(jobRow(job));
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
    const mapped = rowToJob({
      ...jobRow(makeJob()),
      note: null,
      pr_url: null,
      created_at: new Date("2026-09-25T10:00:00.000Z"),
      updated_at: new Date("2026-09-25T10:05:00.000Z"),
    });
    expect(mapped.note).toBeUndefined();
    expect(mapped.prUrl).toBeUndefined();
    expect(mapped.createdAt).toBe("2026-09-25T10:00:00.000Z");
    expect(mapped.updatedAt).toBe("2026-09-25T10:05:00.000Z");
  });
});

describe("PostgresJobStore persistence", () => {
  /** Lets the fire-and-forget write-behind chain settle. */
  function flushWriteBehind(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10));
  }

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

  it("preserves active-job deduplication across restarts", async () => {
    const { client, rowsQueue } = mockDb();
    const key = dedupKey("bugsnink", "demo/repo", "ISSUE-9");
    rowsQueue.push([
      jobRow(makeJob({ dedupKey: key, status: "FAILED" })),
      jobRow(makeJob({ dedupKey: key, status: "VERIFYING" })),
    ]);
    const store = await PostgresJobStore.connect(
      "postgres://localhost:5432/fixloop",
      client,
    );
    expect(store.findActiveByDedupKey(key)?.status).toBe("VERIFYING");
    expect(store.findActiveByDedupKey("bugsnink:other:1")).toBeUndefined();
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
    const app = buildServer({ store });

    const listRes = await app.inject({ method: "GET", url: "/jobs" });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toMatchObject([{ id: job.id, status: "FAILED" }]);

    const getRes = await app.inject({ method: "GET", url: `/jobs/${job.id}` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toMatchObject({ id: job.id });
  });
});
