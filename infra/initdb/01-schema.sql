-- Dev HUD archive schema. Mirrors the SQLite hot store; see docs/plans/dev-hud.md §1.3.
-- Append-only from the nightly export. Nothing here is in the glasses' hot path.

CREATE TABLE IF NOT EXISTS jobs (
  id                   TEXT PRIMARY KEY,
  source               TEXT    NOT NULL,
  external_id          TEXT    NOT NULL,
  name                 TEXT    NOT NULL,
  schedule_expr        TEXT,
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  agent                TEXT,
  next_due_at          BIGINT,
  last_run_at          BIGINT,
  last_status          TEXT,
  last_reason          TEXT,
  last_error           TEXT,
  last_duration_ms     BIGINT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT   NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source      TEXT   NOT NULL,
  started_at  BIGINT NOT NULL,
  duration_ms BIGINT,
  status      TEXT   NOT NULL,
  reason      TEXT,
  error       TEXT,
  session_id  TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_job_time    ON runs (job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_created_at  ON runs (created_at);

CREATE TABLE IF NOT EXISTS gh_repos (
  name         TEXT PRIMARY KEY,
  ci_state     TEXT, ci_job TEXT, ci_run_id BIGINT, ci_at BIGINT,
  deploy_state TEXT, deploy_env TEXT, deploy_at BIGINT,
  etag         TEXT, fetched_at BIGINT
);

CREATE TABLE IF NOT EXISTS gh_reviews (
  id TEXT PRIMARY KEY, repo TEXT, number INTEGER, title TEXT,
  requested_at BIGINT, fetched_at BIGINT
);

CREATE TABLE IF NOT EXISTS claw_channels (
  name TEXT PRIMARY KEY, connected BOOLEAN, checked_at BIGINT
);

CREATE TABLE IF NOT EXISTS claw_sessions (
  key TEXT PRIMARY KEY, agent TEXT, tokens BIGINT,
  ctx_pct DOUBLE PRECISION, last_at BIGINT
);

CREATE TABLE IF NOT EXISTS claw_activity (
  id TEXT PRIMARY KEY, at BIGINT, channel TEXT,
  agent TEXT, kind TEXT, summary TEXT
);
CREATE INDEX IF NOT EXISTS claw_activity_at ON claw_activity (at DESC);

-- Watermark for the one-directional SQLite -> Postgres export.
CREATE TABLE IF NOT EXISTS export_state (
  table_name       TEXT PRIMARY KEY,
  last_created_at  BIGINT NOT NULL,
  last_export_at   BIGINT NOT NULL
);
