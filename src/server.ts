import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { findRepository, loadConfig, type FixLoopConfig } from "./config/config.js";
import {
  JobQueue,
  JobStore,
  dedupKey,
  isJobStatus,
  newJobId,
  type Job,
  type JobHandler,
} from "./jobs/jobs.js";
import { PostgresJobStore } from "./db/postgres.js";
import { BugSinkProvider } from "./providers/bugsink.js";
import { ErrorParseError } from "./providers/error-provider.js";
import { DiscordNotifier, type JobNotifier } from "./notify/discord.js";

export const FIXLOOP_VERSION = "0.1.0";

/**
 * Redacts the ?token= query parameter from a request URL. The webhook
 * ingest route accepts the pre-shared token as ?token= (some senders
 * cannot set headers), and Fastify's request logs include the full URL —
 * without this, every such delivery would write the secret into the
 * server logs.
 */
export function redactTokenFromUrl(url: string): string {
  // Two passes, in order. The raw pass consumes a token value containing
  // percent-encoded separators (?token=a%26b): decoding first would split
  // it and leak the tail into the logs. The decoded pass then catches
  // percent-encoded parameter names (?%74oken=), which Fastify's query
  // parser decodes and would otherwise authenticate as token= while
  // hiding from the raw match. A malformed URL keeps the raw-pass result
  // rather than throwing inside a log hook.
  const redact = (value: string): string =>
    value.replace(/([?&])token=[^&]*/g, "$1token=[redacted]");
  let redacted = redact(url);
  try {
    redacted = redact(decodeURIComponent(redacted));
  } catch {
    // Malformed percent sequences: the raw pass already did its best.
  }
  return redacted;
}

export interface ServerDeps {
  /** Pre-shared token protecting the webhook endpoints. Defaults to FIXLOOP_WEBHOOK_SECRET. */
  webhookSecret?: string;
  config?: FixLoopConfig;
  store?: JobStore;
  queue?: JobQueue;
  handleJob?: JobHandler;
  /**
   * Discord notifier. Defaults to DiscordNotifier.fromEnv() (no-op when
   * DISCORD_WEBHOOK_URL is unset). Only used when the default queue is
   * built — ignored when `queue` is injected (wire the notifier into your
   * own JobQueue instead).
   */
  notifier?: JobNotifier;
  /**
   * Destination stream for request logs. Exposed for tests so the
   * ?token= redaction wiring can be asserted end-to-end; production
   * leaves it unset (stdout).
   */
  logStream?: NodeJS.WritableStream;
}

function tokensEqual(a: string, b: string): boolean {
  // Compare byte lengths, not string lengths: timingSafeEqual throws when
  // the buffers differ in size, and a multibyte char makes UTF-8 byte
  // length differ from JS string length.
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

type AuthCheck = { ok: true } | { ok: false; status: 401 | 500; error: string };

/**
 * Pre-shared-token auth for every endpoint that touches job data. The
 * /jobs endpoints serve raw error diagnostics (errorContext straight from
 * the provider payload), so they require the same token as the webhook
 * ingest — never serve them open on a 0.0.0.0-bound server.
 *
 * The token travels as the X-FixLoop-Webhook-Token header. The webhook
 * ingest route additionally accepts ?token= (some webhook senders cannot
 * set headers); the GET routes do not, because Fastify's request logs
 * include the full URL and would write the secret into the server logs.
 * Query tokens are opt-in per route (allowQueryToken: true) so a future
 * route cannot re-introduce the leak by forgetting the flag.
 */
function checkAuth(
  req: { headers: Record<string, unknown>; query: unknown },
  deps: ServerDeps,
  opts: { allowQueryToken?: boolean } = {},
): AuthCheck {
  const secret = deps.webhookSecret ?? process.env.FIXLOOP_WEBHOOK_SECRET ?? "";
  if (!secret) {
    // Fail closed with a response indistinguishable from a wrong token:
    // an anonymous prober must not learn whether this deployment has a
    // secret configured. The misconfiguration is warned once at startup
    // in buildServer() instead — and not logged per request, so
    // unauthenticated outsiders cannot flood the server logs.
    return { ok: false, status: 401, error: "invalid webhook token" };
  }
  const headerToken = req.headers["x-fixloop-webhook-token"];
  const queryToken = (req.query as { token?: unknown }).token;
  const provided =
    (Array.isArray(headerToken) ? headerToken[0] : headerToken) ??
    (opts.allowQueryToken === true && typeof queryToken === "string"
      ? queryToken
      : undefined);
  if (typeof provided !== "string" || !tokensEqual(provided, secret)) {
    return { ok: false, status: 401, error: "invalid webhook token" };
  }
  return { ok: true };
}

/**
 * Temporary stand-in until the Docker/OpenCode repair pipeline lands
 * (phases 4-9). Keeps the webhook -> queue -> worker path exercisable.
 */
const stubHandler: JobHandler = async (_job, update) => {
  update("NEEDS_HUMAN_REVIEW", {
    note: "repair pipeline not implemented yet (lands in phases 4-9)",
  });
};

export function buildServer(deps: ServerDeps = {}): FastifyInstance {
  if (!(deps.webhookSecret ?? process.env.FIXLOOP_WEBHOOK_SECRET)) {
    // Warn once here, not per request in checkAuth: the secret is static
    // for the process lifetime, and a per-request warning would let
    // unauthenticated outsiders flood the server logs.
    console.warn(
      "webhook secret not configured (set FIXLOOP_WEBHOOK_SECRET); all authenticated routes will fail closed",
    );
  }
  const app = Fastify({
    logger: {
      // Redact ?token= from logged request URLs (see redactTokenFromUrl):
      // the webhook ingest accepts the secret as a query parameter.
      redact: {
        paths: ["req.url"],
        censor: (value) => redactTokenFromUrl(String(value)),
      },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
  });
  const bugsink = new BugSinkProvider();
  const config = deps.config ?? { repositories: {} };
  const store = deps.store ?? new JobStore();
  const queue =
    deps.queue ??
    new JobQueue(
      store,
      deps.handleJob ?? stubHandler,
      1,
      deps.notifier ?? DiscordNotifier.fromEnv(),
    );

  app.get("/health", async () => ({ ok: true, version: FIXLOOP_VERSION }));

  app.get("/jobs", async (req, reply) => {
    const auth = checkAuth(req, deps);
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: auth.error });
    }
    const { status } = req.query as { status?: unknown };
    // An empty ?status= means "no filter" (generated clients); only a
    // non-empty unknown value is a 400.
    if (status !== undefined && status !== "" && !isJobStatus(status)) {
      return reply
        .status(400)
        .send({ error: `unknown status: ${String(status)}` });
    }
    return store.list(isJobStatus(status) ? status : undefined);
  });

  app.get("/jobs/:id", async (req, reply) => {
    const auth = checkAuth(req, deps);
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: auth.error });
    }
    const { id } = req.params as { id: string };
    const job = store.get(id);
    if (!job) return reply.status(404).send({ error: "job not found" });
    return job;
  });

  app.post("/webhooks/bugsink", async (req, reply) => {
    const auth = checkAuth(req, deps, { allowQueryToken: true });
    if (!auth.ok) {
      if (auth.status === 500) {
        req.log.error("webhook secret not configured; refusing to accept events");
      }
      return reply.status(auth.status).send({ error: auth.error });
    }

    try {
      const ctx = await bugsink.parse(req.body);
      const repo = findRepository(config, ctx.project);
      if (!repo) {
        req.log.info(
          { issueId: ctx.issueId, project: ctx.project },
          "event received but no repository mapping; not queued",
        );
        return reply.status(202).send({
          received: true,
          queued: false,
          reason: `no repository mapping for project '${ctx.project ?? "unknown"}'`,
        });
      }

      const now = new Date().toISOString();
      const job: Job = {
        id: newJobId(),
        dedupKey: dedupKey(ctx.provider, repo.key, ctx.issueId),
        provider: ctx.provider,
        repository: repo.key,
        issueId: ctx.issueId,
        status: "QUEUED",
        errorContext: ctx,
        createdAt: now,
        updatedAt: now,
      };
      const result = queue.enqueue(job);
      if (!result.accepted && !result.deduped) {
        // The queue is quiescing for shutdown: the job is persisted and
        // crash recovery will mark it interrupted on the next boot, but
        // no repair starts in this process. 503 (not a silent 202) tells
        // the sender to retry.
        return reply.status(503).send({
          received: true,
          provider: ctx.provider,
          issueId: ctx.issueId,
          project: ctx.project,
          queued: false,
          reason: "server is shutting down",
        });
      }
      req.log.info(
        {
          jobId: result.job.id,
          dedupKey: job.dedupKey,
          queued: result.accepted,
          deduped: result.deduped,
        },
        "job enqueued",
      );
      return reply.status(202).send({
        received: true,
        provider: ctx.provider,
        issueId: ctx.issueId,
        project: ctx.project,
        queued: result.accepted,
        deduped: result.deduped,
        jobId: result.job.id,
        status: result.job.status,
      });
    } catch (err) {
      if (err instanceof ErrorParseError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
  });

  return app;
}

/**
 * Upper bound for stopping the HTTP server during shutdown. A stalled
 * in-flight request must not hang the process forever.
 */
export const SHUTDOWN_BEFORE_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Registers SIGTERM/SIGINT handlers that stop the HTTP server, flush the
 * Postgres write-behind and close the pool before exiting. Extracted from
 * main() so the wiring is unit-testable. beforeClose quiesces the queue
 * (lets the active repair finish) and stops HTTP, so the write-behind
 * flush sees every transition the active repair produced.
 */
export function registerShutdown(
  store: Pick<PostgresJobStore, "close">,
  deps: {
    onSignal?: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
    exit?: (code: number) => void;
    /**
     * Runs before the store flush (e.g. stop the HTTP server so no new
     * transitions are enqueued while the write-behind drains).
     */
    beforeClose?: () => Promise<void> | void;
    /** Bound for beforeClose; override in tests. Defaults to 5s. */
    beforeCloseTimeoutMs?: number;
  } = {},
): void {
  const onSignal =
    deps.onSignal ?? ((signal, handler) => process.on(signal, handler));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const beforeCloseTimeoutMs =
    deps.beforeCloseTimeoutMs ?? SHUTDOWN_BEFORE_CLOSE_TIMEOUT_MS;
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      // A repeat signal while shutdown is already in flight: the operator
      // is asking to leave now. Force-exit instead of trapping them
      // behind a hung beforeClose.
      exit(1);
      return;
    }
    shuttingDown = true;
    void (async () => {
      try {
        await Promise.race([
          (async () => {
            await deps.beforeClose?.();
          })(),
          new Promise((resolve) =>
            setTimeout(resolve, beforeCloseTimeoutMs),
          ),
        ]);
      } catch {
        // Non-fatal: the flush must still run.
      }
      await store.close();
    })()
      .catch(() => {})
      .finally(() => exit(0));
  };
  onSignal("SIGTERM", shutdown);
  onSignal("SIGINT", shutdown);
}

/**
 * Resolves the job store for main(). When DATABASE_URL is set, connects to
 * Postgres and fails fast (logs the error, exits 1) when it is unreachable.
 * Extracted from main() so the boot decision is unit-testable; the real
 * process.on signal wiring stays inline below.
 */
export async function resolveStore(
  databaseUrl: string | undefined,
  deps: {
    connect?: (
      url: string,
      notifier?: JobNotifier,
    ) => Promise<PostgresJobStore>;
    exit?: (code: number) => never;
    notifier?: JobNotifier;
  } = {},
): Promise<PostgresJobStore | undefined> {
  if (!databaseUrl) return undefined;
  console.log("DATABASE_URL is set; using Postgres for job storage.");
  const connect =
    deps.connect ??
    ((url: string, notifier?: JobNotifier) =>
      PostgresJobStore.connect(url, undefined, notifier));
  try {
    // The notifier lets crash recovery report restart-orphaned jobs;
    // connect() fans it out to hydrate().
    return await connect(databaseUrl, deps.notifier);
  } catch (err) {
    console.error(
      `Failed to initialize Postgres job store: ${err instanceof Error ? err.message : String(err)}`,
    );
    (deps.exit ?? process.exit)(1);
  }
}

async function main(deps: { handleJob?: JobHandler } = {}): Promise<void> {
  const port = Number(process.env.FIXLOOP_PORT ?? 3000);
  const host = process.env.FIXLOOP_HOST ?? "0.0.0.0";

  const configPath = process.env.FIXLOOP_CONFIG ?? "fixloop.config.yaml";
  let config: FixLoopConfig = { repositories: {} };
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.warn(
      `warning: ${(err as Error).message}; continuing with no repository mappings`,
    );
  }

  // One notifier instance shared by the queue and the Postgres store:
  // crash recovery in hydrate() needs it to report restart-orphaned jobs.
  const notifier = DiscordNotifier.fromEnv();
  const store = await resolveStore(process.env.DATABASE_URL, { notifier });

  let app: FastifyInstance;
  if (store) {
    // The Postgres branch owns the queue so shutdown can quiesce it:
    // let the active repair finish, then stop HTTP, then flush the
    // write-behind. Residual risk: a repair that outlasts the beforeClose
    // timeout keeps running in the background; its late transitions are
    // dropped by the pool close, and crash recovery marks the job
    // interrupted on the next boot (dedup key freed). The handler is
    // threaded like the in-memory branch (buildServer honors
    // deps.handleJob) so the two boot paths can't silently drift when a
    // real repair pipeline lands.
    const queue = new JobQueue(
      store,
      deps.handleJob ?? stubHandler,
      1,
      notifier,
    );
    app = buildServer({ config, store, queue });
    registerShutdown(store, {
      beforeClose: async () => {
        await queue.stop();
        await app.close();
      },
    });
  } else {
    // Reuse the notifier built above: buildServer() would otherwise
    // construct a second one, warning twice about the unset webhook URL.
    app = buildServer({ config, notifier });
  }
  await app.listen({ port, host });
}

// Only listen when executed directly (not when imported by tests).
if (process.argv[1]?.endsWith("server.js")) {
  await main();
}
