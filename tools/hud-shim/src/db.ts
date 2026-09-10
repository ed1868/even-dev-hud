import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';

/**
 * The hot store. SQLite because it is the only thing the shim reads on the
 * request path, it has no daemon that can be down, and it lives on the same box
 * as the collector. Postgres is the archive (see `infra/`) and is deliberately
 * never consulted here — serving archive rows as current is the failure mode the
 * whole design exists to prevent.
 *
 * `node:sqlite` is built into Node 22+, so this package has no runtime deps and
 * nothing to compile.
 */

export type JobRow = {
  id: string;
  source: string;
  external_id: string;
  name: string;
  schedule_expr: string | null;
  enabled: number;
  agent: string | null;
  next_due_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_reason: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  consecutive_failures: number;
  updated_at: number;
};

export type RunRow = {
  id: string;
  job_id: string;
  source: string;
  started_at: number;
  duration_ms: number | null;
  status: string;
  reason: string | null;
  error: string | null;
  session_id: string | null;
  created_at: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id                   TEXT PRIMARY KEY,
  source               TEXT    NOT NULL,
  external_id          TEXT    NOT NULL,
  name                 TEXT    NOT NULL,
  schedule_expr        TEXT,
  enabled              INTEGER NOT NULL DEFAULT 1,
  agent                TEXT,
  next_due_at          INTEGER,
  last_run_at          INTEGER,
  last_status          TEXT,
  last_reason          TEXT,
  last_error           TEXT,
  last_duration_ms     INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT    NOT NULL,
  source      TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  duration_ms INTEGER,
  status      TEXT    NOT NULL,
  reason      TEXT,
  error       TEXT,
  session_id  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_job_time   ON runs (job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_created_at ON runs (created_at);

CREATE TABLE IF NOT EXISTS gh_repos (
  name         TEXT PRIMARY KEY,
  ci_state     TEXT, ci_job TEXT, ci_run_id INTEGER, ci_at INTEGER,
  deploy_state TEXT, deploy_env TEXT, deploy_at INTEGER,
  head_sha     TEXT, head_msg TEXT, head_author TEXT, head_at INTEGER, head_branch TEXT,
  open_prs     INTEGER, account TEXT, etag TEXT, fetched_at INTEGER
);

/* One ETag per (repo, endpoint) so each list polls independently. */
CREATE TABLE IF NOT EXISTS gh_etags (
  key TEXT PRIMARY KEY, etag TEXT, fetched_at INTEGER
);

/* Per-repo detail. All four are ETag-polled, so a quiet repo costs 0 requests. */
CREATE TABLE IF NOT EXISTS gh_prs (
  id           TEXT PRIMARY KEY,   -- "<repo>#<number>"
  repo         TEXT, number INTEGER, title TEXT, author TEXT,
  state        TEXT,               -- open | closed | merged
  draft        INTEGER,
  review_state TEXT,               -- approved | changes_requested | review_required
  branch       TEXT,
  created_at   INTEGER, updated_at INTEGER, fetched_at INTEGER
);
CREATE INDEX IF NOT EXISTS gh_prs_repo ON gh_prs (repo, updated_at DESC);

CREATE TABLE IF NOT EXISTS gh_runs (
  id         TEXT PRIMARY KEY,     -- "<repo>:<run_id>"
  repo       TEXT, run_id INTEGER, name TEXT, branch TEXT, event TEXT,
  status     TEXT, conclusion TEXT,
  started_at INTEGER, duration_ms INTEGER, fetched_at INTEGER
);
CREATE INDEX IF NOT EXISTS gh_runs_repo ON gh_runs (repo, started_at DESC);

CREATE TABLE IF NOT EXISTS gh_branches (
  id            TEXT PRIMARY KEY,  -- "<repo>:<branch>"
  repo          TEXT, name TEXT, sha TEXT,
  last_run_at   INTEGER, last_run_status TEXT,
  fetched_at    INTEGER
);
CREATE INDEX IF NOT EXISTS gh_branches_repo ON gh_branches (repo, last_run_at DESC);

CREATE TABLE IF NOT EXISTS gh_reviews (
  id TEXT PRIMARY KEY, repo TEXT, account TEXT, number INTEGER, title TEXT,
  requested_at INTEGER, fetched_at INTEGER
);

CREATE TABLE IF NOT EXISTS claw_channels (
  name TEXT PRIMARY KEY, connected INTEGER, checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS claw_sessions (
  key TEXT PRIMARY KEY, agent TEXT, tokens INTEGER, ctx_pct REAL, last_at INTEGER
);

CREATE TABLE IF NOT EXISTS claw_activity (
  id TEXT PRIMARY KEY, at INTEGER, channel TEXT, agent TEXT, kind TEXT, summary TEXT
);
CREATE INDEX IF NOT EXISTS claw_activity_at ON claw_activity (at DESC);

/* Per-source freshness. Every API response reports from here so the HUD can
   show data age instead of silently presenting stale numbers as current. */
CREATE TABLE IF NOT EXISTS source_state (
  source        TEXT PRIMARY KEY,
  last_ok_at    INTEGER,
  last_try_at   INTEGER,
  last_error    TEXT
);

/* Watermark for the one-directional SQLite -> Postgres export. */
CREATE TABLE IF NOT EXISTS export_state (
  table_name      TEXT PRIMARY KEY,
  last_created_at INTEGER NOT NULL,
  last_export_at  INTEGER NOT NULL
);
`;

/**
 * Additive column migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` silently does nothing when the table already
 * exists, so a schema change lands as a runtime `no such column` on an existing
 * store. Every column added after the first release must be listed here.
 * Additive only — a destructive change needs a real migration file.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['gh_repos', 'head_sha', 'TEXT'],
  ['gh_repos', 'head_msg', 'TEXT'],
  ['gh_repos', 'head_author', 'TEXT'],
  ['gh_repos', 'head_at', 'INTEGER'],
  ['gh_repos', 'head_branch', 'TEXT'],
  ['gh_repos', 'open_prs', 'INTEGER'],
  ['gh_repos', 'account', 'TEXT'],
  ['gh_reviews', 'account', 'TEXT'],
];

function migrate(d: DatabaseSync): void {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!cols.length) continue; // table not created yet; SCHEMA handles it
    if (cols.some((c) => c.name === column)) continue;
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`[db] migrated: ${table}.${column}`);
  }
}

let handle: DatabaseSync | undefined;

export function db(): DatabaseSync {
  if (handle) return handle;
  mkdirSync(dirname(config.db.path), { recursive: true });
  const d = new DatabaseSync(config.db.path);
  // WAL lets the collector write while the HTTP side reads without blocking.
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec('PRAGMA foreign_keys = ON;');
  d.exec(SCHEMA);
  migrate(d);
  handle = d;
  return d;
}

export function closeDb(): void {
  handle?.close();
  handle = undefined;
}

/** Upsert a job registry entry. Collectors own their rows and rewrite them wholesale. */
export function upsertJob(job: Omit<JobRow, 'updated_at'> & { updated_at?: number }): void {
  db()
    .prepare(
      `INSERT INTO jobs (id, source, external_id, name, schedule_expr, enabled, agent,
                         next_due_at, last_run_at, last_status, last_reason, last_error,
                         last_duration_ms, consecutive_failures, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         schedule_expr = excluded.schedule_expr,
         enabled = excluded.enabled,
         agent = excluded.agent,
         next_due_at = excluded.next_due_at,
         last_run_at = excluded.last_run_at,
         last_status = excluded.last_status,
         last_reason = excluded.last_reason,
         last_error = excluded.last_error,
         last_duration_ms = excluded.last_duration_ms,
         consecutive_failures = excluded.consecutive_failures,
         updated_at = excluded.updated_at`,
    )
    .run(
      job.id,
      job.source,
      job.external_id,
      job.name,
      job.schedule_expr,
      job.enabled,
      job.agent,
      job.next_due_at,
      job.last_run_at,
      job.last_status,
      job.last_reason,
      job.last_error,
      job.last_duration_ms,
      job.consecutive_failures,
      job.updated_at ?? Date.now(),
    );
}

/** Insert a run, ignoring replays — collectors re-read the same tail on every pass. */
export function insertRun(run: RunRow): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO runs
        (id, job_id, source, started_at, duration_ms, status, reason, error, session_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      run.id,
      run.job_id,
      run.source,
      run.started_at,
      run.duration_ms,
      run.status,
      run.reason,
      run.error,
      run.session_id,
      run.created_at,
    );
}

/** `ok` with an `error` means partial success — some sources worked, some did not. */
export function markSource(source: string, ok: boolean, error?: string): void {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO source_state (source, last_ok_at, last_try_at, last_error)
       VALUES (?,?,?,?)
       ON CONFLICT(source) DO UPDATE SET
         last_ok_at  = CASE WHEN ? THEN ? ELSE source_state.last_ok_at END,
         last_try_at = ?,
         last_error  = ?`,
    )
    .run(source, ok ? now : null, now, error ?? null, ok ? 1 : 0, now, now, error ?? null);
}

export type SourceState = {
  source: string;
  last_ok_at: number | null;
  last_try_at: number | null;
  last_error: string | null;
};

export function sourceStates(): SourceState[] {
  return db().prepare('SELECT * FROM source_state').all() as unknown as SourceState[];
}

/** Freshness envelope attached to every API response. */
export function freshness(source: string): { fetchedAt: number | null; stale: boolean; error: string | null } {
  const row = db()
    .prepare('SELECT last_ok_at, last_error FROM source_state WHERE source = ?')
    .get(source) as { last_ok_at: number | null; last_error: string | null } | undefined;
  const fetchedAt = row?.last_ok_at ?? null;
  return {
    fetchedAt,
    stale: fetchedAt === null || Date.now() - fetchedAt > config.thresholds.staleMs,
    error: row?.last_error ?? null,
  };
}
