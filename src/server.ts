import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { BugSinkProvider } from "./providers/bugsink.js";
import { ErrorParseError } from "./providers/error-provider.js";

export const FIXLOOP_VERSION = "0.1.0";

export interface ServerOptions {
  /** Pre-shared token protecting the webhook endpoints. Defaults to FIXLOOP_WEBHOOK_SECRET. */
  webhookSecret?: string;
}

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const bugsink = new BugSinkProvider();

  app.get("/health", async () => ({ ok: true, version: FIXLOOP_VERSION }));

  // BugSink does not sign its outbound webhooks, so this endpoint is
  // protected by a pre-shared token instead: send it as the
  // X-FixLoop-Webhook-Token header or as ?token=.
  app.post("/webhooks/bugsink", async (req, reply) => {
    const secret = opts.webhookSecret ?? process.env.FIXLOOP_WEBHOOK_SECRET ?? "";
    if (!secret) {
      req.log.error("webhook secret not configured; refusing to accept events");
      return reply
        .status(500)
        .send({ error: "webhook secret not configured" });
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
      req.log.info(
        { provider: ctx.provider, issueId: ctx.issueId, project: ctx.project },
        "error event received",
      );
      return reply.status(202).send({
        received: true,
        provider: ctx.provider,
        issueId: ctx.issueId,
        project: ctx.project,
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

async function main(): Promise<void> {
  const port = Number(process.env.FIXLOOP_PORT ?? 3000);
  const host = process.env.FIXLOOP_HOST ?? "0.0.0.0";
  const app = buildServer();
  await app.listen({ port, host });
}

// Only listen when executed directly (not when imported by tests).
if (process.argv[1]?.endsWith("server.js")) {
  await main();
}
