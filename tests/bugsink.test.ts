import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { BugSinkProvider } from "../src/providers/bugsink.js";
import { buildServer } from "../src/server.js";
import { JobQueue, JobStore, type JobHandler } from "../src/jobs/jobs.js";
import type { FixLoopConfig } from "../src/config/config.js";

// Modeled on BugSink's real custom-webhook payload:
// IssueSerializer fields + the convenience fields the backend adds
// (title, project_name, url, alert_reason). See
// alerts/service_backends/custom.py in bugsink/bugsink.
const validPayload = {
  id: "497f6eca-6276-4993-bfeb-53cbbbba6f08",
  friendly_id: "MYAPP-1A2B3C",
  project: 7,
  digest_order: 1,
  last_seen: "2026-09-23T20:00:00Z",
  first_seen: "2026-09-23T19:00:00Z",
  digested_event_count: 12,
  stored_event_count: 15,
  calculated_type: "ValueError",
  calculated_value: "invalid literal for int()",
  transaction: "/api/users/login",
  is_resolved: false,
  is_resolved_unconditionally: false,
  is_resolved_by_next_release: false,
  is_muted: false,
  title: "ValueError: invalid literal for int()",
  project_name: "my-app",
  url: "https://bugsink.example.com/issues/497f6eca-6276-4993-bfeb-53cbbbba6f08/",
  alert_reason: "NEW_ISSUE",
};

describe("BugSinkProvider", () => {
  const provider = new BugSinkProvider();

  it("has the provider name 'bugsink'", () => {
    expect(provider.name).toBe("bugsink");
  });

  it("normalizes a BugSink webhook payload into an ErrorContext", async () => {
    const ctx = await provider.parse(validPayload);
    expect(ctx.provider).toBe("bugsink");
    expect(ctx.issueId).toBe("497f6eca-6276-4993-bfeb-53cbbbba6f08");
    expect(ctx.project).toBe("my-app");
    expect(ctx.exception).toEqual({
      type: "ValueError",
      message: "invalid literal for int()",
    });
    // BugSink's issue-level webhook carries no stacktrace.
    expect(ctx.exception.stacktrace).toBeUndefined();
    expect(ctx.metadata).toMatchObject({
      title: "ValueError: invalid literal for int()",
      issueUrl:
        "https://bugsink.example.com/issues/497f6eca-6276-4993-bfeb-53cbbbba6f08/",
      alertReason: "NEW_ISSUE",
      transaction: "/api/users/login",
      storedEventCount: 15,
    });
  });

  it("falls back to safe defaults when calculated type/value are missing", async () => {
    const { calculated_type, calculated_value, title, ...rest } = validPayload;
    void calculated_type;
    void calculated_value;
    void title;
    const ctx = await provider.parse(rest);
    expect(ctx.exception.type).toBe("UnknownError");
    expect(ctx.exception.message).toBe("unknown error");
  });

  it("rejects payloads without an issue id", async () => {
    const { id, ...rest } = validPayload;
    void id;
    await expect(provider.parse(rest)).rejects.toThrow(/issue id/i);
  });

  it("rejects non-object payloads", async () => {
    await expect(provider.parse(null)).rejects.toThrow();
    await expect(provider.parse("nope")).rejects.toThrow();
  });
});

describe("POST /webhooks/bugsink", () => {
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

  it("accepts a valid signed payload and returns the normalized issue", async () => {
    const app = buildServer({ webhookSecret: secret, config });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/bugsink",
      headers: { "x-fixloop-webhook-token": secret },
      payload: validPayload,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      received: true,
      provider: "bugsink",
      issueId: "497f6eca-6276-4993-bfeb-53cbbbba6f08",
      project: "my-app",
      queued: true,
    });
  });

  it("also accepts the token as a ?token= query param", async () => {
    const app = buildServer({ webhookSecret: secret });
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/bugsink?token=${secret}`,
      payload: validPayload,
    });
    expect(res.statusCode).toBe(202);
  });

  it("rejects requests without a token", async () => {
    const app = buildServer({ webhookSecret: secret });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/bugsink",
      payload: validPayload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects requests with a wrong token", async () => {
    const app = buildServer({ webhookSecret: secret });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/bugsink",
      headers: { "x-fixloop-webhook-token": "wrong" },
      payload: validPayload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 (not 500) when a multibyte token has the same string length", async () => {
    // "sécret" is 6 chars / 7 bytes; "secrex" is 6 chars / 6 bytes. The
    // comparison must use byte lengths, or timingSafeEqual throws.
    const app = buildServer({ webhookSecret: "sécret" });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/bugsink",
      headers: { "x-fixloop-webhook-token": "secrex" },
      payload: validPayload,
    });
    expect(res.statusCode).toBe(401);
    const ok = await app.inject({
      method: "POST",
      url: "/webhooks/bugsink",
      headers: { "x-fixloop-webhook-token": "sécret" },
      payload: validPayload,
    });
    expect(ok.statusCode).toBe(202);
  });

  it("rejects malformed payloads with 400", async () => {
    const app = buildServer({ webhookSecret: secret });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/bugsink",
      headers: { "x-fixloop-webhook-token": secret },
      payload: { nope: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("never writes the ?token= secret to the request logs", async () => {
    // The ingest route accepts ?token= for senders that cannot set
    // headers; the pino redact wiring must keep it out of the logs.
    const chunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const app = buildServer({ webhookSecret: secret, config, logStream });
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/bugsink?token=${secret}`,
      payload: validPayload,
    });
    expect(res.statusCode).toBe(202);
    let logs = "";
    for (let i = 0; i < 100 && !logs.includes("request completed"); i++) {
      await new Promise((r) => setTimeout(r, 10));
      logs = chunks.join("");
    }
    expect(logs).toContain("request completed");
    expect(logs).toContain("token=[redacted]");
    expect(logs).not.toContain(secret);
  });

  it("fails closed when no webhook secret is configured", async () => {
    const app = buildServer({ webhookSecret: "" });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/bugsink",
      payload: validPayload,
    });
    expect(res.statusCode).toBe(500);
  });
});
