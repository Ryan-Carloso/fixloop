-- FixLoop job persistence.
--
-- Applied automatically on server boot when DATABASE_URL is set
-- (CREATE TABLE IF NOT EXISTS — MVP, no migration framework).
-- Safe to apply manually as well:
--   psql "$DATABASE_URL" -f src/db/schema.sql

CREATE TABLE IF NOT EXISTS fixloop_jobs (
  id            UUID PRIMARY KEY,
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
