import { redactSecrets } from "./redact.js";
import type { Check } from "./preflight.js";

export interface AiProviderDef {
  id: string;
  name: string;
  /**
   * Env var holding the API key. For builtin providers these are the
   * variable names OpenCode itself documents
   * (https://opencode.ai/docs/providers/).
   */
  envVar: string;
  /** Builtin providers need only the env var; others need an opencode.json snippet. */
  builtin: boolean;
  /** Prefilled base URL for OpenAI-compatible providers (user-editable). */
  baseUrlDefault?: string;
  /** Env var holding the base URL for non-builtin providers. */
  baseUrlEnvVar?: string;
  /** Example model id shown as the input placeholder. */
  exampleModel: string;
}

export const AI_PROVIDERS: AiProviderDef[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    builtin: true,
    exampleModel: "anthropic/claude-sonnet-4-5",
  },
  {
    id: "openai",
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    builtin: true,
    exampleModel: "openai/gpt-5",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    builtin: true,
    exampleModel: "openrouter/anthropic/claude-sonnet-4-5",
  },
  {
    id: "zai",
    name: "Z.AI",
    envVar: "ZAI_API_KEY",
    builtin: false,
    baseUrlDefault: "https://api.z.ai/api/coding/paas/v4",
    baseUrlEnvVar: "ZAI_BASE_URL",
    exampleModel: "zai/glm-5",
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible",
    envVar: "OPENAI_COMPATIBLE_API_KEY",
    builtin: false,
    baseUrlEnvVar: "OPENAI_COMPATIBLE_BASE_URL",
    exampleModel: "my-provider/my-model",
  },
];

export function getAiProvider(id: string): AiProviderDef {
  const p = AI_PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown AI provider: ${id}`);
  return p;
}

export function validateApiKey(value: string): true | string {
  return value.trim().length >= 8
    ? true
    : "Enter the API key (it should be at least 8 characters).";
}

export function validateModel(value: string): true | string {
  const v = value.trim();
  if (!v) return "Enter a model id, e.g. anthropic/claude-sonnet-4-5";
  if (/\s/.test(v)) return "The model id must not contain whitespace.";
  return true;
}

/**
 * opencode.json provider snippet for non-builtin providers.
 * The key is referenced as {env:VAR} — the secret itself never appears.
 */
export function buildOpencodeJson(
  provider: AiProviderDef,
  baseUrl: string,
): string | undefined {
  if (provider.builtin) return undefined;
  const config = {
    provider: {
      [provider.id]: {
        npm: "@ai-sdk/openai-compatible",
        name: provider.name,
        options: {
          baseURL: baseUrl || provider.baseUrlDefault || "",
          apiKey: `{env:${provider.envVar}}`,
        },
      },
    },
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/** Minimal container execution surface the probe needs (DockerRunner-compatible). */
export interface ContainerRunner {
  runContainer(
    image: string,
    command: string[],
    opts: { env?: Record<string, string>; network?: string; timeoutMs?: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;
}

export interface OpencodeVerification {
  ok: boolean;
  checks: Check[];
}

const PROBE_PROMPT = "Reply with exactly: OK";
const PROBE_TIMEOUT_MS = 90_000;

/**
 * Verify the coding-agent configuration with a tiny, inexpensive probe:
 * 1. opencode --version inside the runner image,
 * 2. one minimal `opencode run` proving the credentials work,
 * 3. the same probe proving the model id resolves.
 * Never a full autofix.
 */
export async function verifyOpencode(opts: {
  runner: ContainerRunner;
  image: string;
  provider: AiProviderDef;
  apiKey: string;
  baseUrl?: string;
  model: string;
}): Promise<OpencodeVerification> {
  const { runner, image, provider, apiKey, model } = opts;
  const checks: Check[] = [];

  const env: Record<string, string> = { [provider.envVar]: apiKey };
  if (!provider.builtin && provider.baseUrlEnvVar && opts.baseUrl) {
    env[provider.baseUrlEnvVar] = opts.baseUrl;
  }

  // 1. OpenCode installed in the runner image?
  try {
    const v = await runner.runContainer(image, ["opencode", "--version"], {
      timeoutMs: 30_000,
    });
    if (v.exitCode !== 0) throw new Error(v.stderr.trim() || "opencode --version failed");
    checks.push({
      name: "OpenCode available",
      ok: true,
      detail: `in runner image (${v.stdout.trim()})`,
    });
  } catch (err) {
    checks.push({
      name: "OpenCode available",
      ok: false,
      hint: `OpenCode is not installed in the runner image '${image}'. ${redactSecrets(err instanceof Error ? err.message : String(err))} Use an image with the OpenCode CLI installed.`,
    });
    return { ok: false, checks };
  }

  // 2+3. Tiny probe: credentials valid, model reachable.
  try {
    const probe = await runner.runContainer(
      image,
      ["opencode", "run", "--model", model, PROBE_PROMPT],
      { env, network: "bridge", timeoutMs: PROBE_TIMEOUT_MS },
    );
    const output = `${probe.stdout}\n${probe.stderr}`;
    if (probe.exitCode !== 0 || probe.timedOut) {
      const hint = /401|unauthorized|invalid.*key/i.test(output)
        ? "The provider rejected the API key (401/unauthorized). Check the key and try again."
        : /model/i.test(output)
          ? `The model id '${model}' was not accepted. Check the id and try again.`
          : `The probe request failed: ${redactSecrets(output.trim().slice(0, 300))}`;
      checks.push({ name: "Provider credentials valid", ok: false, hint });
      return { ok: false, checks };
    }
    checks.push({ name: "Provider credentials valid", ok: true });
    checks.push({
      name: "Model reachable",
      ok: true,
      detail: model,
    });
    return { ok: true, checks };
  } catch (err) {
    checks.push({
      name: "Provider credentials valid",
      ok: false,
      hint: `Probe failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
    });
    return { ok: false, checks };
  }
}
