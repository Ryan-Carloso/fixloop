import { readFileSync } from "node:fs";
import pg from "pg";
import { JobStore, type Job, type JobStatus } from "../jobs/jobs.js";
import type { ErrorContext } from "../providers/error-provider.js";

/**
 * Loads src/db/schema.sql (copied next to dist/db/schema.sql by the
 * build). Read lazily at connect() time so zero-config deployments never
 * pay import-time I/O — and a missing file fails at connect with a clear
 * error instead of crashing the module load.
 */
export function loadSchemaSql(): string {
  try {
    return readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  } catch (err) {
    throw new Error(
      "FixLoop could not load the Postgres schema file (dist/db/schema.sql): " +
        `${err instanceof Error ? err.message : String(err)}. ` +
        "Was the package built correctly?",
    );
  }
}

/**
 * Minimal query surface the store needs. pg.Pool satisfies it, and tests
 * inject a mock instead of a real database.
 */
export interface DbClient {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  end?(): Promise<void>;
}

const SELECT_ALL = `
  SELECT id, dedup_key, provider, repository, issue_id, status,
         error_context, note, pr_url, created_at, updated_at
  FROM fixloop_jobs
`;

const UPSERT_JOB = `
  INSERT INTO fixloop_jobs
    (id, dedup_key, provider, repository, issue_id, status,
     error_context, note, pr_url, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    error_context = EXCLUDED.error_context,
    note = EXCLUDED.note,
    pr_url = EXCLUDED.pr_url,
    updated_at = EXCLUDED.updated_at
`;

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Human-readable summary of a pg failure. pg v8 surfaces connection
 * problems as an AggregateError with an empty top-level message, so we
 * dig into the aggregated errors instead of printing nothing.
 */
function dbErrorMessage(err: unknown): string {
  if (err instanceof AggregateError) {
    const parts = err.errors.map((e) => {
      if (e instanceof Error) {
        const code = (e as { code?: unknown }).code;
        return `${typeof code === "string" ? `[${code}] ` : ""}${e.message}`;
      }
      return String(e);
    });
    return parts.join("; ") || "connection failed";
  }
  return err instanceof Error ? err.message : String(err);
}

/** Maps a fixloop_jobs row to the Job interface. */
export function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    dedupKey: String(row.dedup_key),
    provider: String(row.provider),
    repository: String(row.repository),
    issueId: String(row.issue_id),
    status: row.status as JobStatus,
    errorContext: row.error_context as ErrorContext,
    note: row.note == null ? undefined : String(row.note),
    prUrl: row.pr_url == null ? undefined : String(row.pr_url),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function jobParams(job: Job): unknown[] {
  return [
    job.id,
    job.dedupKey,
    job.provider,
    job.repository,
    job.issueId,
    job.status,
    JSON.stringify(job.errorContext),
    job.note ?? null,
    job.prUrl ?? null,
    job.createdAt,
    job.updatedAt,
  ];
}

/**
 * Postgres-backed job store with the same synchronous interface as the
 * in-memory JobStore.
 *
 * Design: the in-memory Map stays the source of truth for reads (zero
 * changes to JobQueue and the HTTP layer), while every mutation is also
 * written through to Postgres. On boot, existing rows are hydrated into
 * the Map so history survives restarts.
 *
 * Write-behind failures are logged loudly but never break the repair
 * pipeline — the in-memory behavior is always preserved.
 */
export class PostgresJobStore extends JobStore {
  /**
   * Per-job write-behind chains. persist() is fire-and-forget, but rapid
   * transitions on the same job (RUNNING -> FAILED) must commit in
   * dispatch order: pg.Pool runs concurrent queries on separate
   * connections with no cross-connection commit ordering, so a stale
   * write committing last would resurrect old status after a restart.
   */
  private readonly persistChains = new Map<string, Promise<void>>();

  private constructor(private readonly db: DbClient) {
    super();
  }

  /**
   * Connects to Postgres, applies the schema, and hydrates existing jobs.
   * Throws a clear error when the database is unreachable (fail fast).
   * Pass a DbClient to inject a fake (tests) instead of opening a real pool.
   */
  static async connect(
    databaseUrl: string,
    db?: DbClient,
  ): Promise<PostgresJobStore> {
    const client: DbClient = db ?? new pg.Pool({ connectionString: databaseUrl });
    try {
      await client.query("SELECT 1");
    } catch (err) {
      // Best-effort cleanup: a failed probe with a real pg.Pool leaves
      // sockets and retry timers behind otherwise.
      await client.end?.().catch(() => {});
      throw new Error(
        `FixLoop could not reach Postgres (DATABASE_URL): ${dbErrorMessage(err)}. ` +
          "Is Postgres running and is DATABASE_URL correct?",
      );
    }
    await client.query(loadSchemaSql());
    const store = new PostgresJobStore(client);
    await store.hydrate();
    return store;
  }

  private async hydrate(): Promise<void> {
    const { rows } = await this.db.query(SELECT_ALL);
    for (const row of rows) {
      // Bypass the write-behind: these rows are already in Postgres.
      super.create(rowToJob(row));
    }
  }

  override create(job: Job): Job {
    const created = super.create(job);
    this.writeBehind(job);
    return created;
  }

  override updateStatus(
    id: string,
    status: JobStatus,
    patch?: Partial<Job>,
  ): Job | undefined {
    const updated = super.updateStatus(id, status, patch);
    if (updated) this.writeBehind(updated);
    return updated;
  }

  /**
   * Fire-and-forget persist, serialized per job id in dispatch order.
   * Each write awaits the previous one for the same job before issuing
   * its query, so commits land in the order the transitions happened.
   */
  private writeBehind(job: Job): void {
    // Snapshot the params now: the queue mutates the job object in place,
    // and the chained write runs later, so capturing by reference would
    // persist a newer transition's state in this transition's slot.
    const params = jobParams(job);
    const id = job.id;
    const tail = this.persistChains.get(id) ?? Promise.resolve();
    const next = tail.then(() => this.persist(id, params));
    this.persistChains.set(id, next);
    // persist() never rejects (failures are logged), but defend the chain
    // anyway; drop the finished tail so the map cannot grow without bound.
    void next.catch(() => {}).then(() => {
      if (this.persistChains.get(id) === next) {
        this.persistChains.delete(id);
      }
    });
  }

  private async persist(id: string, params: unknown[]): Promise<void> {
    try {
      await this.db.query(UPSERT_JOB, params);
    } catch (err) {
      console.warn(
        `Postgres job store: failed to persist job ${id}; continuing in-memory.`,
        err,
      );
    }
  }
}
