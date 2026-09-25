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
}

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
  const app = Fastify({ logger: true });
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
    const { status } = req.query as { status?: unknown };
    if (status !== undefined && !isJobStatus(status)) {
      return reply
        .status(400)
        .send({ error: `unknown status: ${String(status)}` });
    }
    return store.list(status);
  });

  app.get("/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.get(id);
    if (!job) return reply.status(404).send({ error: "job not found" });
    return job;
  });

  // BugSink does not sign its outbound webhooks, so this endpoint is
  // protected by a pre-shared token instead: send it as the
  // X-FixLoop-Webhook-Token header or as ?token=.
  app.post("/webhooks/bugsink", async (req, reply) => {
    const secret =
      deps.webhookSecret ?? process.env.FIXLOOP_WEBHOOK_SECRET ?? "";
    if (!secret) {
      req.log.error("webhook secret not configured; refusing to accept events");
      return reply.status(500).send({ error: "webhook secret not configured" });
    }

    const headerToken = req.headers["x-fixloop-webhook-token"];
    const queryToken = (req.query as { token?: unknown }).token;
    const provided =
      (Array.isArray(headerToken) ? headerToken[0] : headerToken) ??
      (typeof queryToken === "string" ? queryToken : undefined);

    if (!provided || !tokensEqual(provided, secret)) {
      return reply.status(401).send({ error: "invalid webhook token" });
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
 * Registers SIGTERM/SIGINT handlers that flush the Postgres write-behind
 * and close the pool before exiting. Extracted from main() so the wiring
 * is unit-testable. In-flight HTTP requests are dropped on shutdown; the
 * priority is flushing job history so it survives the restart.
 */
export function registerShutdown(
  store: Pick<PostgresJobStore, "close">,
  deps: {
    onSignal?: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
    exit?: (code: number) => void;
  } = {},
): void {
  const onSignal =
    deps.onSignal ?? ((signal, handler) => process.on(signal, handler));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return; // ignore repeats while the flush is running
    shuttingDown = true;
    void store
      .close()
      .catch(() => {})
      .finally(() => exit(0));
  };
  onSignal("SIGTERM", shutdown);
  onSignal("SIGINT", shutdown);
}

async function main(): Promise<void> {
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

  const databaseUrl = process.env.DATABASE_URL;
  let store: JobStore | undefined;
  if (databaseUrl) {
    console.log("DATABASE_URL is set; using Postgres for job storage.");
    try {
      store = await PostgresJobStore.connect(databaseUrl);
    } catch (err) {
      console.error(
        `Failed to initialize Postgres job store: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  const app = buildServer({ config, store });
  if (store instanceof PostgresJobStore) {
    registerShutdown(store);
  }
  await app.listen({ port, host });
}

// Only listen when executed directly (not when imported by tests).
if (process.argv[1]?.endsWith("server.js")) {
  await main();
}
