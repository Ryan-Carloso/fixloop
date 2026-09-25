import { describe, expect, it, vi } from "vitest";
import { registerShutdown } from "../src/server.js";

describe("registerShutdown", () => {
  function harness() {
    const close = vi.fn(async () => {});
    const handlers = new Map<string, () => void>();
    let exitCode: number | undefined;
    registerShutdown(
      { close },
      {
        onSignal: (signal, handler) => {
          handlers.set(signal, handler);
        },
        exit: (code) => {
          exitCode = code;
        },
      },
    );
    return { close, handlers, exitCode: () => exitCode };
  }

  it("closes the store and exits 0 on SIGTERM", async () => {
    const { close, handlers, exitCode } = harness();
    handlers.get("SIGTERM")!();
    await new Promise((r) => setTimeout(r, 10));
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCode()).toBe(0);
  });

  it("closes the store and exits 0 on SIGINT", async () => {
    const { close, handlers, exitCode } = harness();
    handlers.get("SIGINT")!();
    await new Promise((r) => setTimeout(r, 10));
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCode()).toBe(0);
  });

  it("ignores repeated signals while the flush is running", async () => {
    const { close, handlers, exitCode } = harness();
    handlers.get("SIGTERM")!();
    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    await new Promise((r) => setTimeout(r, 10));
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCode()).toBe(0);
  });

  it("still exits when close() rejects", async () => {
    const close = vi.fn(async () => {
      throw new Error("pool exploded");
    });
    let exitCode: number | undefined;
    const handlers = new Map<string, () => void>();
    registerShutdown(
      { close },
      {
        onSignal: (signal, handler) => {
          handlers.set(signal, handler);
        },
        exit: (code) => {
          exitCode = code;
        },
      },
    );
    handlers.get("SIGTERM")!();
    await new Promise((r) => setTimeout(r, 10));
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
  });
});
