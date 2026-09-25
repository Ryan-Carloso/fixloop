import { describe, expect, it, vi } from "vitest";
import { makePool } from "../src/db/postgres.js";

// No pg mock here: this exercises the real pg.Pool (lazy — no
// connection is opened until the first query) to prove the idle-client
// 'error' listener is genuinely attached to a live EventEmitter.
describe("makePool (real pg.Pool)", () => {
  it("listens for idle-client errors and warns instead of crashing", async () => {
    const pool = makePool("postgres://localhost:5432/fixloop");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // An 'error' emitted with no listener would throw and kill the
      // process; the listener turns it into a warning.
      expect(pool.listenerCount("error")).toBe(1);
      pool.emit(
        "error",
        new Error("terminating connection due to administrator command"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("idle client connection error"),
      );
    } finally {
      warn.mockRestore();
      await pool.end();
    }
  });
});
