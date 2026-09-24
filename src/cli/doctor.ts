import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DockerRunner } from "../docker/runner.js";
import {
  AI_PROVIDER_ENV,
  CONFIG_FILE,
  ENV_FILE,
  parseEnv,
} from "./config-files.js";
import {
  adaptDockerRunner,
  validateRunner,
  type RunnerDocker,
} from "./docker-check.js";
import {
  createGitHubApi,
  verifyGitHub,
  type GitHubApi,
} from "./github.js";
import { getAiProvider, verifyOpencode } from "./opencode.js";
import {
  checkDocker,
  detectSystem,
  formatSystemLine,
  systemRunner,
  type Check,
  type CommandRunner,
} from "./preflight.js";
import {
  validatePublicUrl,
  webhookUrlFor,
} from "./providers.js";
import { loadConfig, type FixLoopConfig } from "../config/config.js";
import { scrubSecrets } from "./redact.js";
import { renderChecks } from "./ui.js";

export interface HttpResponse {
  ok: boolean;
  status: number;
}

export interface HttpClient {
  (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<HttpResponse>;
}

const defaultHttp: HttpClient = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status };
};

export interface DoctorDeps {
  dir?: string;
  commandRunner?: CommandRunner;
  docker?: RunnerDocker;
  createGitHubApi?: (token: string) => GitHubApi;
  output?: (line: string) => void;
  http?: HttpClient;
  /** Read env from here instead of process.env (tests). */
  env?: Record<string, string | undefined>;
  /** Run the live AI probe (costs a few tokens). Default false. */
  probeAi?: boolean;
}

export interface DoctorResult {
  ok: boolean;
  checks: Check[];
}

/**
 * Diagnose a FixLoop installation. Read-only by design: it never writes
 * files, creates branches/PRs, changes provider settings, or runs repairs.
 * Secrets are checked by name only and never printed.
 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  const dir = deps.dir ?? process.cwd();
  const commandRunner = deps.commandRunner ?? systemRunner;
  const docker = deps.docker ?? adaptDockerRunner(new DockerRunner());
  const githubFactory = deps.createGitHubApi ?? createGitHubApi;
  const out = deps.output ?? ((line: string) => console.log(line));
  const http = deps.http ?? defaultHttp;
  const env = deps.env ?? process.env;

  const checks: Check[] = [];
  const secretValues: string[] = [];
  const say = (line: string): void => {
    out(scrubSecrets(line, secretValues));
  };

  say("FixLoop Doctor");
  say("");

  // 1. System (informational).
  const info = await detectSystem(commandRunner);
  checks.push({ name: "System", ok: true, detail: formatSystemLine(info) });

  // 2. Configuration file.
  let config: FixLoopConfig | undefined;
  const configPath = join(dir, CONFIG_FILE);
  if (!existsSync(configPath)) {
    checks.push({
      name: "Configuration",
      ok: false,
      hint: `No ${CONFIG_FILE} in ${dir}. Run: fixloop setup`,
    });
  } else {
    try {
      config = loadConfig(configPath);
      checks.push({ name: "Configuration", ok: true, detail: configPath });
    } catch (err) {
      checks.push({
        name: "Configuration",
        ok: false,
        hint: `Could not parse ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}. Run: fixloop setup`,
      });
    }
  }

  // 3. Repositories configured.
  const repos = config ? Object.values(config.repositories) : [];
  if (config) {
    checks.push(
      repos.length > 0
        ? {
            name: "Repositories",
            ok: true,
            detail: repos.map((r) => r.github.repository).join(", "),
          }
        : {
            name: "Repositories",
            ok: false,
            hint: "No repositories configured. Run: fixloop setup",
          },
    );
  }

  // 4. Required secrets (names only; values stay in memory for scrubbing).
  const envPath = join(dir, ENV_FILE);
  const envFile = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
  const secretValue = (name: string): string | undefined =>
    envFile[name] ?? env[name];
  const requiredSecrets = ["FIXLOOP_WEBHOOK_SECRET", "GITHUB_TOKEN"];
  const aiEnvVar = config?.aiProvider ? AI_PROVIDER_ENV[config.aiProvider] : undefined;
  if (aiEnvVar) requiredSecrets.push(aiEnvVar);
  const missing = requiredSecrets.filter((name) => {
    const v = secretValue(name);
    if (v) secretValues.push(v);
    return !v || v.trim() === "";
  });
  checks.push(
    missing.length === 0
      ? {
          name: "Required secrets",
          ok: true,
          detail: requiredSecrets.join(", "),
        }
      : {
          name: "Required secrets",
          ok: false,
          hint: `Missing: ${missing.join(", ")}. Set them in ${envPath} or re-run: fixloop setup`,
        },
  );

  // 5. Public URL + webhook URL construction.
  let webhookUrl: string | undefined;
  if (config?.publicUrl) {
    const valid = validatePublicUrl(config.publicUrl);
    if (valid === true && config.provider) {
      webhookUrl = webhookUrlFor(config.publicUrl, config.provider);
      checks.push({
        name: "Webhook URL",
        ok: true,
        detail: webhookUrl,
      });
    } else {
      checks.push({
        name: "Webhook URL",
        ok: false,
        hint:
          valid === true
            ? "No error provider configured. Run: fixloop setup"
            : `Invalid publicUrl in ${CONFIG_FILE}: ${valid}`,
      });
    }
  }

  // 6. GitHub (read-only verification: no branches, no PRs).
  const githubToken = secretValue("GITHUB_TOKEN");
  const firstRepo = repos[0]?.github.repository;
  if (githubToken && firstRepo) {
    try {
      const verification = await verifyGitHub(githubToken, firstRepo, githubFactory(githubToken));
      checks.push({
        name: "GitHub",
        ok: verification.ok,
        detail: verification.ok ? `${firstRepo} (auth, access, push/PR capability)` : undefined,
        hint: verification.ok
          ? undefined
          : verification.checks
              .filter((c) => !c.ok && c.hint)
              .map((c) => c.hint)
              .join(" "),
      });
    } catch (err) {
      checks.push({
        name: "GitHub",
        ok: false,
        hint: `GitHub check failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else if (config) {
    checks.push({
      name: "GitHub",
      ok: false,
      hint: "Skipped: GitHub token or repository is not configured. Run: fixloop setup",
    });
  }

  // 7. Webhook endpoint: an empty POST must get a real HTTP answer.
  // 401/400/202 all prove the route is alive; 404 means it is not wired.
  if (webhookUrl) {
    try {
      const res = await http(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      checks.push(
        res.status === 404
          ? {
              name: "Webhook endpoint",
              ok: false,
              hint: `POST ${webhookUrl} returned 404 — the webhook route is not registered. Check the provider id in ${CONFIG_FILE}.`,
            }
          : {
              name: "Webhook endpoint",
              ok: true,
              detail: `HTTP ${res.status}`,
            },
      );
    } catch {
      checks.push({
        name: "Webhook endpoint",
        ok: false,
        hint: `Could not reach ${webhookUrl}. Is FixLoop running and is the public URL correct?`,
      });
    }
  }

  // 8. Docker + runner image.
  const dockerCheck = await checkDocker(commandRunner);
  checks.push({ name: "Docker", ok: dockerCheck.ok, detail: dockerCheck.detail, hint: dockerCheck.hint });
  const runnerImage = config?.runnerImage;
  if (dockerCheck.ok && runnerImage) {
    try {
      const validation = await validateRunner({ docker, image: runnerImage });
      checks.push({
        name: "Runner image",
        ok: validation.ok,
        detail: validation.ok ? runnerImage : undefined,
        hint: validation.ok
          ? undefined
          : validation.checks
              .filter((c) => !c.ok && c.hint)
              .map((c) => c.hint)
              .join(" "),
      });
    } catch (err) {
      checks.push({
        name: "Runner image",
        ok: false,
        hint: `Runner validation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else if (config) {
    checks.push({
      name: "Runner image",
      ok: false,
      hint: dockerCheck.ok
        ? `No runnerImage in ${CONFIG_FILE}. Run: fixloop setup`
        : "Skipped: Docker is not available.",
    });
  }

  // 9. API health (local).
  const port = envFile["FIXLOOP_PORT"] ?? env["FIXLOOP_PORT"] ?? "3000";
  try {
    const res = await http(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    checks.push(
      res.ok
        ? { name: "API health", ok: true, detail: `http://127.0.0.1:${port}/health` }
        : {
            name: "API health",
            ok: false,
            hint: `GET /health returned HTTP ${res.status}. Check the FixLoop logs.`,
          },
    );
  } catch {
    checks.push({
      name: "API health",
      ok: false,
      hint: `FixLoop is not answering on port ${port}. Start it, then re-run: fixloop doctor`,
    });
  }

  // 10. Optional live AI probe (costs a few tokens).
  if (deps.probeAi && config?.aiProvider && runnerImage && dockerCheck.ok) {
    const aiKey = aiEnvVar ? secretValue(aiEnvVar) : undefined;
    if (aiKey && config.model) {
      try {
        const probe = await verifyOpencode({
          runner: { runContainer: (img, cmd, o) => docker.run(img, cmd, o) },
          image: runnerImage,
          provider: getAiProvider(config.aiProvider),
          apiKey: aiKey,
          model: config.model,
        });
        checks.push({
          name: "AI probe",
          ok: probe.ok,
          detail: probe.ok ? config.model : undefined,
          hint: probe.ok
            ? undefined
            : probe.checks
                .filter((c) => !c.ok && c.hint)
                .map((c) => c.hint)
                .join(" "),
        });
      } catch (err) {
        checks.push({
          name: "AI probe",
          ok: false,
          hint: `AI probe failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  for (const line of renderChecks(checks)) say(line);
  say("");
  const ok = checks.every((c) => c.ok);
  say(ok ? "All checks passed." : "Some checks failed. See the hints above.");
  return { ok, checks };
}
