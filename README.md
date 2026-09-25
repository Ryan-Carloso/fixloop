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

# Interactive setup wizard (recommended)
node dist/cli/index.js setup
# or, after `pnpm link` / global install:
fixloop setup
```

The wizard checks your server (OS, Docker, Git), configures your error
provider, GitHub access, and OpenCode model, validates the Docker runner
with a disposable container, and writes `fixloop.config.yaml` + `.env`
(non-secret config and secrets are kept separate). Then:

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

The recommended way to configure FixLoop is the wizard:

```bash
fixloop setup
```

It writes two files in the install directory:

- `fixloop.config.yaml` — non-secret configuration (provider, public URL,
  repository, commands, AI provider/model, runner image). Safe to inspect.
- `.env` — secrets only (`FIXLOOP_WEBHOOK_SECRET`, `GITHUB_TOKEN`, and the
  AI provider API key). Written with owner-only permissions (`0600`).
  Never commit this file.

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
  When unset, FixLoop keeps the in-memory store (zero-config dev mode).
- `DISCORD_WEBHOOK_URL`: Discord webhook URL for repair notifications
  (repair started, fix PR created, repair failed). Optional — when unset,
  notifications are silently disabled. Collected by `fixloop setup`
  (stored in the install `.env` file, never in the YAML config).

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
(and the webhook ingest) fail closed with
`500 {"error":"webhook secret not configured"}`.

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
