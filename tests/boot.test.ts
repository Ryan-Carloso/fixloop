import { describe, expect, it, vi } from "vitest";
import { resolveStore } from "../src/server.js";
import type { PostgresJobStore } from "../src/db/postgres.js";

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
    expect(connect).toHaveBeenCalledWith("postgres://db:5432/fixloop");
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
});
