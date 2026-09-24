import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DockerRunner } from "../docker/runner.js";
import {
  detectExisting,
  parseEnv,
  saveInstall,
  writeFileAtomic,
  type WizardConfig,
  type WizardSecrets,
} from "./config-files.js";
import {
  adaptDockerRunner,
  validateRunner,
  type RunnerDocker,
} from "./docker-check.js";
import {
  createGitHubApi,
  parseRepository,
  validateRepository,
  verifyGitHub,
  type GitHubApi,
} from "./github.js";
import {
  AI_PROVIDERS,
  buildOpencodeJson,
  getAiProvider,
  validateApiKey,
  validateModel,
  verifyOpencode,
} from "./opencode.js";
import { detectFromFiles } from "./package-manager.js";
import {
  checkDocker,
  checkGit,
  checkNodeVersion,
  detectSystem,
  formatSystemLine,
  systemRunner,
  type Check,
  type CommandRunner,
} from "./preflight.js";
import {
  getProvider,
  publicUrlWarning,
  selectableProviders,
  validatePublicUrl,
  webhookUrlFor,
} from "./providers.js";
import { PromptCancelled, type Prompter } from "./prompts.js";
import { InquirerPrompter } from "./prompts.js";
import { scrubSecrets } from "./redact.js";
import { renderChecks } from "./ui.js";

export interface SetupDeps {
  prompter?: Prompter;
  /** Install directory (defaults to the current working directory). */
  dir?: string;
  commandRunner?: CommandRunner;
  docker?: RunnerDocker;
  createGitHubApi?: (token: string) => GitHubApi;
  output?: (line: string) => void;
  generateToken?: () => string;
  /** Start the server after saving; injected in tests. */
  startServer?: (dir: string) => Promise<boolean>;
  /**
   * Skip the existing-config menu and go straight to updating
   * (used by `fixloop configure`).
   */
  assumeUpdate?: boolean;
}

export interface SetupResult {
  saved: boolean;
  cancelled: boolean;
  /** Set when the wizard hands off to `fixloop doctor` instead. */
  next?: "doctor";
  webhookUrl?: string;
  config?: WizardConfig;
}

const DEFAULT_RUNNER_IMAGE = "node:22";

async function askCommands(prompter: Prompter): Promise<WizardConfig["commands"]> {
  const install = await prompter.input("Install command:", {
    validate: (v) => (v.trim() ? true : "Enter the install command"),
  });
  const test = await prompter.input("Test command:", {
    validate: (v) => (v.trim() ? true : "Enter the test command"),
  });
  const lint = await prompter.input("Lint command (optional):", {});
  const typecheck = await prompter.input("Typecheck command (optional):", {});
  const commands: WizardConfig["commands"] = { install, test };
  if (lint.trim()) commands.lint = lint.trim();
  if (typecheck.trim()) commands.typecheck = typecheck.trim();
  return commands;
}

/** Default: spawn the FixLoop server next to this CLI and poll /health. */
async function defaultStartServer(dir: string): Promise<boolean> {
  // server.js lives next to the CLI's own dist output, not necessarily in dir.
  const serverJs = new URL("../server.js", import.meta.url).pathname;
  if (!existsSync(serverJs)) return false;
  const envPath = join(dir, ".env");
  const extra = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
  const child = spawn(process.execPath, [serverJs], {
    cwd: dir,
    env: { ...process.env, ...extra },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const port = extra["FIXLOOP_PORT"] ?? process.env["FIXLOOP_PORT"] ?? "3000";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function runSetup(deps: SetupDeps = {}): Promise<SetupResult> {
  const prompter = deps.prompter ?? new InquirerPrompter();
  const dir = deps.dir ?? process.cwd();
  const commandRunner = deps.commandRunner ?? systemRunner;
  const docker = deps.docker ?? adaptDockerRunner(new DockerRunner());
  const githubFactory = deps.createGitHubApi ?? createGitHubApi;
  const out = deps.output ?? ((line: string) => console.log(line));
  const generateToken = deps.generateToken ?? (() => randomBytes(32).toString("hex"));
  const startServer = deps.startServer ?? defaultStartServer;

  // Secrets collected during the wizard; output is scrubbed against them.
  const secrets: string[] = [];
  const say = (line: string): void => {
    out(scrubSecrets(line, secrets));
  };

  let saved = false;
  const fail = (message: string): SetupResult => {
    say(message);
    return { saved, cancelled: true };
  };

  try {
    // The interactive wizard needs a TTY; fail fast instead of hanging.
    if (!deps.prompter && !process.stdin.isTTY) {
      say("fixloop setup needs an interactive terminal.");
      say("Run it in a terminal, or drive it with a scripted prompter.");
      return { saved: false, cancelled: false };
    }

    say("FixLoop Setup");
    say("Turn application errors into tested, verified pull requests.");
    say("");
    say("Checking your server...");

    const info = await detectSystem(commandRunner);
    const preflight: Check[] = [
      { name: "System", ok: true, detail: formatSystemLine(info) },
      await checkNodeVersion(),
      await checkDocker(commandRunner),
      await checkGit(commandRunner),
    ];
    for (const line of renderChecks(preflight)) say(line);
    if (preflight.some((c) => !c.ok)) {
      say("");
      say("Fix the issues above, then re-run: fixloop setup");
      return { saved: false, cancelled: false };
    }

    // Existing configuration: update, doctor, or cancel — never overwrite silently.
    const existing = detectExisting(dir);
    if (existing.hasConfig || existing.hasEnv) {
      say("");
      say("Existing FixLoop configuration detected.");
      if (existing.configError) say(`  (existing config could not be parsed: ${existing.configError})`);
      let action: "update" | "doctor" | "cancel";
      if (deps.assumeUpdate) {
        action = "update";
        say("Updating the existing configuration.");
      } else {
        action = await prompter.select("What would you like to do?", [
          { value: "update", name: "Update configuration" },
          { value: "doctor", name: "Run doctor" },
          { value: "cancel", name: "Cancel" },
        ]);
      }
      if (action === "cancel") return { saved: false, cancelled: true };
      if (action === "doctor") return { saved: false, cancelled: false, next: "doctor" };
    }

    // Error provider.
    say("");
    const providerId = await prompter.select("Which error provider do you use?", selectableProviders());
    const provider = getProvider(providerId);
    const providerProject = await prompter.input(
      `${provider.name} project name (must match the project_name in ${provider.name}):`,
      { validate: (v) => (v.trim() ? true : "Enter the project name") },
    );

    // Webhook token.
    const generate = await prompter.confirm("Generate a random webhook token?", { default: true });
    const webhookSecret = generate
      ? generateToken()
      : await prompter.password("Webhook token:", {
          validate: (v) => (v.trim().length >= 16 ? true : "Use at least 16 characters"),
        });
    secrets.push(webhookSecret);

    // Public URL + webhook URL.
    const publicUrl = await prompter.input("Public FixLoop URL:", {
      default: "https://",
      validate: validatePublicUrl,
    });
    const urlWarning = publicUrlWarning(publicUrl);
    if (urlWarning) say(urlWarning);
    const webhookUrl = webhookUrlFor(publicUrl, providerId);
    say("");
    say("Your FixLoop webhook URL:");
    say(`  ${webhookUrl}`);

    // GitHub.
    say("");
    const authMethod = await prompter.select("GitHub authentication method:", [
      { value: "app", name: "GitHub App", disabled: "Coming soon" },
      { value: "token", name: "Personal Access Token (fine-grained)" },
    ]);
    say("Create a fine-grained token with Contents: read and write at https://github.com/settings/tokens");
    let githubToken = await prompter.password("GitHub personal access token:", {
      validate: (v) => (v.trim() ? true : "Enter the token"),
    });
    secrets.push(githubToken);

    let repository = "";
    let defaultBranch = "main";
    for (;;) {
      const api = githubFactory(githubToken);
      let repoChoices: string[] = [];
      try {
        repoChoices = (await api.listRepositories()).map((r) => r.fullName);
      } catch {
        // fall back to manual entry below
      }
      if (repoChoices.length > 0) {
        const picked = await prompter.select("Repository:", [
          ...repoChoices.map((r) => ({ value: r })),
          { value: "__manual__", name: "Enter manually..." },
        ]);
        repository =
          picked === "__manual__"
            ? await prompter.input("Repository (owner/repo):", { validate: validateRepository })
            : picked;
      } else {
        repository = await prompter.input("Repository (owner/repo):", {
          validate: validateRepository,
        });
      }

      say("Testing GitHub...");
      const verification = await verifyGitHub(githubToken, repository, api);
      for (const line of renderChecks(verification.checks)) say(line);
      if (verification.ok) {
        defaultBranch = verification.defaultBranch ?? "main";
        break;
      }
      say("");
      const retry = await prompter.confirm("GitHub verification failed. Try again?", { default: true });
      if (!retry) return fail("Setup cancelled. No changes were written.");
      githubToken = await prompter.password("GitHub personal access token:", {
        validate: (v) => (v.trim() ? true : "Enter the token"),
      });
      secrets.push(githubToken);
    }

    // Repository commands from the remote repo root listing.
    say("");
    const parsed = parseRepository(repository);
    let rootFiles: string[] = [];
    if (parsed) {
      try {
        rootFiles = await githubFactory(githubToken).listRootFiles(parsed.owner, parsed.repo);
      } catch {
        // detection is best-effort; the user can enter commands manually
      }
    }
    const detected = detectFromFiles(rootFiles);
    let commands: WizardConfig["commands"];
    if (detected.manager !== "unknown" && detected.install && detected.test) {
      say(`Detected a ${detected.manager} project.`);
      say(`  Install: ${detected.install}`);
      say(`  Test:    ${detected.test}`);
      const useDetected = await prompter.confirm("Use these commands?", { default: true });
      commands = useDetected
        ? { install: detected.install, test: detected.test }
        : await askCommands(prompter);
    } else {
      say("Could not detect the project stack from the repository root.");
      commands = await askCommands(prompter);
    }

    // OpenCode: AI provider, key, model.
    say("");
    const aiProviderId = await prompter.select(
      "AI provider:",
      AI_PROVIDERS.map((p) => ({ value: p.id, name: p.name })),
    );
    const aiProvider = getAiProvider(aiProviderId);
    const aiApiKey = await prompter.password(`${aiProvider.name} API key:`, {
      validate: validateApiKey,
    });
    secrets.push(aiApiKey);
    let baseUrl = "";
    if (!aiProvider.builtin) {
      baseUrl = await prompter.input("Base URL:", {
        default: aiProvider.baseUrlDefault ?? "",
        validate: (v) => (v.trim() ? true : "Enter the base URL"),
      });
    }
    const model = await prompter.input("Model:", {
      default: aiProvider.exampleModel,
      validate: validateModel,
    });

    // Docker runner validation.
    say("");
    let image = "";
    for (;;) {
      image = await prompter.input("Runner image (must contain git and the OpenCode CLI):", {
        default: DEFAULT_RUNNER_IMAGE,
      });
      say("Testing FixLoop runner...");
      const validation = await validateRunner({ docker, image });
      for (const line of renderChecks(validation.checks)) say(line);
      if (validation.ok) break;
      say("");
      const retry = await prompter.confirm("Runner validation failed. Try a different image?", {
        default: true,
      });
      if (!retry) return fail("Setup cancelled. No changes were written.");
    }

    // Tiny, inexpensive AI probe (opt-in: it costs a few tokens).
    if (aiProvider.builtin) {
      const probeIt = await prompter.confirm(
        "Run a tiny probe request to verify the model? (costs a few tokens)",
        { default: true },
      );
      if (probeIt) {
        say("Testing coding agent...");
        const probe = await verifyOpencode({
          runner: { runContainer: (img, cmd, o) => docker.run(img, cmd, o) },
          image,
          provider: aiProvider,
          apiKey: aiApiKey,
          model,
        });
        for (const line of renderChecks(probe.checks)) say(line);
        if (!probe.ok) {
          const cont = await prompter.confirm("AI probe failed. Continue anyway?", { default: false });
          if (!cont) return fail("Setup cancelled. No changes were written.");
        }
      }
    } else {
      say("Skipping the live model probe for custom providers.");
      say("Verify manually with: docker run --rm <image> opencode run --model <model> 'Reply with exactly: OK'");
    }

    // Secret-free summary + save.
    say("");
    say("Configuration");
    say(`  Error provider: ${provider.name}`);
    say(`  Repository:     ${repository}`);
    say(`  Agent:          OpenCode`);
    say(`  AI provider:    ${aiProvider.name}`);
    say(`  Model:          ${model}`);
    say(`  Public URL:     ${publicUrl}`);
    say(`  Webhook:        ${webhookUrl}`);
    say("");
    const save = await prompter.confirm("Save configuration?", { default: true });
    if (!save) return fail("Setup cancelled. No changes were written.");

    const config: WizardConfig = {
      provider: providerId,
      providerProject: providerProject.trim(),
      publicUrl,
      repository,
      defaultBranch,
      commands,
      githubAuthMethod: authMethod,
      aiProvider: aiProviderId,
      model,
      runnerImage: image,
    };
    const wizardSecrets: WizardSecrets = {
      webhookSecret,
      githubToken,
      aiApiKey,
    };
    const { backups } = saveInstall(dir, config, wizardSecrets);
    if (!aiProvider.builtin) {
      const snippet = buildOpencodeJson(aiProvider, baseUrl);
      if (snippet) writeFileAtomic(join(dir, "opencode.json"), snippet);
    }
    saved = true;
    if (backups.length > 0) say(`Backed up: ${backups.join(", ")}`);
    say("Configuration saved.");

    // Optionally start FixLoop now.
    say("");
    const startIt = await prompter.confirm("Start FixLoop now?", { default: true });
    if (startIt) {
      say("Starting FixLoop...");
      const started = await startServer(dir);
      say(started ? "✓ API healthy" : "✗ Could not start FixLoop (check the logs and run: fixloop doctor)");
    }

    // Final summary.
    say("");
    say("FixLoop is ready.");
    say("");
    say(`Error provider: ${provider.name}`);
    say("Webhook:");
    say(`  ${webhookUrl}`);
    say("GitHub");
    say(`  Repository: ${repository}`);
    say("Coding agent");
    say("  OpenCode");
    say(`  ${aiProvider.name} / ${model}`);
    say("");
    say("Next step:");
    say(`Add the webhook URL above to your ${provider.name} project.`);
    say("Then run:");
    say("  fixloop test");

    return { saved: true, cancelled: false, webhookUrl, config };
  } catch (err) {
    if (err instanceof PromptCancelled) {
      return fail(
        saved
          ? "Setup cancelled."
          : "Setup cancelled. No changes were written.",
      );
    }
    throw err;
  }
}
