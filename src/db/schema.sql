-- FixLoop job persistence.
--
-- Applied automatically on server boot when DATABASE_URL is set
-- (CREATE TABLE IF NOT EXISTS — MVP, no migration framework).
-- Safe to apply manually as well:
--   psql "$DATABASE_URL" -f src/db/schema.sql

CREATE TABLE IF NOT EXISTS fixloop_jobs (
  -- TEXT, not UUID: Job ids are app-generated strings (newJobId()), and the
  -- store must accept any string id without failing the write-behind.
  id            TEXT PRIMARY KEY,
  -- No UNIQUE constraint on dedup_key by design: duplicate-active
  -- suppression is enforced in the in-memory store
  -- (findActiveByDedupKey), which is the single writer while the
  -- advisory lock guarantees one instance. A schema-level constraint
  -- would also change write-behind conflict behavior — revisit if a
  -- second writer ever bypasses the store.
  dedup_key     TEXT NOT NULL,
  provider      TEXT NOT NULL,
  repository    TEXT NOT NULL,
  issue_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  error_context JSONB NOT NULL,
  note          TEXT,
  pr_url        TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS fixloop_jobs_dedup_key_idx
  ON fixloop_jobs (dedup_key);

CREATE INDEX IF NOT EXISTS fixloop_jobs_status_idx
  ON fixloop_jobs (status);

-- Hydration runs ORDER BY created_at DESC LIMIT on every boot; without
-- this index a growing table pays a full sort each time.
CREATE INDEX IF NOT EXISTS fixloop_jobs_created_at_idx
  ON fixloop_jobs (created_at DESC);
