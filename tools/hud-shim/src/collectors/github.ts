import { config } from '../config.ts';
import { db, markSource } from '../db.ts';

/**
 * GitHub collector.
 *
 * Polls rather than receiving webhooks: a webhook needs a public inbound
 * endpoint, and this service is tailnet-only by design. Conditional requests
 * make polling nearly free — a `304 Not Modified` does not count against the
 * rate limit, so a handful of repos every 30s costs almost nothing. ETags are
 * stored per (repo, endpoint) so a quiet list stays quiet independently.
 *
 * Never called from the glasses directly: the whitelist is not a CORS bypass,
 * and a token in a web page is a leaked token.
 */

export const SOURCE = 'github';

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const time = (v: unknown): number | null => (v ? Date.parse(String(v)) : null);

function ghHeaders(token: string, etag?: string | null): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'dev-hud-shim',
    authorization: `Bearer ${token}`,
  };
  if (etag) h['if-none-match'] = etag;
  return h;
}

function readEtag(key: string): string | null {
  const row = db().prepare('SELECT etag FROM gh_etags WHERE key = ?').get(key) as
    | { etag: string | null }
    | undefined;
  return row?.etag ?? null;
}

function writeEtag(key: string, etag: string | null, now: number): void {
  db()
    .prepare(
      `INSERT INTO gh_etags (key, etag, fetched_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, fetched_at = excluded.fetched_at`,
    )
    .run(key, etag, now);
}

type Fetched<T> = {
  unchanged: boolean;
  body: T | null;
  /**
   * Commit the ETag only *after* the rows are stored. Writing it up front means a
   * store that fails (or a schema that was missing a column) gets permanently
   * cached as "unchanged", and the data never lands. That bug is invisible: every
   * later poll returns a free 304 and everything looks healthy.
   */
  commit: () => void;
};

/** Conditional GET. `unchanged: true` means a free 304 — leave stored rows alone. */
async function getCached<T>(
  token: string,
  key: string,
  path: string,
  now: number,
  opts: { force?: boolean } = {},
): Promise<Fetched<T>> {
  const etag = opts.force ? null : readEtag(key);
  const res = await fetch(`${config.github.apiBase}${path}`, { headers: ghHeaders(token, etag) });
  const noop = () => {};
  if (res.status === 304) return { unchanged: true, body: null, commit: noop };
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error(`rate limited; resets at ${res.headers.get('x-ratelimit-reset') ?? '?'}`);
  }
  if (res.status === 404) return { unchanged: false, body: null, commit: noop };
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  const next = res.headers.get('etag');
  return {
    unchanged: false,
    body: (await res.json()) as T,
    commit: () => writeEtag(key, next, now),
  };
}

function ciStateFrom(run: Json | undefined): {
  state: string;
  job: string | null;
  id: number | null;
  at: number | null;
} {
  if (!run) return { state: 'unknown', job: null, id: null, at: null };
  const status = String(run.status ?? '');
  const conclusion = run.conclusion === null ? null : String(run.conclusion ?? '');
  const at = time(run.updated_at);
  const id = typeof run.id === 'number' ? run.id : null;
  const job = str(run.name);
  if (status !== 'completed') return { state: 'building', job, id, at };
  if (conclusion === 'success') return { state: 'passing', job, id, at };
  if (conclusion === 'cancelled' || conclusion === 'skipped') return { state: 'unknown', job, id, at };
  return { state: 'failing', job, id, at };
}

/** Last 10 workflow runs, plus the branches they ran on. */
async function collectRuns(token: string, repo: string, now: number): Promise<Json[] | null> {
  const res = await getCached<Json>(token, `${repo}:runs`, `/repos/${repo}/actions/runs?per_page=10`, now);
  if (res.unchanged) return null;
  const runs = (res.body?.workflow_runs as Json[] | undefined) ?? [];

  db().prepare('DELETE FROM gh_runs WHERE repo = ?').run(repo);
  const stmt = db().prepare(
    `INSERT OR REPLACE INTO gh_runs
       (id, repo, run_id, name, branch, event, status, conclusion, started_at, duration_ms, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of runs) {
    const started = time(r.run_started_at) ?? time(r.created_at);
    const ended = time(r.updated_at);
    stmt.run(
      `${repo}:${String(r.id)}`,
      repo,
      typeof r.id === 'number' ? r.id : null,
      str(r.name),
      str(r.head_branch),
      str(r.event),
      str(r.status),
      str(r.conclusion),
      started,
      started && ended ? ended - started : null,
      now,
    );
  }

  // "Branches with recent Actions activity" comes free from the runs we already
  // have — deriving it costs nothing, whereas per-branch commit dates would be
  // one API call per branch.
  const seen = new Map<string, Json>();
  for (const r of runs) {
    const b = str(r.head_branch);
    if (b && !seen.has(b)) seen.set(b, r);
  }
  db().prepare('DELETE FROM gh_branches WHERE repo = ?').run(repo);
  const bstmt = db().prepare(
    `INSERT OR REPLACE INTO gh_branches
       (id, repo, name, sha, last_run_at, last_run_status, fetched_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (const [name, r] of seen) {
    bstmt.run(
      `${repo}:${name}`,
      repo,
      name,
      str(r.head_sha),
      time(r.run_started_at) ?? time(r.created_at),
      str(r.conclusion) ?? str(r.status),
      now,
    );
  }
  res.commit();
  return runs;
}

/** Last 10 PRs by recent activity — all of them, not only ones assigned to you. */
async function collectPrs(token: string, repo: string, now: number): Promise<void> {
  const res = await getCached<Json[]>(
    token,
    `${repo}:prs`,
    `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=10`,
    now,
  );
  if (res.unchanged || !res.body) return;

  db().prepare('DELETE FROM gh_prs WHERE repo = ?').run(repo);
  const stmt = db().prepare(
    `INSERT OR REPLACE INTO gh_prs
       (id, repo, number, title, author, state, draft, review_state, branch,
        created_at, updated_at, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const pr of res.body) {
    const merged = Boolean(pr.merged_at);
    const head = pr.head as Json | undefined;
    const user = pr.user as Json | undefined;
    stmt.run(
      `${repo}#${String(pr.number)}`,
      repo,
      typeof pr.number === 'number' ? pr.number : null,
      str(pr.title),
      str(user?.login),
      merged ? 'merged' : str(pr.state),
      pr.draft === true ? 1 : 0,
      null,
      str(head?.ref),
      time(pr.created_at),
      time(pr.updated_at),
      now,
    );
  }
  res.commit();
}

/** Head commit on the default branch. */
async function collectHead(token: string, repo: string, now: number): Promise<void> {
  // If a 304 says "unchanged" but we hold no commit, the cached ETag is lying —
  // refetch unconditionally rather than trusting it forever.
  const stored = db()
    .prepare('SELECT head_sha FROM gh_repos WHERE name = ?')
    .get(repo) as { head_sha: string | null } | undefined;
  const res = await getCached<Json[]>(
    token,
    `${repo}:commits`,
    `/repos/${repo}/commits?per_page=1`,
    now,
    { force: !stored?.head_sha },
  );
  if (res.unchanged || !res.body?.length) return;
  const c = res.body[0] as Json;
  const commit = c.commit as Json | undefined;
  const author = commit?.author as Json | undefined;
  const msg = (str(commit?.message) ?? '').split('\n')[0] ?? '';
  db()
    .prepare(
      `UPDATE gh_repos SET head_sha = ?, head_msg = ?, head_author = ?, head_at = ? WHERE name = ?`,
    )
    .run(str(c.sha)?.slice(0, 7) ?? null, msg, str(author?.name), time(author?.date), repo);
  res.commit();
}

export async function collectGitHub(): Promise<{ repos: number; reviews: number; skipped?: string }> {
  const accounts = config.github.accounts;
  if (accounts.length === 0) {
    // Not an error — the source is simply not configured yet.
    markSource(SOURCE, false, 'not configured: set GITHUB_ACCOUNTS or GITHUB_TOKEN + GITHUB_REPOS');
    return { repos: 0, reviews: 0, skipped: 'not configured' };
  }

  const now = Date.now();
  let repoCount = 0;
  let reviewCount = 0;
  const failures: string[] = [];

  for (const account of accounts) {
   const { token, name: accountName } = account;
   try {
    for (const repo of account.repos) {
      // Ensure the row exists before the detail collectors update it.
      db()
        .prepare(`INSERT OR IGNORE INTO gh_repos (name, account, fetched_at) VALUES (?,?,?)`)
        .run(repo, accountName, now);
      db().prepare('UPDATE gh_repos SET account = ? WHERE name = ?').run(accountName, repo);

      const runs = await collectRuns(token, repo, now);
      if (runs) {
        const ci = ciStateFrom(runs[0]);
        db()
          .prepare(
            `UPDATE gh_repos SET ci_state = ?, ci_job = ?, ci_run_id = ?, ci_at = ?, head_branch = ?
             WHERE name = ?`,
          )
          .run(ci.state, ci.job, ci.id, ci.at, str(runs[0]?.head_branch), repo);
      }

      await collectPrs(token, repo, now);
      await collectHead(token, repo, now);

      const open = db()
        .prepare(`SELECT COUNT(*) AS n FROM gh_prs WHERE repo = ? AND state = 'open'`)
        .get(repo) as { n: number };
      db()
        .prepare('UPDATE gh_repos SET open_prs = ?, fetched_at = ? WHERE name = ?')
        .run(open.n, now, repo);
      repoCount += 1;
    }

    // PRs waiting on you — the row that matters most on the summary screen,
    // because a red build finds you eventually and a pending review just blocks
    // someone else.
    const rev = await getCached<Json>(
      token,
      `search:review-requested:${accountName}`,
      '/search/issues?q=is:pr+is:open+review-requested:@me&per_page=20',
      now,
    );
    if (!rev.unchanged) {
      const items = (rev.body?.items as Json[] | undefined) ?? [];
      db().prepare('DELETE FROM gh_reviews WHERE account = ?').run(accountName);
      const stmt = db().prepare(
        `INSERT OR REPLACE INTO gh_reviews (id, repo, account, number, title, requested_at, fetched_at)
         VALUES (?,?,?,?,?,?,?)`,
      );
      for (const it of items) {
        const repo = String(it.repository_url ?? '').split('/repos/')[1] ?? '';
        stmt.run(
          String(it.id ?? `${repo}#${String(it.number ?? '')}`),
          repo,
          accountName,
          typeof it.number === 'number' ? it.number : null,
          str(it.title),
          time(it.created_at),
          now,
        );
      }
      rev.commit();
    }
   } catch (err) {
    // One account failing must not blank the others — record it and continue.
    failures.push(`${accountName}: ${err instanceof Error ? err.message : String(err)}`);
   }
  }

  // Drop repos that are no longer configured, along with their detail rows.
  // Without this, removing a repo from .env leaves it on screen forever, showing
  // data that will never refresh.
  const wanted = new Set(accounts.flatMap((a) => a.repos));
  const known = db().prepare('SELECT name FROM gh_repos').all() as unknown as { name: string }[];
  for (const { name } of known) {
    if (wanted.has(name)) continue;
    for (const table of ['gh_repos', 'gh_prs', 'gh_runs', 'gh_branches'] as const) {
      const col = table === 'gh_repos' ? 'name' : 'repo';
      db().prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(name);
    }
    db().prepare('DELETE FROM gh_etags WHERE key LIKE ?').run(`${name}:%`);
    console.log(`[github] pruned ${name} (no longer configured)`);
  }

  reviewCount = (db().prepare('SELECT COUNT(*) AS n FROM gh_reviews').get() as { n: number }).n;

  if (failures.length === accounts.length) {
    markSource(SOURCE, false, failures.join(' | '));
    return { repos: 0, reviews: 0, skipped: 'error' };
  }
  // Partial success is still success: never blank the cache on a failed poll.
  markSource(SOURCE, true, failures.length ? failures.join(' | ') : undefined);
  return { repos: repoCount, reviews: reviewCount };
}
