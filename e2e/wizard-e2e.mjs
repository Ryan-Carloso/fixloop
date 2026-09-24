/**
 * E2E: scripted `fixloop setup` in a clean disposable environment, then
 * `fixloop doctor`, `fixloop status`, and `fixloop test` against the result.
 *
 * External services are test-doubled (Docker daemon, GitHub API, AI provider)
 * per the project's testing strategy; everything else is real: file writes,
 * the real FixLoop server booted by the wizard, and real HTTP for
 * doctor/smoke checks.
 *
 * Run: node e2e/wizard-e2e.mjs
 * Evidence (scrubbed of secrets) is written to e2e/evidence.log.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "../dist/cli/setup.js";
import { runDoctor } from "../dist/cli/doctor.js";
import { runStatus } from "../dist/cli/status.js";
import { runSmokeTest } from "../dist/cli/smoke.js";
import { FakePrompter } from "../dist/cli/prompts.js";
import { systemRunner } from "../dist/cli/preflight.js";

const E2E_WEBHOOK_SECRET = "e2e-webhook-secret-abcdef123456";
const E2E_GITHUB_TOKEN = "ghp_e2efaketoken123";
const E2E_AI_KEY = "sk-ant-e2efakekey-123";
const SECRETS = [E2E_WEBHOOK_SECRET, E2E_GITHUB_TOKEN, E2E_AI_KEY];
const PORT = "4100";

process.env.FIXLOOP_PORT = PORT;

const lines = [];
const capture = (l) => lines.push(l);

function fakeCommandRunner() {
  return {
    run: async (cmd, args) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "Docker version 99.0.0", stderr: "" };
      return systemRunner.run(cmd, args);
    },
  };
}

function fakeDocker() {
  return {
    async run(_image, command) {
      const [cmd, ...args] = command;
      if (cmd === "id") return { exitCode: 0, stdout: "1000\n", stderr: "", timedOut: false };
      if (cmd === "git") return { exitCode: 0, stdout: "git version 2.45.0\n", stderr: "", timedOut: false };
      if (cmd === "opencode" && args[0] === "--version")
        return { exitCode: 0, stdout: "opencode 1.2.3\n", stderr: "", timedOut: false };
      if (cmd === "opencode" && args[0] === "run")
        return { exitCode: 0, stdout: "OK\n", stderr: "", timedOut: false };
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
    async start() {
      return "e2e-probe";
    },
    async remove() {},
    async exists() {
      return false;
    },
  };
}

function fakeGitHub() {
  return {
    async getAuthenticatedUser() {
      return { login: "octocat" };
    },
    async getRepository() {
      return { defaultBranch: "main", private: false, permissions: { push: true } };
    },
    async listRepositories() {
      return [{ fullName: "octocat/api", defaultBranch: "main" }];
    },
    async listRootFiles() {
      return ["pnpm-lock.yaml", "package.json"];
    },
  };
}

const dir = mkdtempSync(join(tmpdir(), "fixloop-e2e-"));
capture(`E2E dir: ${dir}`);
capture("");

const answers = [
  "bugsink", // provider
  "my-app", // BugSink project name
  true, // generate webhook token
  `http://127.0.0.1:${PORT}`, // public URL (points at the real local server)
  "token", // GitHub auth method
  E2E_GITHUB_TOKEN, // GitHub token
  "octocat/api", // repository
  true, // use detected commands
  "anthropic", // AI provider
  E2E_AI_KEY, // AI API key
  "anthropic/claude-sonnet-4-5", // model
  "fixloop-runner:latest", // runner image
  true, // run AI probe
  true, // save configuration
  true, // start FixLoop now (boots the REAL server)
];

capture("=== fixloop setup ===");
const setupResult = await runSetup({
  dir,
  prompter: new FakePrompter(answers),
  commandRunner: fakeCommandRunner(),
  docker: fakeDocker(),
  createGitHubApi: () => fakeGitHub(),
  output: capture,
  generateToken: () => E2E_WEBHOOK_SECRET,
});
capture(`setup result: saved=${setupResult.saved} cancelled=${setupResult.cancelled}`);
capture("");

if (!setupResult.saved) {
  capture("SETUP FAILED — aborting E2E");
} else {
  // Give the server a moment beyond the wizard's own health poll.
  await new Promise((r) => setTimeout(r, 1000));

  capture("=== fixloop doctor ===");
  const doctorResult = await runDoctor({
    dir,
    commandRunner: fakeCommandRunner(),
    docker: fakeDocker(),
    createGitHubApi: () => fakeGitHub(),
    output: capture,
  });
  capture(`doctor result: ok=${doctorResult.ok}`);
  capture("");

  capture("=== fixloop status ===");
  const statusResult = await runStatus({ dir, commandRunner: fakeCommandRunner(), output: capture });
  capture(`status result: ok=${statusResult.ok}`);
  capture("");

  capture("=== fixloop test ===");
  const smokeResult = await runSmokeTest({
    dir,
    output: capture,
    doctorDeps: {
      commandRunner: fakeCommandRunner(),
      docker: fakeDocker(),
      createGitHubApi: () => fakeGitHub(),
    },
  });
  capture(`smoke result: ok=${smokeResult.ok}`);
  capture("");

  const allOk = doctorResult.ok && statusResult.ok && smokeResult.ok;
  capture(allOk ? "E2E PASSED" : "E2E FAILED");
  process.exitCode = allOk ? 0 : 1;
}

// Scrub secrets from the evidence log, then stop the E2E server.
let evidence = lines.join("\n");
for (const s of SECRETS) evidence = evidence.split(s).join("***");
const evidencePath = new URL("./evidence.log", import.meta.url).pathname;
writeFileSync(evidencePath, evidence + "\n");
console.log(`Evidence written to ${evidencePath}`);
console.log(evidence);
rmSync(dir, { recursive: true, force: true });
