import Fastify, { type FastifyInstance } from "fastify";

export const FIXLOOP_VERSION = "0.1.0";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true, version: FIXLOOP_VERSION }));

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
