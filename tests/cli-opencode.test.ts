import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  buildOpencodeJson,
  getAiProvider,
  validateApiKey,
  validateModel,
  verifyOpencode,
  type ContainerRunner,
} from "../src/cli/opencode.js";

const KEY = "sk-ant-test-key-123";

function fakeRunner(
  behavior: "ok" | "no-opencode" | "bad-key",
): ContainerRunner {
  return {
    async runContainer(image, command, opts) {
      void image;
      void opts;
      if (command[0] === "opencode" && command[1] === "--version") {
        if (behavior === "no-opencode") {
          return { exitCode: 127, stdout: "", stderr: "opencode: not found", timedOut: false };
        }
        return { exitCode: 0, stdout: "opencode 1.2.3\n", stderr: "", timedOut: false };
      }
      // The tiny probe.
      if (behavior === "bad-key") {
        return { exitCode: 1, stdout: "", stderr: "401 Unauthorized", timedOut: false };
      }
      return { exitCode: 0, stdout: "OK\n", stderr: "", timedOut: false };
    },
  };
}

describe("AI_PROVIDERS", () => {
  it("uses the documented OpenCode environment variable names", () => {
    const vars: Record<string, string> = Object.fromEntries(
      AI_PROVIDERS.map((p) => [p.id, p.envVar]),
    );
    expect(vars["anthropic"]).toBe("ANTHROPIC_API_KEY");
    expect(vars["openai"]).toBe("OPENAI_API_KEY");
    expect(vars["openrouter"]).toBe("OPENROUTER_API_KEY");
  });

  it("marks Z.AI and OpenAI-compatible as needing an opencode.json snippet", () => {
    expect(getAiProvider("zai").builtin).toBe(false);
    expect(getAiProvider("openai-compatible").builtin).toBe(false);
    expect(getAiProvider("anthropic").builtin).toBe(true);
  });

  it("prefills the Z.AI coding endpoint but leaves it editable", () => {
    const zai = getAiProvider("zai");
    expect(zai.baseUrlDefault).toContain("z.ai");
  });
});

describe("buildOpencodeJson", () => {
  it("references the key via {env:VAR}, never embedding the secret", () => {
    const json = buildOpencodeJson(getAiProvider("zai"), "https://api.z.ai/api/coding/paas/v4");
    expect(json).toContain("{env:ZAI_API_KEY}");
    expect(json).toContain("https://api.z.ai/api/coding/paas/v4");
    expect(json).not.toContain(KEY);
  });

  it("returns undefined for builtin providers", () => {
    expect(buildOpencodeJson(getAiProvider("anthropic"), "")).toBeUndefined();
  });
});

describe("validateApiKey / validateModel", () => {
  it("rejects empty keys", () => {
    expect(validateApiKey("   ")).not.toBe(true);
    expect(validateApiKey("sk-ant-123")).toBe(true);
  });

  it("rejects empty model ids", () => {
    expect(validateModel("")).not.toBe(true);
    expect(validateModel("anthropic/claude-sonnet-4-5")).toBe(true);
  });
});

describe("verifyOpencode", () => {
  const base = { image: "fixloop-runner:latest", model: "anthropic/claude-sonnet-4-5", apiKey: KEY, provider: getAiProvider("anthropic") };

  it("passes all checks when opencode and the probe succeed", async () => {
    const result = await verifyOpencode({ ...base, runner: fakeRunner("ok") });
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "OpenCode available",
      "Provider credentials valid",
      "Model reachable",
    ]);
  });

  it("fails fast when opencode is not installed in the image", async () => {
    const result = await verifyOpencode({ ...base, runner: fakeRunner("no-opencode") });
    expect(result.ok).toBe(false);
    expect(result.checks[0].ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/opencode/i);
  });

  it("reports bad credentials without leaking the key", async () => {
    const result = await verifyOpencode({ ...base, runner: fakeRunner("bad-key") });
    expect(result.ok).toBe(false);
    const creds = result.checks.find((c) => c.name === "Provider credentials valid")!;
    expect(creds.ok).toBe(false);
    for (const c of result.checks) {
      expect(JSON.stringify(c)).not.toContain(KEY);
    }
  });
});
