import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { AI_PROVIDER_ENV, CONFIG_FILE, ENV_FILE, parseEnv } from "./config-files.js";
import { checkDocker, systemRunner, type CommandRunner } from "./preflight.js";
import { getProvider } from "./providers.js";
import { maskSecret, scrubSecrets } from "./redact.js";

export interface StatusDeps {
  dir?: string;
  commandRunner?: CommandRunner;
  output?: (line: string) => void;
  http?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean }>;
  env?: Record<string, string | undefined>;
}

/**
 * Concise, non-secret runtime/configuration status.
 * Never prints secret values — only masked placeholders.
 */
export async function runStatus(deps: StatusDeps = {}): Promise<{ ok: boolean }> {
  const dir = deps.dir ?? process.cwd();
  const commandRunner = deps.commandRunner ?? systemRunner;
  const out = deps.output ?? ((line: string) => console.log(line));
  const http = deps.http ?? (async (url: string, init?: { signal?: AbortSignal }) => {
    const res = await fetch(url, init);
    return { ok: res.ok };
  });
  const env = deps.env ?? process.env;

  const secretValues: string[] = [];
  const say = (line: string): void => {
    out(scrubSecrets(line, secretValues));
  };

  let ok = true;

  // Configuration.
  const configPath = join(dir, CONFIG_FILE);
  if (!existsSync(configPath)) {
    say(`Configuration: missing (${CONFIG_FILE} not found — run: fixloop setup)`);
    return { ok: false };
  }
  try {
    const config = loadConfig(configPath);
    const repos = Object.values(config.repositories);
    say(`Configuration: ${configPath}`);
    if (config.provider) {
      try {
        say(`  Provider: ${getProvider(config.provider).name}`);
      } catch {
        say(`  Provider: ${config.provider} (unknown id)`);
        ok = false;
      }
    }
    if (config.publicUrl) say(`  Public URL: ${config.publicUrl}`);
    say(
      `  Repositories: ${repos.length > 0 ? repos.map((r) => r.github.repository).join(", ") : "(none)"}`,
    );
    if (config.aiProvider) say(`  Coding agent: OpenCode · ${config.aiProvider} · ${config.model ?? "(no model)"}`);

    // Secrets: names + set/missing only.
    const envPath = join(dir, ENV_FILE);
    const envFile = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
    const names = ["FIXLOOP_WEBHOOK_SECRET", "GITHUB_TOKEN"];
    const aiEnvVar = config.aiProvider ? AI_PROVIDER_ENV[config.aiProvider] : undefined;
    if (aiEnvVar) names.push(aiEnvVar);
    for (const name of names) {
      const v = envFile[name] ?? env[name];
      if (v) secretValues.push(v);
      say(`  ${name}: ${v ? maskSecret(v) : "(missing)"}`);
      if (!v) ok = false;
    }
  } catch (err) {
    say(`Configuration: invalid — ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }

  // Docker daemon.
  const docker = await checkDocker(commandRunner);
  say(`Docker: ${docker.ok ? (docker.detail ?? "running") : "not available"}`);
  if (!docker.ok) ok = false;

  // API health.
  const port = env["FIXLOOP_PORT"] ?? "3000";
  try {
    const res = await http(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    say(`API: ${res.ok ? `healthy (port ${port})` : `unhealthy (port ${port})`}`);
    if (!res.ok) ok = false;
  } catch {
    say(`API: not running (port ${port})`);
    ok = false;
  }

  return { ok };
}
