import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, resolveStore } from "../src/server.js";
import type { PostgresJobStore } from "../src/db/postgres.js";
import type { JobNotifier } from "../src/notify/discord.js";

describe("resolveStore", () => {
  it("returns undefined when DATABASE_URL is unset", async () => {
    const connect = vi.fn(
      async (_url: string): Promise<PostgresJobStore> => {
        throw new Error("must not connect");
      },
    );
    const store = await resolveStore(undefined, { connect });
    expect(store).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects to Postgres when DATABASE_URL is set", async () => {
    const fake = {} as PostgresJobStore;
    const connect = vi.fn(async (_url: string) => fake);
    const store = await resolveStore("postgres://db:5432/fixloop", {
      connect,
    });
    expect(store).toBe(fake);
    expect(connect).toHaveBeenCalledWith(
      "postgres://db:5432/fixloop",
      undefined,
    );
  });

  it("passes the notifier through to connect for restart reports", async () => {
    const fake = {} as PostgresJobStore;
    const connect = vi.fn(async (_url: string, _notifier?: JobNotifier) => fake);
    const notifier = { notify: async () => {} } as JobNotifier;
    const store = await resolveStore("postgres://db:5432/fixloop", {
      connect,
      notifier,
    });
    expect(store).toBe(fake);
    expect(connect).toHaveBeenCalledWith(
      "postgres://db:5432/fixloop",
      notifier,
    );
  });

  it("logs the error and exits 1 when Postgres is unreachable", async () => {
    const connect = vi.fn(
      async (_url: string): Promise<PostgresJobStore> => {
        throw new Error("connect ECONNREFUSED");
      },
    );
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit(${code})`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        resolveStore("postgres://db:5432/fixloop", { connect, exit }),
      ).rejects.toThrow("exit(1)");
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to initialize Postgres job store"),
      );
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      error.mockRestore();
    }
  });

  it("throws instead of silently booting in-memory when the injected exit() returns", async () => {
    // deps.exit is typed never, but a test double (or a future runtime)
    // may return: falling through would boot the in-memory store after a
    // Postgres failure, silently losing the operator's database.
    const connect = vi.fn(
      async (_url: string): Promise<PostgresJobStore> => {
        throw new Error("connect ECONNREFUSED");
      },
    );
    const exit = vi.fn((_code: number): never => undefined as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        resolveStore("postgres://db:5432/fixloop", { connect, exit }),
      ).rejects.toThrow(/refusing to boot/i);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      error.mockRestore();
    }
  });

  it("registers graceful shutdown handlers on the in-memory path", async () => {
    // Regression: only the Postgres branch called registerShutdown(), so
    // SIGTERM killed in-memory boots mid-repair instead of quiescing the
    // queue and stopping HTTP.
    const dir = mkdtempSync(join(tmpdir(), "fixloop-main-shutdown-"));
    writeFileSync(join(dir, "fixloop.config.yaml"), "repositories: {}\n");
    const prevEnv = {
      FIXLOOP_CONFIG: process.env.FIXLOOP_CONFIG,
      FIXLOOP_PORT: process.env.FIXLOOP_PORT,
      DATABASE_URL: process.env.DATABASE_URL,
      FIXLOOP_WEBHOOK_SECRET: process.env.FIXLOOP_WEBHOOK_SECRET,
    };
    process.env.FIXLOOP_CONFIG = join(dir, "fixloop.config.yaml");
    process.env.FIXLOOP_PORT = "0";
    delete process.env.DATABASE_URL;
    process.env.FIXLOOP_WEBHOOK_SECRET = "test-secret";
    const on = vi.spyOn(process, "on");
    try {
      const app = await main({});
      try {
        const signals = on.mock.calls.map((call) => String(call[0]));
        expect(signals).toContain("SIGTERM");
        expect(signals).toContain("SIGINT");
      } finally {
        await app.close();
      }
      // Detach the real signal handlers this registered: their shutdown
      // closure ends in process.exit, which must not fire during tests.
      for (const call of on.mock.calls) {
        const signal = String(call[0]);
        if (signal === "SIGTERM" || signal === "SIGINT") {
          process.removeListener(
            signal,
            call[1] as (...args: never[]) => void,
          );
        }
      }
    } finally {
      on.mockRestore();
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("main()", () => {
  it("threads deps.handleJob into the queue on the in-memory path", async () => {
    // Regression test: main() used to drop deps.handleJob when
    // DATABASE_URL was unset, silently running stubHandler instead of the
    // supplied handler.
    const dir = mkdtempSync(join(tmpdir(), "fixloop-main-"));
    writeFileSync(
      join(dir, "fixloop.config.yaml"),
      [
        "repositories:",
        "  my-app:",
        "    providerProject: my-app",
        '    github: { repository: "my-user/my-app", defaultBranch: "main" }',
        "    commands:",
        '      install: "true"',
        '      test: "true"',
        "",
      ].join("\n"),
    );
    const prevEnv = {
      FIXLOOP_CONFIG: process.env.FIXLOOP_CONFIG,
      FIXLOOP_PORT: process.env.FIXLOOP_PORT,
      DATABASE_URL: process.env.DATABASE_URL,
      FIXLOOP_WEBHOOK_SECRET: process.env.FIXLOOP_WEBHOOK_SECRET,
    };
    process.env.FIXLOOP_CONFIG = join(dir, "fixloop.config.yaml");
    process.env.FIXLOOP_PORT = "0";
    delete process.env.DATABASE_URL;
    process.env.FIXLOOP_WEBHOOK_SECRET = "test-secret";
    try {
      const app = await main({
        handleJob: async (_job, update) => {
          update("PR_CREATED", { prUrl: "https://example.com/custom-handler" });
        },
      });
      try {
        const address = app.server.address();
        const port =
          typeof address === "object" && address !== null ? address.port : 0;
        expect(port).toBeGreaterThan(0);
        const res = await fetch(`http://127.0.0.1:${port}/webhooks/bugsink`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-fixloop-webhook-token": "test-secret",
          },
          body: JSON.stringify({
            id: "497f6eca-6276-4993-bfeb-53cbbbba6f08",
            calculated_type: "ValueError",
            calculated_value: "invalid literal for int()",
            title: "ValueError: invalid literal for int()",
            project_name: "my-app",
            url: "https://bugsink.example.com/issues/497f6eca-6276-4993-bfeb-53cbbbba6f08/",
            alert_reason: "NEW_ISSUE",
          }),
        });
        expect(res.status).toBe(202);
        await vi.waitFor(async () => {
          const jobsRes = await fetch(`http://127.0.0.1:${port}/jobs`, {
            headers: { "x-fixloop-webhook-token": "test-secret" },
          });
          const jobs = (await jobsRes.json()) as Array<{ prUrl?: string }>;
          expect(jobs[0]?.prUrl).toBe("https://example.com/custom-handler");
        });
      } finally {
        await app.close();
      }
    } finally {
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("warns once at startup when Discord notifications are disabled", async () => {
    // The per-instance constructor warning moved to main(): production
    // builds exactly one notifier here, so the operator gets one line,
    // and throwaway instances in tests stay quiet.
    const dir = mkdtempSync(join(tmpdir(), "fixloop-main-warn-"));
    writeFileSync(join(dir, "fixloop.config.yaml"), "repositories: {}\n");
    const prevEnv = {
      FIXLOOP_CONFIG: process.env.FIXLOOP_CONFIG,
      FIXLOOP_PORT: process.env.FIXLOOP_PORT,
      DATABASE_URL: process.env.DATABASE_URL,
      DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    };
    process.env.FIXLOOP_CONFIG = join(dir, "fixloop.config.yaml");
    process.env.FIXLOOP_PORT = "0";
    delete process.env.DATABASE_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const app = await main({});
      try {
        const disabledWarnings = warn.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes("DISCORD_WEBHOOK_URL"));
        expect(disabledWarnings).toHaveLength(1);
      } finally {
        await app.close();
      }
    } finally {
      warn.mockRestore();
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
