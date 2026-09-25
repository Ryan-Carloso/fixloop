import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
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

    const jobRes = await app.inject({ method: "GET", url: `/jobs/${body.jobId}` });
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
    const res = await app.inject({ method: "GET", url: "/jobs" });
    expect(res.statusCode).toBe(200);
    const jobs = res.json();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].issueId).toBe("aaaaaaaa-0000-0000-0000-000000000000");
  });

  it("returns 404 for an unknown job id", async () => {
    const { app } = buildTestServer();
    const res = await app.inject({ method: "GET", url: "/jobs/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  it("filters jobs via GET /jobs?status=", async () => {
    const { app } = buildTestServer();
    await postWebhook(app, payload);
    await postWebhook(app, { ...payload, id: "aaaaaaaa-0000-0000-0000-000000000000" });
    const res = await app.inject({ method: "GET", url: "/jobs?status=QUEUED" });
    expect(res.statusCode).toBe(200);
    // The blocking test handler keeps the first job RUNNING; only the
    // second stays QUEUED (concurrency 1).
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].issueId).toBe("aaaaaaaa-0000-0000-0000-000000000000");
    const none = await app.inject({ method: "GET", url: "/jobs?status=FAILED" });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toHaveLength(0);
  });

  it("returns 400 for an unknown ?status= value", async () => {
    const { app } = buildTestServer();
    const res = await app.inject({ method: "GET", url: "/jobs?status=BOGUS" });
    expect(res.statusCode).toBe(400);
  });
});
