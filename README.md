# FixLoop

Turn application errors into tested, verified pull requests.

**Error → Reproduce → Regression Test → RED → Root Cause → Minimal Fix → GREEN → Independent Verification → GitHub PR.**

## How It Works

1. **Error Ingestion**: BugSink webhook delivers an error (issue ID, exception type/message).
2. **RED Proof**: Clone the repo into an ephemeral Docker container, run tests. They must FAIL (bug reproduced).
3. **Diagnosis**: OpenCode agent inspects the repo and identifies the root cause.
4. **Fix**: OpenCode applies a minimal fix.
5. **GREEN Proof**: Re-run tests in the same container. They must PASS.
6. **Independent Verification**: Apply the fix diff to a FRESH container, run tests again. Must PASS.
   - If OpenCode claims "fixed" but tests fail → **NO PR** (adversarial gate).
7. **PR Creation**: Create a GitHub branch with the fix via the Git Data API, open a PR.
   - **Never auto-merges.** Human review required.

## Architecture

```
src/
├── server.ts              # Fastify HTTP server (health, webhooks, jobs)
├── fixloop.ts             # Main orchestrator (Error → PR)
├── providers/
│   └── error-provider.ts  # ErrorProvider interface
│   └── bugsink.ts         # BugSink webhook provider
├── docker/
│   └── runner.ts          # Ephemeral Docker containers (run/start/exec/remove)
├── workspace/
│   └── workspace.ts       # RepairWorkspace: clone + test orchestration
├── agent/
│   └── opencode.ts        # CodingAgent interface + OpenCode implementation
├── workflow/
│   └── repair.ts          # RED → Fix → GREEN orchestration
├── verify/
│   └── gate.ts            # Independent verification gate
├── github/
│   └── client.ts          # GitHub PR creation via Git Data API
├── jobs/
│   └── queue.ts           # In-process job queue (concurrency 1)
└── config.ts              # Configuration
```

## Requirements

- Node.js 22+
- pnpm
- Docker (for containerized test runs)
- OpenCode CLI (for AI diagnosis/fix)
- GitHub token (for PR creation)
- BugSink account (for error webhooks)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build (also wires up the `fixloop` CLI)
pnpm build

# Interactive setup wizard (recommended; needs a real terminal)
node dist/cli/index.js setup
# or:
pnpm fixloop setup
# or, after `pnpm link` / global install:
fixloop setup
```

The wizard walks you through every question, validates each answer live
(preflight, GitHub, Docker runner, AI provider), and only writes
`fixloop.config.yaml` + `.env` after you confirm. See
[Setup wizard](#setup-wizard) for the full walkthrough. Then:

```bash
fixloop doctor   # diagnose the installation (read-only, never changes anything)
fixloop status   # concise status; secrets are never printed
fixloop test     # safely exercise the installation (no fake bugs, no PRs)
fixloop configure # update the existing configuration
```

```bash
# Run tests
pnpm test

# Typecheck
pnpm typecheck

# Start server
pnpm start
```

## Setup wizard

`fixloop setup` is interactive and needs a real terminal (a TTY). Nothing is
written until you answer **Save configuration?** with yes — declining that
question, or pressing Ctrl+C before it, exits without touching any files.

```bash
fixloop setup               # after `pnpm link` / global install
pnpm fixloop setup          # from a checkout
node dist/cli/index.js setup
```

### 1. Preflight

The wizard stops (exit code 1, nothing written) until every check passes:

| Check | Requirement |
|---|---|
| System | OS, arch, CPUs, RAM, free disk (informational) |
| Node.js | v22 or newer |
| Docker | installed **and** the daemon running |
| Git | installed and on `PATH` |

Failures print an actionable hint (install link, "start the Docker daemon", …);
fix it and re-run the same command.

### 2. Existing configuration

If `fixloop.config.yaml` or `.env` already exists in the directory, the wizard
never overwrites it silently and asks what to do:

- **Update configuration** — re-runs the wizard; the current files are backed
  up before being replaced.
- **Run doctor** — hands off to `fixloop doctor` and exits.
- **Cancel** — nothing changes.

`fixloop configure` skips this menu and goes straight to update mode.

### 3. The questions, in order

| # | Prompt | What to answer |
|---|---|---|
| 1 | Error provider | BugSink is the only selectable option; the rest are listed as "Coming soon". |
| 2 | Project name | Must match the `project_name` in your BugSink project — this is how incoming errors are mapped to a repository. |
| 3 | Webhook token | Default: generate a random 64-char token. Choosing "no" asks for your own (minimum 16 characters). |
| 4 | Public FixLoop URL | `https://` + hostname, **no path** (webhooks live at `/webhooks/<provider>`). Plain HTTP works but prints a warning. The wizard then prints your webhook URL, e.g. `https://fixloop.example.com/webhooks/bugsink`. |
| 5 | GitHub authentication | Fine-grained PAT (GitHub App appears but is disabled). The wizard prints where to create it: https://github.com/settings/tokens with **Contents: read and write**. |
| 6 | Repository | Choose from the repos the token can see, or "Enter manually..." → `owner/repo`. Verified read-only: authentication, repository access, contents readable, and push permission (needed to open fix PRs). On failure you get a retry loop for the token; backing out cancels with no writes. The default branch is read from the repo metadata. |
| 7 | Install / test commands | The repo root listing is checked for lockfiles and a stack is suggested (pnpm → npm → yarn → bun → python). Accept it or type your own; install and test are required, lint and typecheck are optional. |
| 8 | AI provider | Anthropic, OpenAI, OpenRouter, Z.AI, or OpenAI-compatible → API key (masked, ≥ 8 chars) → base URL (custom providers only) → model id (you type it, no spaces, e.g. `anthropic/claude-sonnet-4-5`). |
| 9 | Runner image | Default `node:22`; validated live (next section). A failed validation offers to try another image. |
| 10 | AI probe | Anthropic/OpenAI/OpenRouter only: a single tiny request inside the runner image to prove the key and model work. Costs a few tokens; you can continue on failure. Skipped for custom providers, which instead print a manual `docker run … opencode run …` command. |
| 11 | Discord webhook URL | Optional, masked; press Enter to skip. |

### 4. Runner image validation

The wizard runs a disposable container (always cleaned up) and checks:

| Check | Why |
|---|---|
| Container starts | the image pulls and runs |
| Running as non-root | untrusted repair code should not run as root |
| Git available | FixLoop clones the repo inside the container |
| OpenCode available | the coding agent runs there |
| Workspace writable | the agent has to write the fix |
| Network available | the AI provider needs outbound HTTPS |
| Container cleaned up | no leftovers on the host |

The default `node:22` fails this on purpose (it runs as root and ships no
OpenCode CLI) — treat it as a starting point and bring an image with a
non-root `USER`, `git`, and the [OpenCode CLI](https://opencode.ai/docs)
installed.

### 5. What gets saved

A secret-free summary is printed first, then **Save configuration?**:

- `fixloop.config.yaml` — non-secret configuration; an existing file is
  backed up as `fixloop.config.yaml.bak.<timestamp>`.
- `.env` — secrets only (`FIXLOOP_WEBHOOK_SECRET`, `GITHUB_TOKEN`, the AI
  provider key, optional `DISCORD_WEBHOOK_URL`), written with owner-only
  permissions (`0600`); unrelated existing keys are preserved; an existing
  file is backed up too.
- `opencode.json` — written only for custom AI providers, and it references
  the key as `{env:VAR}`, never the secret itself.

Both files are written atomically (temp file + rename), so a crash leaves
either the old or the new content — never a half-written config. Secrets are
masked while you type them and scrubbed from everything printed afterwards.

Finally, **Start FixLoop now?** boots the server in the background and polls
`/health` for up to 20 seconds (port from `FIXLOOP_PORT`, default `3000`).

### 6. After the wizard

```bash
fixloop doctor            # read-only diagnosis: config, secrets (names only),
                          # GitHub access, webhook endpoint, Docker + runner
                          # image, API health. Add --probe for a live AI probe.
fixloop status            # one-screen status; secrets are masked
fixloop test              # runs doctor, then sends a safe probe event to your
                          # webhook URL (unknown project → nothing queued)
fixloop configure         # re-run the wizard in update mode
```

`fixloop test` needs the server answering on the webhook URL (start it with
`pnpm start`, or let the wizard start it at the end).

Then paste the webhook URL into your BugSink project and send the webhook
token as the `X-FixLoop-Webhook-Token` header (or `?token=` query parameter).

### Troubleshooting

| Symptom | Fix |
|---|---|
| `fixloop setup needs an interactive terminal.` | Run it in a real terminal — pipes and CI have no TTY. |
| Preflight failure | Follow the printed hint (Node 22+, Docker daemon running, `git` on `PATH`), then re-run. |
| `GitHub verification failed` | A fine-grained PAT needs **Contents: read and write** on that repository (classic PAT: `repo` scope). A 404 means the token cannot see the repo. |
| Runner validation fails on "Running as non-root" or "OpenCode available" | Use an image with a non-root `USER`, `git`, and the OpenCode CLI. |
| AI probe: 401 / unauthorized | The provider rejected the API key — check it, then re-run `fixloop doctor --probe`. |
| `fixloop test` reports 401 | The webhook token does not match the server's; re-run `fixloop setup`. |
| "Could not start FixLoop" at the end | The port is busy or the server crashed; check `FIXLOOP_PORT`, then run `fixloop doctor`. |

## Provider support

**Error providers** (where FixLoop receives errors from):

| Provider | Status | Notes |
|---|---|---|
| BugSink | ✅ Supported | Webhook with shared token (`POST /webhooks/bugsink`) |
| Sentry | 🔜 Coming soon | Not yet implemented |
| Bugsnag | 🔜 Coming soon | Not yet implemented |
| Sentry-compatible | 🔜 Coming soon | Not yet implemented |

The setup wizard only offers providers that actually work — anything else is
shown as "Coming soon" and cannot be selected.

**AI providers** (for the OpenCode coding agent):

| Provider | Status | Config |
|---|---|---|
| Anthropic | ✅ Supported | `ANTHROPIC_API_KEY` |
| OpenAI | ✅ Supported | `OPENAI_API_KEY` |
| OpenRouter | ✅ Supported | `OPENROUTER_API_KEY` |
| Z.AI | ✅ Supported | `ZAI_API_KEY` + `ZAI_BASE_URL` (custom `opencode.json` snippet) |
| OpenAI-compatible | ✅ Supported | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` |

You pick the model id yourself during setup (e.g. `anthropic/claude-sonnet-4-5`) —
no hardcoded model list to go stale.

## Configuration

The recommended way to configure FixLoop is the
[setup wizard](#setup-wizard):

```bash
fixloop setup
```

It writes two files in the install directory:

- `fixloop.config.yaml` — non-secret configuration (provider, public URL,
  repository, commands, AI provider/model, runner image). Safe to inspect.
- `.env` — secrets only (`FIXLOOP_WEBHOOK_SECRET`, `GITHUB_TOKEN`, the
  AI provider API key, and the optional `DISCORD_WEBHOOK_URL`). Written with
  owner-only permissions (`0600`). Never commit this file.

You can also start from the included `fixloop.config.example.yaml` — copy it
to `fixloop.config.yaml` (or point `FIXLOOP_CONFIG` at it) and adjust the
repositories, commands, and branches. Secrets stay in the environment,
never in the file.

Environment variables:

- `FIXLOOP_WEBHOOK_SECRET`: Shared secret for webhook authentication
  (sent as the `X-FixLoop-Webhook-Token` header or `?token=`).
- `GITHUB_TOKEN`: GitHub personal access token (for PR creation).
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` /
  `ZAI_API_KEY` / `OPENAI_COMPATIBLE_API_KEY`: AI provider key for OpenCode.
- `FIXLOOP_PORT`: API port (default `3000`).
- `FIXLOOP_HOST`: API bind address (default `0.0.0.0`).
- `FIXLOOP_CONFIG`: Path to the config file (default `fixloop.config.yaml`).
- `DATABASE_URL`: Postgres connection string (e.g.
  `postgres://user:pass@localhost:5432/fixloop`). When set, jobs are
  persisted to Postgres so history survives restarts; the schema is applied
  automatically on boot and the server exits if the database is unreachable.
  One instance per database: boot takes a Postgres advisory lock, and a
  second process against the same `DATABASE_URL` refuses to start, because
  crash recovery rewrites transient rows and two writers would corrupt
  each other. When unset, FixLoop keeps the in-memory store (zero-config
  dev mode).
- `DISCORD_WEBHOOK_URL`: Discord webhook URL for repair notifications
  (repair started, fix PR created, repair failed, repair needs human
  review). Optional — when unset, notifications are silently disabled.
  Collected by `fixloop setup` (stored in the install `.env` file, never
  in the YAML config). Note: the current stub repair handler never
  produces a verified fix, so every accepted webhook yields two messages
  (started + needs review) until a real repair pipeline lands.

## API Endpoints

- `GET /health`: Health check.
- `POST /webhooks/bugsink`: BugSink error webhook.
- `GET /jobs`: List repair jobs (newest first; optional `?status=` filter,
  e.g. `?status=FAILED`).
- `GET /jobs/:id`: Get job status.

The `/jobs` endpoints serve raw error diagnostics, so they require the
pre-shared webhook token: send it as the `X-FixLoop-Webhook-Token` header
(`401 {"error":"invalid webhook token"}` without it). The token is
deliberately not accepted as `?token=` on these routes — the server logs
the full request URL. When `FIXLOOP_WEBHOOK_SECRET` is unset the endpoints
(and the webhook ingest) fail closed with the same
`401 {"error":"invalid webhook token"}` a wrong token gets, so an
anonymous prober cannot tell an unconfigured deployment from a configured
one; the misconfiguration is logged server-side once at startup.

## MVP Limitations

- **Docker**: Requires a working Docker daemon. Tested with mocks; live Docker blocked in sandboxed CI.
- **OpenCode**: Requires the OpenCode CLI with a configured model. The agent writes diagnosis to `/tmp/diagnosis.json` to avoid fragile JSON parsing.
- **GitHub**: File deletions not supported (MVP limitation). The PR uses the Git Data API (blobs → tree → commit → ref).
- **BugSink**: Uses a shared webhook token (BugSink doesn't provide HMAC signing for issue webhooks).
- **Scale**: Single VPS, in-process queue, concurrency 1. No Redis, no Kubernetes.
- **History retention**: With `DATABASE_URL` set, boot hydrates at most the newest 1000 jobs (`HYDRATE_ROW_LIMIT` in `src/db/postgres.ts`); older rows stay in Postgres but are invisible to the API until pruned manually. No automatic retention/pruning yet — follow-up work.

## Security

- PR bodies sanitize error messages to redact API keys, tokens, and passwords.
- Diffs are base64-encoded when passed to containers (prevents shell injection).
- Containers run with resource limits: `--cpus=1`, `--memory=512m`, `--pids-limit=100`, `--network=none` (configurable).
- GitHub token never logged; passed via environment.

## Testing

```bash
pnpm test          # Run all tests (177 tests)
pnpm typecheck     # TypeScript validation
```

The test suite includes:
- Unit tests for all components (mocked Docker, OpenCode, GitHub).
- CLI wizard tests: preflight, provider selection, webhook URL construction,
  config persistence/atomic writes, package-manager detection, GitHub
  verification, OpenCode probe, runner validation, doctor (success + partial
  failure), secret masking/redaction, and Ctrl+C cancellation.
- Adversarial test: "OpenCode says FIXED but tests FAIL → NO PR".
- End-to-end orchestration test (mocked).
- Scripted E2E (`node e2e/wizard-e2e.mjs`): full wizard run in a disposable
  directory, real server boot, `doctor`/`status`/`test` against it
  (evidence in `e2e/evidence.log`; Docker/GitHub/AI are test-doubled).

## License

MIT
