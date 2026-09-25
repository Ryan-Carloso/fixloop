import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DiscordNotifier,
  type DiscordEvent,
  type JobNotifier,
} from "../src/notify/discord.js";
import {
  JobQueue,
  JobStore,
  dedupKey,
  type Job,
} from "../src/jobs/jobs.js";
import type { ErrorContext } from "../src/providers/error-provider.js";

const WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";

function sampleCtx(issue: string): ErrorContext {
  return {
    provider: "bugsink",
    issueId: issue,
    project: "my-app",
    exception: { type: "ValueError", message: "bad" },
  };
}

function makeJob(issue: string): Job {
  const now = new Date().toISOString();
  return {
    id: `job-${issue}`,
    dedupKey: dedupKey("bugsink", "my-app", issue),
    provider: "bugsink",
    repository: "my-app",
    issueId: issue,
    status: "QUEUED",
    errorContext: sampleCtx(issue),
    createdAt: now,
    updatedAt: now,
  };
}

function jobRef() {
  return {
    id: "job-1",
    repository: "my-app",
    issueId: "issue-1",
    provider: "bugsink",
  };
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastPayload() {
  const calls = fetchMock.mock.calls;
  const init = calls[calls.length - 1][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("DiscordNotifier.fromEnv", () => {
  it("is a silent no-op when DISCORD_WEBHOOK_URL is unset", async () => {
    const notifier = DiscordNotifier.fromEnv({});
    expect(notifier.enabled).toBe(false);
    await notifier.notify({ kind: "repair_started", job: jobRef() });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the webhook URL from DISCORD_WEBHOOK_URL", () => {
    const notifier = DiscordNotifier.fromEnv({
      DISCORD_WEBHOOK_URL: WEBHOOK_URL,
    });
    expect(notifier.enabled).toBe(true);
  });

  it("treats a blank URL as unset", () => {
    const notifier = DiscordNotifier.fromEnv({ DISCORD_WEBHOOK_URL: "  " });
    expect(notifier.enabled).toBe(false);
  });

  it("logs the disabled warning only once", async () => {
    vi.resetModules();
    const { DiscordNotifier: FreshNotifier } = await import(
      "../src/notify/discord.js"
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      FreshNotifier.fromEnv({});
      FreshNotifier.fromEnv({});
      FreshNotifier.fromEnv({
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/EXAMPLE",
      });
      const disabledWarnings = warn.mock.calls.filter(([msg]) =>
        String(msg).includes("DISCORD_WEBHOOK_URL"),
      );
      expect(disabledWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("DiscordNotifier.notify", () => {
  function enabledNotifier(): DiscordNotifier {
    return DiscordNotifier.fromEnv({ DISCORD_WEBHOOK_URL: WEBHOOK_URL });
  }

  it("posts a repair_started embed", async () => {
    await enabledNotifier().notify({ kind: "repair_started", job: jobRef() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    const embed = lastPayload().embeds[0];
    expect(embed.title).toMatch(/repair started/i);
    expect(embed.color).toBe(0x5865f2);
    const fields = Object.fromEntries(
      embed.fields.map((f: { name: string; value: string }) => [f.name, f.value]),
    );
    expect(fields["Job"]).toBe("job-1");
    expect(fields["Repository"]).toBe("my-app");
    expect(fields["Issue"]).toBe("bugsink:issue-1");
  });

  it("posts a pr_created embed containing the PR URL", async () => {
    const prUrl = "https://github.com/o/r/pull/42";
    await enabledNotifier().notify({
      kind: "pr_created",
      job: jobRef(),
      prUrl,
    });
    const embed = lastPayload().embeds[0];
    expect(embed.color).toBe(0x57f287);
    expect(JSON.stringify(embed)).toContain(prUrl);
  });

  it("posts a pr_created embed even when the PR URL is missing", async () => {
    await enabledNotifier().notify({ kind: "pr_created", job: jobRef() });
    const embed = lastPayload().embeds[0];
    expect(embed.color).toBe(0x57f287);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts a repair_failed embed containing the reason", async () => {
    await enabledNotifier().notify({
      kind: "repair_failed",
      job: jobRef(),
      reason: "Clone failed: connection reset",
    });
    const embed = lastPayload().embeds[0];
    expect(embed.color).toBe(0xed4245);
    expect(JSON.stringify(embed)).toContain("Clone failed: connection reset");
  });

  it("posts a needs_review embed containing the note", async () => {
    await enabledNotifier().notify({
      kind: "needs_review",
      job: jobRef(),
      note: "could not reproduce",
    });
    const embed = lastPayload().embeds[0];
    expect(embed.color).toBe(0xfee75c);
    expect(JSON.stringify(embed)).toContain("could not reproduce");
  });

  it("redacts secret-looking values from failure reasons", async () => {
    await enabledNotifier().notify({
      kind: "repair_failed",
      job: jobRef(),
      reason: "deploy failed with token=ghp_abcdefghij1234567890",
    });
    const text = JSON.stringify(lastPayload());
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("ghp_abcdefghij1234567890");
  });

  it("never throws when the webhook POST rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      enabledNotifier().notify({ kind: "repair_started", job: jobRef() }),
    ).resolves.toBeUndefined();
  });

  it("never throws on a non-OK webhook response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(
      enabledNotifier().notify({ kind: "repair_started", job: jobRef() }),
    ).resolves.toBeUndefined();
  });
});

describe("JobQueue Discord wiring", () => {
  function fakeNotifier(): JobNotifier & { events: DiscordEvent[] } {
    const events: DiscordEvent[] = [];
    return {
      events,
      notify: async (event: DiscordEvent) => {
        events.push(event);
      },
    };
  }

  it("notifies on repair start and on PR creation with the PR URL", async () => {
    const store = new JobStore();
    const notifier = fakeNotifier();
    const queue = new JobQueue(
      store,
      async (_job, update) => {
        update("PR_CREATED", { prUrl: "https://github.com/o/r/pull/7" });
      },
      1,
      notifier,
    );
    queue.enqueue(makeJob("7"));
    await tick(100);

    const kinds = notifier.events.map((e) => e.kind);
    expect(kinds).toEqual(["repair_started", "pr_created"]);
    const prEvent = notifier.events[1];
    expect(prEvent.kind).toBe("pr_created");
    if (prEvent.kind === "pr_created") {
      expect(prEvent.prUrl).toBe("https://github.com/o/r/pull/7");
      expect(prEvent.job.id).toBe("job-7");
    }
  });

  it("notifies with the failure reason when the handler throws", async () => {
    const store = new JobStore();
    const notifier = fakeNotifier();
    const queue = new JobQueue(
      store,
      async () => {
        throw new Error("docker exploded");
      },
      1,
      notifier,
    );
    queue.enqueue(makeJob("8"));
    await tick(100);

    const kinds = notifier.events.map((e) => e.kind);
    expect(kinds).toEqual(["repair_started", "repair_failed"]);
    const failEvent = notifier.events[1];
    expect(failEvent.kind).toBe("repair_failed");
    if (failEvent.kind === "repair_failed") {
      expect(failEvent.reason).toContain("docker exploded");
    }
  });

  it("notifies when the handler marks the job as needing human review", async () => {
    const store = new JobStore();
    const notifier = fakeNotifier();
    const queue = new JobQueue(
      store,
      async (_job, update) => {
        update("NEEDS_HUMAN_REVIEW", { note: "no repro" });
      },
      1,
      notifier,
    );
    queue.enqueue(makeJob("9"));
    await tick(100);

    const kinds = notifier.events.map((e) => e.kind);
    expect(kinds).toEqual(["repair_started", "needs_review"]);
  });

  it("sends no notifications without a notifier", async () => {
    const store = new JobStore();
    const queue = new JobQueue(store, async (_job, update) => {
      update("PR_CREATED", { prUrl: "https://github.com/o/r/pull/1" });
    });
    // Must not throw even though a PR was "created".
    queue.enqueue(makeJob("10"));
    await tick(100);
    expect(store.get("job-10")?.status).toBe("PR_CREATED");
  });
});
