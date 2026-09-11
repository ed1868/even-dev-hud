import { pool } from '../db/pool.ts';
import { getToken } from '../vault.ts';
import { markSource } from './scheduler.ts';

const GH_API = 'https://api.github.com';

function ghHeaders(token: string, etag?: string | null): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'devhud-cloud',
    authorization: `Bearer ${token}`,
  };
  if (etag) h['if-none-match'] = etag;
  return h;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const time = (v: unknown): number | null => (v ? Date.parse(String(v)) : null);

async function readEtag(userId: string, key: string): Promise<string | null> {
  const { rows } = await pool.query<{ etag: string | null }>(
    'SELECT etag FROM gh_etags WHERE user_id = $1 AND key = $2',
    [userId, key],
  );
  return rows[0]?.etag ?? null;
}

async function writeEtag(userId: string, key: string, etag: string | null, now: number): Promise<void> {
  await pool.query(
    `INSERT INTO gh_etags (user_id, key, etag, fetched_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, key) DO UPDATE SET etag = EXCLUDED.etag, fetched_at = EXCLUDED.fetched_at`,
    [userId, key, etag, now],
  );
}

async function collectRepoRuns(
  userId: string,
  token: string,
  repo: string,
  now: number,
): Promise<void> {
  const etagKey = `${repo}:runs`;
  const etag = await readEtag(userId, etagKey);
  const res = await fetch(`${GH_API}/repos/${repo}/actions/runs?per_page=10`, {
    headers: ghHeaders(token, etag),
  });

  if (res.status === 304) return;
  if (!res.ok) throw new Error(`${res.status} for ${repo} runs`);

  const body = (await res.json()) as Json;
  const runs = (body.workflow_runs as Json[] | undefined) ?? [];

  await pool.query('DELETE FROM gh_runs WHERE user_id = $1 AND repo = $2', [userId, repo]);
  for (const r of runs) {
    const started = time(r.run_started_at) ?? time(r.created_at);
    const ended = time(r.updated_at);
    await pool.query(
      `INSERT INTO gh_runs (id, user_id, repo, run_id, name, branch, event, status, conclusion, started_at, duration_ms, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id, id) DO UPDATE SET
         status = EXCLUDED.status, conclusion = EXCLUDED.conclusion, fetched_at = EXCLUDED.fetched_at`,
      [
        `${repo}:${String(r.id)}`, userId, repo,
        typeof r.id === 'number' ? r.id : null,
        str(r.name), str(r.head_branch), str(r.event),
        str(r.status), str(r.conclusion),
        started, started && ended ? ended - started : null, now,
      ],
    );
  }

  await pool.query('DELETE FROM gh_branches WHERE user_id = $1 AND repo = $2', [userId, repo]);
  const seen = new Map<string, Json>();
  for (const r of runs) {
    const b = str(r.head_branch);
    if (b && !seen.has(b)) seen.set(b, r);
  }
  for (const [name, r] of seen) {
    await pool.query(
      `INSERT INTO gh_branches (id, user_id, repo, name, sha, last_run_at, last_run_status, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, id) DO NOTHING`,
      [
        `${repo}:${name}`, userId, repo, name,
        str(r.head_sha),
        time(r.run_started_at) ?? time(r.created_at),
        str(r.conclusion) ?? str(r.status), now,
      ],
    );
  }

  const nextEtag = res.headers.get('etag');
  await writeEtag(userId, etagKey, nextEtag, now);

  // CI state from latest run
  const latest = runs[0];
  if (latest) {
    const status = String(latest.status ?? '');
    const conclusion = latest.conclusion === null ? null : String(latest.conclusion ?? '');
    let ciState = 'unknown';
    if (status !== 'completed') ciState = 'building';
    else if (conclusion === 'success') ciState = 'passing';
    else if (conclusion !== 'cancelled' && conclusion !== 'skipped') ciState = 'failing';

    await pool.query(
      `UPDATE gh_repos SET ci_state = $1, ci_job = $2, ci_run_id = $3, ci_at = $4, head_branch = $5
       WHERE user_id = $6 AND name = $7`,
      [ciState, str(latest.name), typeof latest.id === 'number' ? latest.id : null,
       time(latest.updated_at), str(latest.head_branch), userId, repo],
    );
  }
}

async function collectRepoPrs(
  userId: string,
  token: string,
  repo: string,
  now: number,
): Promise<void> {
  const etagKey = `${repo}:prs`;
  const etag = await readEtag(userId, etagKey);
  const res = await fetch(
    `${GH_API}/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=10`,
    { headers: ghHeaders(token, etag) },
  );

  if (res.status === 304) return;
  if (!res.ok) throw new Error(`${res.status} for ${repo} prs`);

  const prs = (await res.json()) as Json[];
  await pool.query('DELETE FROM gh_prs WHERE user_id = $1 AND repo = $2', [userId, repo]);

  for (const pr of prs) {
    const merged = Boolean(pr.merged_at);
    const head = pr.head as Json | undefined;
    const user = pr.user as Json | undefined;
    await pool.query(
      `INSERT INTO gh_prs (id, user_id, repo, number, title, author, state, draft, review_state, branch, created_at, updated_at, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (user_id, id) DO UPDATE SET
         state = EXCLUDED.state, updated_at = EXCLUDED.updated_at, fetched_at = EXCLUDED.fetched_at`,
      [
        `${repo}#${String(pr.number)}`, userId, repo,
        typeof pr.number === 'number' ? pr.number : null,
        str(pr.title), str(user?.login),
        merged ? 'merged' : str(pr.state),
        pr.draft === true, null, str(head?.ref),
        time(pr.created_at), time(pr.updated_at), now,
      ],
    );
  }

  const openCount = await pool.query(
    `SELECT COUNT(*) AS n FROM gh_prs WHERE user_id = $1 AND repo = $2 AND state = 'open'`,
    [userId, repo],
  );
  await pool.query(
    'UPDATE gh_repos SET open_prs = $1, fetched_at = $2 WHERE user_id = $3 AND name = $4',
    [Number(openCount.rows[0]?.n ?? 0), now, userId, repo],
  );

  const nextEtag = res.headers.get('etag');
  await writeEtag(userId, etagKey, nextEtag, now);
}

export async function collectGitHubForUser(userId: string): Promise<void> {
  const cred = await getToken(userId, 'github', 'personal');
  if (!cred) {
    await markSource(userId, 'github', false, 'no github token configured');
    return;
  }

  const repos: string[] = Array.isArray(cred.config.repos) ? (cred.config.repos as string[]) : [];
  if (repos.length === 0) {
    await markSource(userId, 'github', false, 'no repos configured');
    return;
  }

  const now = Date.now();
  const failures: string[] = [];

  for (const repo of repos) {
    try {
      await pool.query(
        `INSERT INTO gh_repos (user_id, name, account, fetched_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, name) DO UPDATE SET fetched_at = EXCLUDED.fetched_at`,
        [userId, repo, 'personal', now],
      );

      await collectRepoRuns(userId, cred.token, repo, now);
      await collectRepoPrs(userId, cred.token, repo, now);
    } catch (err) {
      failures.push(`${repo}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length === repos.length) {
    await markSource(userId, 'github', false, failures.join(' | '));
  } else {
    await markSource(userId, 'github', true, failures.length ? failures.join(' | ') : undefined);
  }
}
