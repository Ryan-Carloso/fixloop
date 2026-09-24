import { describe, expect, it } from "vitest";
import {
  FakePrompter,
  type Prompter,
} from "../src/cli/prompts.js";
import {
  assertNoSecrets,
  containsSecret,
  maskSecret,
  redactSecrets,
} from "../src/cli/redact.js";

describe("FakePrompter", () => {
  it("returns queued answers in order", async () => {
    const prompter: Prompter = new FakePrompter(["bugsink", "yes"]);
    expect(await prompter.select("provider?", [{ value: "bugsink" }])).toBe(
      "bugsink",
    );
    expect(await prompter.confirm("save?")).toBe(true);
  });

  it("parses yes/no answers for confirm", async () => {
    const p = new FakePrompter(["n"]);
    expect(await p.confirm("save?")).toBe(false);
  });

  it("throws when the answer queue is empty", async () => {
    const p = new FakePrompter([]);
    await expect(p.input("name?")).rejects.toThrow(/no more queued answers/);
  });

  it("records asked questions for assertions", async () => {
    const p = new FakePrompter(["x"]);
    await p.input("Your name?");
    expect(p.asked[0]).toContain("Your name?");
  });

  it("never echoes password answers into the asked log", async () => {
    const p = new FakePrompter(["sk-super-secret-value"]);
    await p.password("API key");
    expect(p.asked.join("\n")).not.toContain("sk-super-secret-value");
  });
});

describe("secret redaction", () => {
  it("redactSecrets removes API keys from text", () => {
    const out = redactSecrets(
      "failed with key sk-abc123def456ghi789 in the message",
    );
    expect(out).not.toContain("sk-abc123");
    expect(out).toContain("[REDACTED]");
  });

  it("maskSecret never contains the secret", () => {
    const secret = "sk-super-secret-value";
    const masked = maskSecret(secret);
    expect(masked).not.toContain(secret);
    expect(masked.length).toBeGreaterThan(0);
  });

  it("containsSecret detects a leaked secret", () => {
    expect(containsSecret("token=abc123", ["abc123"])).toBe(true);
    expect(containsSecret("nothing here", ["abc123"])).toBe(false);
  });

  it("assertNoSecrets throws when a secret leaks", () => {
    expect(() => assertNoSecrets("key is sk-abc", ["sk-abc"])).toThrow(
      /secret leaked/,
    );
    expect(() => assertNoSecrets("clean output", ["sk-abc"])).not.toThrow();
  });
});
