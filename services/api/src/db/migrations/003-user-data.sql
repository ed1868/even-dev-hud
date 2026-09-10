CREATE TABLE jobs (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  schedule_expr TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  agent TEXT,
  next_due_at BIGINT,
  last_run_at BIGINT,
  last_status TEXT,
  last_reason TEXT,
  last_error TEXT,
  last_duration_ms INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE runs (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  source TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  duration_ms INTEGER,
  status TEXT NOT NULL,
  reason TEXT,
  error TEXT,
  session_id TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX runs_user_job_time ON runs (user_id, job_id, started_at DESC);
CREATE INDEX runs_user_created ON runs (user_id, created_at);

CREATE TABLE gh_repos (
  name TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ci_state TEXT,
  ci_job TEXT,
  ci_run_id BIGINT,
  ci_at BIGINT,
  deploy_state TEXT,
  deploy_env TEXT,
  deploy_at BIGINT,
  head_sha TEXT,
  head_msg TEXT,
  head_author TEXT,
  head_at BIGINT,
  head_branch TEXT,
  open_prs INTEGER,
  account TEXT,
  etag TEXT,
  fetched_at BIGINT,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE gh_etags (
  key TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  etag TEXT,
  fetched_at BIGINT,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE gh_prs (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo TEXT,
  number INTEGER,
  title TEXT,
  author TEXT,
  state TEXT,
  draft BOOLEAN,
  review_state TEXT,
  branch TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  fetched_at BIGINT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX gh_prs_user_repo ON gh_prs (user_id, repo, updated_at DESC);

CREATE TABLE gh_runs (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo TEXT,
  run_id BIGINT,
  name TEXT,
  branch TEXT,
  event TEXT,
  status TEXT,
  conclusion TEXT,
  started_at BIGINT,
  duration_ms INTEGER,
  fetched_at BIGINT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX gh_runs_user_repo ON gh_runs (user_id, repo, started_at DESC);

CREATE TABLE gh_branches (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo TEXT,
  name TEXT,
  sha TEXT,
  last_run_at BIGINT,
  last_run_status TEXT,
  fetched_at BIGINT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX gh_branches_user_repo ON gh_branches (user_id, repo, last_run_at DESC);

CREATE TABLE gh_reviews (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo TEXT,
  account TEXT,
  number INTEGER,
  title TEXT,
  requested_at BIGINT,
  fetched_at BIGINT,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE claw_channels (
  name TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connected BOOLEAN,
  checked_at BIGINT,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE claw_sessions (
  key TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent TEXT,
  tokens INTEGER,
  ctx_pct REAL,
  last_at BIGINT,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE claw_activity (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at BIGINT,
  channel TEXT,
  agent TEXT,
  kind TEXT,
  summary TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX claw_activity_user_at ON claw_activity (user_id, at DESC);

CREATE TABLE context_snippets (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  channel TEXT,
  content TEXT NOT NULL,
  embedding_model TEXT,
  indexed_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX context_snippets_user_source ON context_snippets (user_id, source);

CREATE TABLE fact_checks (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim TEXT NOT NULL,
  verdict TEXT,
  confidence REAL,
  sources JSONB DEFAULT '[]',
  checked_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX fact_checks_user_time ON fact_checks (user_id, checked_at DESC);

CREATE TABLE source_state (
  source TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_ok_at BIGINT,
  last_try_at BIGINT,
  last_error TEXT,
  PRIMARY KEY (user_id, source)
);
