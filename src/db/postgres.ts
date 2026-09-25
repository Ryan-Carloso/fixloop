import { readFileSync } from "node:fs";
import pg from "pg";
import { JobStore, isJobStatus, type Job, type JobStatus } from "../jobs/jobs.js";
import type { JobNotifier } from "../notify/discord.js";
import {
  errorContextSchema,
  type ErrorContext,
} from "../providers/error-provider.js";
import { sanitizeForPr } from "../redact.js";

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

/**
 * Builds the production pg.Pool. Extracted so tests can assert on the
 * pool's wiring (notably the idle-client 'error' listener) without
 * connecting anywhere — the pool is lazy until the first query.
 */
export function makePool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  // node-postgres emits idle-client connection failures (Postgres
  // restart, network blip, firewall idle timeout) as 'error' events on
  // the pool — not as query rejections, so persist()'s try/catch never
  // sees them. Without a listener, Node throws an unhandled 'error'
  // event and the process exits: a transient DB hiccup between repairs
  // would take down the whole API server.
  pool.on("error", (err: Error) => {
    console.warn(
      `Postgres job store: idle client connection error: ${err.message}`,
    );
  });
  return pool;
}

/** Dedicated lock client: query + release (pg.PoolClient satisfies it). */
export interface LockClient {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  /**
   * Release the client back to the pool. A truthy error destroys the
   * connection instead — used when the unlock query is still in flight
   * at release time (pg.PoolClient.release(err) semantics).
   */
  release(err?: unknown): void;
}

/**
 * Upper bound for rows loaded by hydrate(). History grows without
 * bound, so boot must not materialize the whole table into the
 * in-memory Map. Newest-first: the rows most likely to be queried or
 * recovered. (Old transient rows beyond the window miss crash
 * recovery, but dedup is in-memory, so nothing deadlocks — they are
 * simply invisible. Proper retention/pruning is a follow-up; see the
 * README's MVP limitations.)
 */
export const HYDRATE_ROW_LIMIT = 1000;

/**
 * Bound for concurrent crash-recovery Discord notifications (see
 * notifyRecovery): a crash with many in-flight repairs must not burst
 * one webhook POST per orphaned row.
 */
const RECOVERY_NOTIFY_CONCURRENCY = 3;

const SELECT_ALL = `
  SELECT id, dedup_key, provider, repository, issue_id, status,
         error_context, note, pr_url, created_at, updated_at
  FROM fixloop_jobs
  -- id as tiebreaker: created_at comes from Date.toISOString()
  -- (millisecond precision), so a burst of webhook deliveries can tie.
  -- Without it, which rows fall beyond the LIMIT window is
  -- nondeterministic across boots.
  ORDER BY created_at DESC, id DESC
  LIMIT ${HYDRATE_ROW_LIMIT + 1}
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

/**
 * Statuses describing work that can never survive a restart: the process
 * died mid-repair, so whatever they describe is gone. PR_CREATED is
 * deliberately excluded — the fix PR exists on GitHub whether or not we
 * restarted, so the row keeps blocking duplicate repairs.
 */
const CRASHED_STATUSES: ReadonlySet<JobStatus> = new Set([
  "QUEUED",
  "RUNNING",
  "REPRODUCING",
  "FIXING",
  "VERIFYING",
]);

/** Upper bound for the write-behind flush during shutdown. */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

/** Bound for releasing the instance advisory lock on the way out. */
const LOCK_RELEASE_TIMEOUT_MS = 2_000;

/**
 * Advisory-lock key claiming a Postgres database for one FixLoop
 * instance. Crash recovery rewrites every transient row on boot, so two
 * processes sharing one DATABASE_URL corrupt each other — the lock
 * makes the second boot fail fast instead.
 */
const ADVISORY_LOCK_KEY = 2_026_092_501;

/**
 * Races a promise against a timeout, clearing the timer when the race
 * settles. A bare setTimeout left behind by Promise.race keeps the event
 * loop alive for the full timeout even after the winner is known (slows
 * vitest teardown and, for library users, delays process exit).
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Note recorded when a restart orphans a mid-repair job. */
const RESTART_NOTE = "interrupted by server restart";

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

/**
 * Maps a raw Postgres row to a Job. Status and errorContext must already
 * be validated by the caller (see hydrate); they are passed in so this
 * function never casts database content.
 */
export function rowToJob(
  row: Record<string, unknown>,
  status: JobStatus,
  errorContext: ErrorContext,
): Job {
  return {
    id: String(row.id),
    dedupKey: String(row.dedup_key),
    provider: String(row.provider),
    repository: String(row.repository),
    issueId: String(row.issue_id),
    status,
    errorContext,
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
 *
 * Redaction boundary: free-text failure notes are sanitized with
 * sanitizeForPr at capture (JobQueue.runOne), so every sink stays
 * redacted. errorContext is retained verbatim as structured diagnostics —
 * it is served by GET /jobs*, which require the pre-shared webhook token
 * (see checkAuth in server.ts); never expose those endpoints without auth.
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

  private constructor(
    private readonly db: DbClient,
    private readonly releaseLock: () => Promise<void>,
  ) {
    super();
  }

  /**
   * Builds the store over an explicit client (tests) or a real pg.Pool
   * (production), probes the connection, applies the schema, and hydrates
   * persisted jobs into memory.
   *
   * `notifier` (optional) receives a `repair_failed` event for every job
   * orphaned by a restart — crash recovery flips those rows directly in
   * the store, bypassing the queue's notifyTransition, so without this
   * the one lifecycle failure the notifier exists for would stay silent.
   * Notifications are fire-and-forget: a broken notifier must never
   * break hydration or boot.
   */
  static async connect(
    databaseUrl: string,
    db?: DbClient,
    notifier?: JobNotifier,
  ): Promise<PostgresJobStore> {
    // Bound the connect phase: pg waits forever by default
    // (connectionTimeoutMillis: 0), which would hang boot on a black-holed
    // host instead of failing fast with the clear error below.
    // Only a real pool takes the single-instance advisory lock: injected
    // DbClients are test doubles, and the lock is a production Postgres
    // feature.
    let pool: pg.Pool | undefined;
    let client: DbClient;
    if (db) {
      client = db;
    } else {
      pool = makePool(databaseUrl);
      client = pool;
    }
    // Dedicated client holding the advisory lock for the process
    // lifetime (see below). A pooled session cannot hold it reliably:
    // the pool may close idle connections, silently releasing the lock.
    let lockClient: LockClient | undefined;
    const releaseLock = async (): Promise<void> => {
      if (!lockClient) return;
      const lock = lockClient;
      lockClient = undefined;
      const outcome = await raceWithTimeout(
        lock
          .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
          .then(
            () => "unlocked" as const,
            () => "failed" as const,
          ),
        LOCK_RELEASE_TIMEOUT_MS,
        () => "timeout" as const,
      );
      // If the unlock query was still in flight when the timeout won the
      // race, the connection may be mid-query: destroy it instead of
      // returning it to the pool, where a new caller could receive the
      // late unlock result. pg destroys the client when release() gets a
      // truthy error.
      lock.release(
        outcome === "timeout"
          ? new Error("advisory lock unlock timed out; destroying the client")
          : undefined,
      );
    };
    try {
      await client.query("SELECT 1");
    } catch (err) {
      // Best-effort cleanup: a failed probe with a real pg.Pool leaves
      // sockets and retry timers behind otherwise. Only the pool this
      // module created is ended — a caller-injected DbClient is owned by
      // the caller and must not be closed out from under them.
      await pool?.end?.().catch(() => {});
      throw new Error(
        `FixLoop could not reach Postgres (DATABASE_URL): ${dbErrorMessage(err)}. ` +
          "Is Postgres running and is DATABASE_URL correct?",
      );
    }
    const store = new PostgresJobStore(client, releaseLock);
    try {
      if (pool) {
        // Single-instance guard: crash recovery rewrites every transient
        // row on boot, so two processes sharing one DATABASE_URL corrupt
        // each other — the second boot would mark the first instance's
        // live jobs FAILED and free their dedup keys. The lock is taken
        // BEFORE the schema/DDL below: concurrent CREATE TABLE IF NOT
        // EXISTS can intermittently fail with a unique-violation on the
        // pg catalogs (a known Postgres DDL race), and the drift check
        // must not run on two boots at once either. Take a
        // session-level advisory lock on a dedicated client and hold it
        // until close(); Postgres releases it automatically if this
        // process dies, so a crashed instance never blocks a restart.
        lockClient = await pool.connect();
        const { rows } = await lockClient.query(
          "SELECT pg_try_advisory_lock($1) AS acquired",
          [ADVISORY_LOCK_KEY],
        );
        if (rows[0]?.acquired !== true) {
          throw new Error(
            "FixLoop: another instance is already using this Postgres " +
              "database (advisory lock is held); refusing to start a " +
              "second one against the same DATABASE_URL.",
          );
        }
      }
      await client.query(loadSchemaSql());
      await store.assertNoSchemaDrift(client);
      await store.hydrate(notifier);
    } catch (err) {
      // Same best-effort cleanup as the probe path: schema, lock, or
      // hydration failures must not leak the pool for an embedding caller.
      // Only the pool created above is ended; an injected DbClient stays
      // open — its owner decides its lifetime.
      await releaseLock();
      await pool?.end?.().catch(() => {});
      throw err;
    }
    return store;
  }

  /**
   * Fail fast when the existing table was created from an outdated schema.
   * The id column changed from UUID to TEXT during development, and
   * CREATE TABLE IF NOT EXISTS never migrates an existing table — without
   * this guard every insert would fail, and write-behind persistence is
   * warn-only, so the store would keep serving jobs from memory with only
   * a per-write warning as the signal.
   */
  private async assertNoSchemaDrift(client: DbClient): Promise<void> {
    const { rows } = await client.query(
      // Schema-qualified to the session's search_path: an unqualified
      // CREATE TABLE above lands in the first of these schemas, so the
      // drift check must look at exactly those — a table_name-only
      // filter could match another user's fixloop_jobs visible through
      // the search_path and fail boot with a false drift error.
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'fixloop_jobs' AND column_name = 'id'
         AND table_schema = ANY (current_schemas(false))`,
    );
    const dataType = rows[0]?.data_type;
    // No row: fresh table, the schema above just created it.
    if (dataType === undefined) return;
    if (dataType !== "text" && dataType !== "character varying") {
      throw new Error(
        `FixLoop: the fixloop_jobs table was created with an outdated schema ` +
          `(id is ${String(dataType)}, expected text). Recreate it — ` +
          `DROP TABLE fixloop_jobs; — and the current schema is applied ` +
          `automatically on the next boot.`,
      );
    }
  }

  private async hydrate(notifier?: JobNotifier): Promise<void> {
    const { rows } = await this.db.query(SELECT_ALL);
    // Belt and braces: the SQL above already orders and limits, but a
    // DbClient seam (or a future edit of the query) might not — never
    // let an unbounded table fill the in-memory Map.
    // The query fetches LIMIT + 1 rows: the extra sentinel row is the only
    // accurate signal that older rows beyond the window exist (a plain
    // `rows.length >= LIMIT` check false-positives when the table holds
    // exactly LIMIT rows and nothing was skipped).
    const truncated = rows.length > HYDRATE_ROW_LIMIT;
    const capped = rows.slice(0, HYDRATE_ROW_LIMIT);
    if (truncated) {
      // The read window was full: older rows beyond the LIMIT were not
      // loaded, so crash recovery skipped them — any stuck in a transient
      // status stay ACTIVE in Postgres indefinitely. The README documents
      // the invisibility, but the operator otherwise gets no signal that
      // the table is accumulating permanently-wrong rows.
      console.warn(
        `Postgres job store: hydration hit the row limit (${HYDRATE_ROW_LIMIT}); ` +
          `older rows beyond the window were not crash-recovered and stay active. ` +
          `Consider pruning old job history.`,
      );
    }
    let skipped = 0;
    // Crash-recovery notifications are fanned out after the loop (see
    // notifyRecovery): one fire-and-forget POST per orphaned row would
    // burst up to HYDRATE_ROW_LIMIT concurrent fetches at the webhook.
    const recoveryEvents: Array<{
      kind: "repair_failed";
      job: Job;
      reason: string;
    }> = [];
    for (const row of capped) {
      if (!isJobStatus(row.status)) {
        // Corrupt/hand-edited row: never let an invalid status into the
        // store, where it would silently break dedup and ?status= filters.
        console.warn(
          `Postgres job store: skipping row ${String(row.id)} with invalid status ${String(row.status)}.`,
        );
        skipped++;
        continue;
      }
      const parsedContext = errorContextSchema.safeParse(row.error_context);
      if (!parsedContext.success) {
        // Same policy for the diagnostics blob: a corrupt JSONB must not
        // flow into the typed pipeline wearing an unchecked shape.
        console.warn(
          `Postgres job store: skipping row ${String(row.id)} with invalid error_context.`,
        );
        skipped++;
        continue;
      }
      const job = rowToJob(row, row.status, parsedContext.data);
      // Bypass the write-behind: these rows are already in Postgres.
      super.create(job);
      if (CRASHED_STATUSES.has(job.status)) {
        // Crash recovery: the previous process died mid-repair, so this
        // status can never become true again. It must not stay "active" —
        // findActiveByDedupKey would otherwise block future repairs for
        // the same issue forever, with no operator signal. The correction
        // goes through the write-behind so the DB row is fixed as well.
        const failed = this.updateStatus(job.id, "FAILED", {
          note: RESTART_NOTE,
        });
        if (failed && notifier) {
          // The queue's notifyTransition never sees these (no queue
          // exists at hydrate time): this is the exact failure the
          // notifier exists for, so report it directly. Collected for the
          // bounded fan-out after the loop.
          recoveryEvents.push({
            kind: "repair_failed",
            job: failed,
            reason: RESTART_NOTE,
          });
        }
      }
    }
    if (notifier && recoveryEvents.length > 0) {
      void this.notifyRecovery(recoveryEvents, notifier);
    }
    if (skipped > 0) {
      // One summary line: skipped rows stay skipped on every boot, so the
      // operator gets a count plus the manual cleanup step instead of
      // only the per-row warnings above.
      console.warn(
        `Postgres job store: skipped ${skipped} corrupt row(s) during hydration; ` +
          `they are invisible to the API until removed manually, e.g. ` +
          `DELETE FROM fixloop_jobs WHERE id = '<id>';`,
      );
    }
  }

  /**
   * Fan out crash-recovery notifications with bounded concurrency.
   * Fire-and-forget with the same never-throw guard as JobQueue — a
   * broken notifier must not break hydration or boot. Unbounded
   * concurrency here would burst up to HYDRATE_ROW_LIMIT fetches at the
   * webhook and get rate-limited (429s are logged and dropped, so the
   * notifications would be silently lost).
   */
  private async notifyRecovery(
    events: Array<{ kind: "repair_failed"; job: Job; reason: string }>,
    notifier: JobNotifier,
  ): Promise<void> {
    for (let i = 0; i < events.length; i += RECOVERY_NOTIFY_CONCURRENCY) {
      await Promise.all(
        events.slice(i, i + RECOVERY_NOTIFY_CONCURRENCY).map(async (event) => {
          try {
            await notifier.notify(event);
          } catch (err) {
            // Same policy as JobQueue: the notifier is an injection point,
            // so a rejection message may carry secrets — sanitize it.
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`notification failed: ${sanitizeForPr(message)}`);
          }
        }),
      );
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
    // A rejected tail must not poison the chain: without the catch, the
    // .then() below would skip persist() and store the rejection as the
    // new tail, silently dropping every later write for this job id.
    const next = tail.catch(() => {}).then(() => this.persist(id, params));
    this.persistChains.set(id, next);
    // persist() never rejects (failures are logged), but the chain is
    // poison-proof by construction now; drop the finished tail so the map
    // cannot grow without bound.
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

  /**
   * Waits for pending write-behind chains to drain. Bounded: a write stuck
   * on a black-holed connection (pg has no default query timeout) must not
   * trap the caller forever. Returns true when fully drained, false when
   * the timeout won and writes are still pending.
   */
  async flush(timeoutMs: number = SHUTDOWN_FLUSH_TIMEOUT_MS): Promise<boolean> {
    const drained = (async (): Promise<true> => {
      while (this.persistChains.size > 0) {
        await Promise.allSettled([...this.persistChains.values()]);
      }
      return true;
    })();
    return raceWithTimeout(drained, timeoutMs, () => false);
  }

  /**
   * Flushes pending writes, then closes the underlying database pool.
   * Both phases are raced against the timeout: the flush so a
   * black-holed connection can never hang shutdown forever, and the
   * pool teardown because pg.Pool.end() waits for checked-out clients —
   * a query stuck on a dead connection is never released, so an
   * unbounded end() would trap the process on the first SIGTERM.
   * Worst case the whole close takes 2x the timeout. Never throws —
   * safe to call on the way out. A timed-out flush or teardown is
   * logged: transitions still in flight at that point never reach the
   * pool, and silent data loss is worse than a noisy log.
   */
  async close(timeoutMs = SHUTDOWN_FLUSH_TIMEOUT_MS): Promise<void> {
    const flushed = await this.flush(timeoutMs);
    if (!flushed) {
      console.warn(
        `Postgres job store: shutdown flush timed out after ${timeoutMs}ms ` +
          `with ${this.persistChains.size} write(s) still pending; they were dropped.`,
      );
    }
    // Release the instance advisory lock before tearing down the pool:
    // pool.end() waits for checked-out clients, and the lock client is
    // checked out for the process lifetime.
    await this.releaseLock();
    const endPromise = (async (): Promise<true> => {
      try {
        await this.db.end?.();
      } catch {
        // Non-fatal on the way out: the flush above is the durability
        // boundary, and close() must never throw.
      }
      return true;
    })();
    const closed = await raceWithTimeout(endPromise, timeoutMs, () => false);
    if (!closed) {
      console.warn(
        `Postgres job store: pool teardown timed out after ${timeoutMs}ms; ` +
          `in-flight queries were abandoned.`,
      );
    }
  }
}
