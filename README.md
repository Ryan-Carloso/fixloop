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

# Run tests
pnpm test

# Typecheck
pnpm typecheck

# Start server
pnpm start
```

## Configuration

Environment variables:

- `BUGSINK_WEBHOOK_TOKEN`: Shared secret for BugSink webhook authentication.
- `GITHUB_TOKEN`: GitHub personal access token (for PR creation).
- `GITHUB_OWNER`: GitHub repository owner.
- `GITHUB_REPO`: GitHub repository name.
- `OPENCODE_BIN`: Path to OpenCode CLI (default: `opencode`).

## API Endpoints

- `GET /health`: Health check.
- `POST /webhooks/bugsink`: BugSink error webhook.
- `GET /jobs`: List repair jobs.
- `GET /jobs/:id`: Get job status.

## MVP Limitations

- **Docker**: Requires a working Docker daemon. Tested with mocks; live Docker blocked in sandboxed CI.
- **OpenCode**: Requires the OpenCode CLI with a configured model. The agent writes diagnosis to `/tmp/diagnosis.json` to avoid fragile JSON parsing.
- **GitHub**: File deletions not supported (MVP limitation). The PR uses the Git Data API (blobs → tree → commit → ref).
- **BugSink**: Uses a shared webhook token (BugSink doesn't provide HMAC signing for issue webhooks).
- **Scale**: Single VPS, in-process queue, concurrency 1. No Redis, no Kubernetes.

## Security

- PR bodies sanitize error messages to redact API keys, tokens, and passwords.
- Diffs are base64-encoded when passed to containers (prevents shell injection).
- Containers run with resource limits: `--cpus=1`, `--memory=512m`, `--pids-limit=100`, `--network=none` (configurable).
- GitHub token never logged; passed via environment.

## Testing

```bash
pnpm test          # Run all tests (94 tests)
pnpm typecheck     # TypeScript validation
```

The test suite includes:
- Unit tests for all components (mocked Docker, OpenCode, GitHub).
- Adversarial test: "OpenCode says FIXED but tests FAIL → NO PR".
- End-to-end orchestration test (mocked).

## License

MIT
