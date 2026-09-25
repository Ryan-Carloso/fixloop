import { describe, expect, it, vi } from "vitest";
import { buildServer, redactTokenFromUrl } from "../src/server.js";
import { JobQueue, JobStore, type JobHandler } from "../src/jobs/jobs.js";
import type { FixLoopConfig } from "../src/config/config.js";

const secret = "test-webhook-secret";

const config: FixLoopConfig = {
  repositories: {
    "my-app": {
      providerProject: "my-app",
      github: { repository: "my-user/my-app", defaultBranch: "main" },
      commands: {
        install: "pnpm install --frozen-lockfile",
        test: "pnpm test",
      },
    },
  },
};

const payload = {
  id: "497f6eca-6276-4993-bfeb-53cbbbba6f08",
  calculated_type: "ValueError",
  calculated_value: "invalid literal for int()",
  title: "ValueError: invalid literal for int()",
  project_name: "my-app",
  url: "https://bugsink.example.com/issues/497f6eca-6276-4993-bfeb-53cbbbba6f08/",
  alert_reason: "NEW_ISSUE",
};

// A handler that never finishes, so jobs stay QUEUED/RUNNING deterministically.
const blockingHandler: JobHandler = () => new Promise(() => {});

function buildTestServer() {
  const store = new JobStore();
  const queue = new JobQueue(store, blockingHandler);
  const app = buildServer({ webhookSecret: secret, config, store, queue });
  return { app, store };
}

function postWebhook(app: ReturnType<typeof buildServer>, body: unknown) {
  return app.inject({
    method: "POST",
    url: "/webhooks/bugsink",
    headers: { "x-fixloop-webhook-token": secret },
    payload: body,
  });
}

describe("webhook -> queue integration", () => {
  it("enqueues a job for a mapped project", async () => {
    const { app } = buildTestServer();
    const res = await postWebhook(app, payload);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.received).toBe(true);
    expect(body.queued).toBe(true);
    expect(body.deduped).toBe(false);
    expect(typeof body.jobId).toBe("string");

    const jobRes = await app.inject({
      method: "GET",
      url: `/jobs/${body.jobId}`,
      headers: { "x-fixloop-webhook-token": secret },
    });
    expect(jobRes.statusCode).toBe(200);
    expect(jobRes.json()).toMatchObject({
      id: body.jobId,
      provider: "bugsink",
      repository: "my-app",
      issueId: "497f6eca-6276-4993-bfeb-53cbbbba6f08",
      // The in-process worker picks the job up synchronously on enqueue.
      status: "RUNNING",
      dedupKey: "bugsink:my-app:497f6eca-6276-4993-bfeb-53cbbbba6f08",
    });
  });

  it("deduplicates a second webhook for the same issue", async () => {
    const { app } = buildTestServer();
    const first = (await postWebhook(app, payload)).json();
    const second = await postWebhook(app, payload);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({
      received: true,
      queued: false,
      deduped: true,
      jobId: first.jobId,
    });
  });

  it("acknowledges but does not queue events for unmapped projects", async () => {
    const { app } = buildTestServer();
    const res = await postWebhook(app, { ...payload, project_name: "other-app" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ received: true, queued: false });
    expect(res.json().reason).toMatch(/no repository mapping/i);
  });

  it("lists jobs via GET /jobs", async () => {
    const { app } = buildTestServer();
    await postWebhook(app, payload);
    await postWebhook(app, { ...payload, id: "aaaaaaaa-0000-0000-0000-000000000000" });
    const res = await app.inject({
      method: "GET",
      url: "/jobs",
      headers: { "x-fixloop-webhook-token": secret },
    });
    expect(res.statusCode).toBe(200);
    const jobs = res.json();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].issueId).toBe("aaaaaaaa-0000-0000-0000-000000000000");
  });

  it("treats an empty ?status= as no filter", async () => {
    const { app } = buildTestServer();
    await postWebhook(app, payload);
    const res = await app.inject({
      method: "GET",
      url: "/jobs?status=",
      headers: { "x-fixloop-webhook-token": secret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("requires the webhook token for GET /jobs", async () => {
    const { app } = buildTestServer();
    await postWebhook(app, payload);
    const noToken = await app.inject({ method: "GET", url: "/jobs" });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json()).toEqual({ error: "invalid webhook token" });
    const wrongToken = await app.inject({
      method: "GET",
      url: "/jobs",
      headers: { "x-fixloop-webhook-token": "wrong" },
    });
    expect(wrongToken.statusCode).toBe(401);
  });

  it("requires the webhook token for GET /jobs/:id", async () => {
    const { app } = buildTestServer();
    const created = (await postWebhook(app, payload)).json();
    const noToken = await app.inject({
      method: "GET",
      url: `/jobs/${created.jobId}`,
    });
    expect(noToken.statusCode).toBe(401);
  });

  it("rejects ?token= on the GET routes (the secret would land in request logs)", async () => {
    const { app } = buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: `/jobs?token=${secret}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid webhook token" });
  });

  it("returns an indistinguishable 401 on the GET routes when no webhook secret is configured", async () => {
    // An anonymous prober must not be able to tell an unconfigured
    // deployment (no secret to steal) from a configured one: both answer
    // exactly like a wrong token. The misconfiguration is logged
    // server-side once at startup instead.
    const previous = process.env.FIXLOOP_WEBHOOK_SECRET;
    delete process.env.FIXLOOP_WEBHOOK_SECRET;
    try {
      const app = buildServer({ config });
      const list = await app.inject({ method: "GET", url: "/jobs" });
      expect(list.statusCode).toBe(401);
      expect(list.json()).toEqual({ error: "invalid webhook token" });
      const one = await app.inject({ method: "GET", url: "/jobs/abc" });
      expect(one.statusCode).toBe(401);
      expect(one.json()).toEqual({ error: "invalid webhook token" });
    } finally {
      if (previous === undefined) {
        delete process.env.FIXLOOP_WEBHOOK_SECRET;
      } else {
        process.env.FIXLOOP_WEBHOOK_SECRET = previous;
      }
    }
  });

  it("warns once at buildServer, not per request, when the secret is unset", async () => {
    const previous = process.env.FIXLOOP_WEBHOOK_SECRET;
    delete process.env.FIXLOOP_WEBHOOK_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const app = buildServer({ config });
      const first = await app.inject({ method: "GET", url: "/jobs" });
      expect(first.statusCode).toBe(401);
      const second = await app.inject({ method: "GET", url: "/jobs/abc" });
      expect(second.statusCode).toBe(401);
      // One startup warning, not one per rejected request: the secret is
      // static per process, so per-request warnings would let
      // unauthenticated outsiders flood the logs. (The Discord "not set"
      // warning is unrelated and pre-existing.)
      const secretWarns = () =>
        warn.mock.calls.filter((c) =>
          String(c[0]).includes("webhook secret not configured"),
        ).length;
      expect(secretWarns()).toBe(1);
    } finally {
      warn.mockRestore();
      if (previous === undefined) {
        delete process.env.FIXLOOP_WEBHOOK_SECRET;
      } else {
        process.env.FIXLOOP_WEBHOOK_SECRET = previous;
      }
    }
  });

  it("returns 404 for an unknown job id", async () => {
    const { app } = buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/jobs/does-not-exist",
      headers: { "x-fixloop-webhook-token": secret },
    });
    expect(res.statusCode).toBe(404);
  });

  it("filters jobs via GET /jobs?status=", async () => {
    const { app } = buildTestServer();
    await postWebhook(app, payload);
    await postWebhook(app, { ...payload, id: "aaaaaaaa-0000-0000-0000-000000000000" });
    const res = await app.inject({
      method: "GET",
      url: "/jobs?status=QUEUED",
      headers: { "x-fixloop-webhook-token": secret },
    });
    expect(res.statusCode).toBe(200);
    // The blocking test handler keeps the first job RUNNING; only the
    // second stays QUEUED (concurrency 1).
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].issueId).toBe("aaaaaaaa-0000-0000-0000-000000000000");
    const none = await app.inject({
      method: "GET",
      url: "/jobs?status=FAILED",
      headers: { "x-fixloop-webhook-token": secret },
    });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toHaveLength(0);
  });

  it("returns 400 for an unknown ?status= value", async () => {
    const { app } = buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/jobs?status=BOGUS",
      headers: { "x-fixloop-webhook-token": secret },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("default Discord notifier wiring", () => {
  it("notifies through DiscordNotifier.fromEnv() in the default queue", async () => {
    const url = "https://discord.com/api/webhooks/123/serverwiring";
    const previousWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    process.env.DISCORD_WEBHOOK_URL = url;
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      // No queue/notifier injected: buildServer must wire
      // DiscordNotifier.fromEnv() into its default JobQueue.
      const app = buildServer({ webhookSecret: secret, config });
      const res = await postWebhook(app, payload);
      expect(res.statusCode).toBe(202);
      // The stub handler marks the job NEEDS_HUMAN_REVIEW, which must
      // produce a needs_review Discord notification via the default wiring.
      // Poll instead of a fixed sleep: queue processing time varies.
      for (let i = 0; i < 100 && fetchSpy.mock.calls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(fetchSpy).toHaveBeenCalled();
      for (const call of fetchSpy.mock.calls) {
        expect(call[0]).toBe(url);
      }
      const embeds = fetchSpy.mock.calls.map(
        (call) => JSON.parse((call[1] as RequestInit).body as string).embeds[0],
      );
      expect(
        embeds.some((e: { title: string }) =>
          /needs human review/i.test(e.title),
        ),
      ).toBe(true);
    } finally {
      if (previousWebhookUrl === undefined) {
        delete process.env.DISCORD_WEBHOOK_URL;
      } else {
        process.env.DISCORD_WEBHOOK_URL = previousWebhookUrl;
      }
      vi.unstubAllGlobals();
    }
  });
});

describe("redactTokenFromUrl", () => {
  it("redacts the token query parameter", () => {
    expect(redactTokenFromUrl("/webhooks/bugsink?token=supersecret")).toBe(
      "/webhooks/bugsink?token=[redacted]",
    );
  });

  it("redacts the token among other query parameters", () => {
    expect(redactTokenFromUrl("/jobs?status=FAILED&token=abc&x=1")).toBe(
      "/jobs?status=FAILED&token=[redacted]&x=1",
    );
  });

  it("leaves URLs without a token untouched", () => {
    expect(redactTokenFromUrl("/jobs?status=FAILED")).toBe(
      "/jobs?status=FAILED",
    );
    expect(redactTokenFromUrl("/health")).toBe("/health");
  });
});

describe("redactTokenFromUrl percent-encoded keys", () => {
  it("redacts a percent-encoded token parameter name (%74oken=)", () => {
    // Fastify decodes parameter names, so ?%74oken=<secret> authenticates
    // as token= while the raw logged URL hides from a literal match.
    expect(redactTokenFromUrl("/webhooks/bugsink?%74oken=supersecret")).toBe(
      "/webhooks/bugsink?token=[redacted]",
    );
  });

  it("still redacts when only part of the name is encoded", () => {
    expect(redactTokenFromUrl("/webhooks/bugsink?tok%65n=abc")).toBe(
      "/webhooks/bugsink?token=[redacted]",
    );
  });

  it("leaves malformed percent sequences untouched rather than throwing", () => {
    expect(redactTokenFromUrl("/jobs?status=%zz")).toBe("/jobs?status=%zz");
  });
});

describe("redactTokenFromUrl two-pass redaction", () => {
  it("redacts a token value containing an encoded separator without leaking the tail", () => {
    // Decoding first would split ?token=a%26b into ?token=a&b and leave
    // the tail "b" in the logs. The raw pass must consume the whole value.
    expect(redactTokenFromUrl("/webhooks/bugsink?token=a%26b")).toBe(
      "/webhooks/bugsink?token=[redacted]",
    );
  });
});
