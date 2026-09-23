import { describe, expect, it } from "vitest";
import { buildServer, FIXLOOP_VERSION } from "../src/server.js";

describe("GET /health", () => {
  it("returns ok and the service version", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: FIXLOOP_VERSION });
  });
});
