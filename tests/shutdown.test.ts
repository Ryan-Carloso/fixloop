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

  it("force-exits on a repeat signal while shutdown is in flight", async () => {
    // A hung beforeClose must not trap the operator: the second signal
    // force-exits instead of being swallowed.
    const exitCodes: number[] = [];
    const close = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50)); // slow flush
    });
    const handlers = new Map<string, () => void>();
    registerShutdown(
      { close },
      {
        onSignal: (signal, handler) => {
          handlers.set(signal, handler);
        },
        exit: (code) => {
          exitCodes.push(code);
        },
      },
    );
    handlers.get("SIGTERM")!();
    handlers.get("SIGTERM")!(); // repeat while in flight
    expect(exitCodes[0]).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not hang shutdown when beforeClose stalls", async () => {
    const close = vi.fn(async () => {});
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
        beforeClose: () => new Promise<void>(() => {}), // never resolves
        beforeCloseTimeoutMs: 50,
      },
    );
    handlers.get("SIGTERM")!();
    await new Promise((r) => setTimeout(r, 150));
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
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

  it("stops the HTTP server before flushing the store", async () => {
    const order: string[] = [];
    const close = vi.fn(async () => {
      order.push("close");
    });
    const beforeClose = vi.fn(async () => {
      order.push("beforeClose");
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
        beforeClose,
      },
    );
    handlers.get("SIGTERM")!();
    await new Promise((r) => setTimeout(r, 10));
    expect(beforeClose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["beforeClose", "close"]);
    expect(exitCode).toBe(0);
  });

  it("still flushes when beforeClose rejects", async () => {
    const close = vi.fn(async () => {});
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
        beforeClose: () => {
          throw new Error("server already closed");
        },
      },
    );
    handlers.get("SIGTERM")!();
    await new Promise((r) => setTimeout(r, 10));
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
  });

  it("clears the beforeClose timeout once the race settles", async () => {
    // Without the clear, the bound timer keeps the event loop alive for
    // the full timeout even after beforeClose finished fast (matters in
    // tests and any host that stubs exit instead of dying).
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const close = vi.fn(async () => {});
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
        beforeClose: async () => {}, // resolves immediately
        beforeCloseTimeoutMs: 30_000, // long bound: a leaked timer shows
      },
    );
    try {
      handlers.get("SIGTERM")!();
      await new Promise((r) => setTimeout(r, 20));
      expect(close).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(0);
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
    }
  });
});
