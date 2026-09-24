import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { CONFIG_FILE, ENV_FILE, parseEnv } from "./config-files.js";
import { runDoctor, type DoctorDeps } from "./doctor.js";
import { webhookUrlFor } from "./providers.js";
import { scrubSecrets } from "./redact.js";

export interface ProbeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type ProbeHttp = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<ProbeResponse>;

const defaultProbeHttp: ProbeHttp = (url, init) =>
  fetch(url, init) as unknown as Promise<ProbeResponse>;

export interface SmokeTestDeps {
  dir?: string;
  output?: (line: string) => void;
  http?: ProbeHttp;
  env?: Record<string, string | undefined>;
  doctorDeps?: Partial<DoctorDeps>;
}

/**
 * Safely exercise the installation end to end without side effects:
 * 1. doctor must pass,
 * 2. POST a well-formed webhook payload for an UNKNOWN project with the
 *    real webhook token. The server must accept the auth, parse the payload,
 *    find no repository mapping, and queue nothing (202, queued: false).
 * No fake bugs, no repairs, no PRs.
 */
export async function runSmokeTest(deps: SmokeTestDeps = {}): Promise<{ ok: boolean }> {
  const dir = deps.dir ?? process.cwd();
  const out = deps.output ?? ((line: string) => console.log(line));
  const http = deps.http ?? defaultProbeHttp;
  const env = deps.env ?? process.env;

  const secretValues: string[] = [];
  const say = (line: string): void => {
    out(scrubSecrets(line, secretValues));
  };

  say("FixLoop test");
  say("");

  // 1. Doctor first.
  const doctor = await runDoctor({
    dir,
    output: () => {},
    env,
    ...(deps.doctorDeps ?? {}),
  });
  if (!doctor.ok) {
    say("✗ Doctor found problems. Fix them before testing:");
    for (const c of doctor.checks.filter((x) => !x.ok)) {
      say(`  ✗ ${c.name}${c.hint ? ` — ${c.hint}` : ""}`);
    }
    return { ok: false };
  }
  say("✓ Doctor passed");

  // 2. Safe webhook probe.
  const config = loadConfig(join(dir, CONFIG_FILE));
  const envFile = existsSync(join(dir, ENV_FILE))
    ? parseEnv(readFileSync(join(dir, ENV_FILE), "utf8"))
    : {};
  const token = envFile["FIXLOOP_WEBHOOK_SECRET"] ?? env["FIXLOOP_WEBHOOK_SECRET"] ?? "";
  if (token) secretValues.push(token);
  if (!config.publicUrl || !config.provider || !token) {
    say("✗ Cannot probe: publicUrl, provider, or webhook secret is not configured.");
    return { ok: false };
  }
  const webhookUrl = webhookUrlFor(config.publicUrl, config.provider);
  say("Sending a safe probe event (unknown project — nothing will be queued)...");
  try {
    const res = await http(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fixloop-webhook-token": token,
      },
      body: JSON.stringify({
        id: "fixloop-smoke-probe",
        project_name: "fixloop-smoke-probe-unknown-project",
        title: "FixLoop smoke probe (safe, ignored)",
        calculated_type: "SmokeProbe",
        calculated_value: "probe",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      queued?: boolean;
      received?: boolean;
    };
    if (res.status === 202 && body.queued === false) {
      say("✓ Webhook probe accepted: auth OK, payload parsed, nothing queued (unknown project).");
      say("");
      say("FixLoop is working end to end. Send a real error event to trigger a repair.");
      return { ok: true };
    }
    if (res.status === 401) {
      say("✗ Probe rejected (401): the webhook token does not match the server's.");
      say("  Re-run: fixloop setup");
      return { ok: false };
    }
    say(`✗ Unexpected probe response: HTTP ${res.status}. Check the server logs.`);
    return { ok: false };
  } catch (err) {
    say(`✗ Could not reach ${webhookUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }
}
