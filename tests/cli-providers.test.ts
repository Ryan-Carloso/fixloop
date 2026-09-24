import { describe, expect, it } from "vitest";
import {
  ERROR_PROVIDERS,
  publicUrlWarning,
  selectableProviders,
  validatePublicUrl,
  webhookUrlFor,
  type ProviderSetupDefinition,
} from "../src/cli/providers.js";
import { BugSinkProvider } from "../src/providers/bugsink.js";
import type { ErrorProvider } from "../src/providers/error-provider.js";

describe("provider registry", () => {
  it("marks BugSink as the only supported provider", () => {
    const supported = ERROR_PROVIDERS.filter((p) => p.status === "supported");
    expect(supported.map((p) => p.id)).toEqual(["bugsink"]);
  });

  it("does not claim support for unimplemented providers", () => {
    for (const id of ["sentry", "bugsnag", "sentry-compatible"]) {
      const p = ERROR_PROVIDERS.find((x) => x.id === id) as ProviderSetupDefinition;
      expect(p, `registry entry for ${id}`).toBeDefined();
      expect(p.status).not.toBe("supported");
    }
  });

  it("every supported provider has a real runtime implementation", async () => {
    const impls: Record<string, new () => ErrorProvider> = {
      bugsink: BugSinkProvider,
    };
    for (const p of ERROR_PROVIDERS.filter((x) => x.status === "supported")) {
      const Ctor = impls[p.id];
      expect(Ctor, `${p.id} has a runtime implementation`).toBeDefined();
      const instance = new Ctor();
      expect(instance.name).toBe(p.id);
      // Smoke-test the implementation against a minimal payload.
      const ctx = await instance.parse({ id: "1", calculated_type: "E", calculated_value: "boom" });
      expect(ctx.provider).toBe(p.id);
    }
  });

  it("selectableProviders only offers supported providers; others are disabled", () => {
    const choices = selectableProviders();
    const bugsink = choices.find((c) => c.value === "bugsink");
    expect(bugsink?.disabled).toBeFalsy();
    for (const c of choices.filter((x) => x.value !== "bugsink")) {
      expect(c.disabled, `${c.value} is disabled`).toBeTruthy();
    }
  });
});

describe("webhook URL construction", () => {
  it("builds the provider webhook URL from the public URL", () => {
    expect(webhookUrlFor("https://fixloop.example.com", "bugsink")).toBe(
      "https://fixloop.example.com/webhooks/bugsink",
    );
  });

  it("strips a trailing slash from the public URL", () => {
    expect(webhookUrlFor("https://fixloop.example.com/", "bugsink")).toBe(
      "https://fixloop.example.com/webhooks/bugsink",
    );
  });
});

describe("validatePublicUrl", () => {
  it("accepts a valid https URL", () => {
    expect(validatePublicUrl("https://fixloop.example.com")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(validatePublicUrl("not a url")).not.toBe(true);
  });

  it("rejects URLs with paths that would break webhook routing", () => {
    const result = validatePublicUrl("https://example.com/fixloop/app");
    expect(result).not.toBe(true);
  });

  it("warns on plain http", () => {
    expect(validatePublicUrl("http://fixloop.example.com")).toBe(true);
    expect(publicUrlWarning("http://fixloop.example.com")).toMatch(/https/i);
    expect(publicUrlWarning("https://fixloop.example.com")).toBeUndefined();
  });
});
