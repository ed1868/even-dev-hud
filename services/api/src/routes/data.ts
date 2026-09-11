import { Router, type Request, type Response } from 'express';
import { pool } from '../db/pool.ts';
import { triggerRefreshIfStale } from '../collectors/scheduler.ts';

export const dataRouter = Router();

type AuthedRequest = Request & { userId: string };

const STALE_MS = 3 * 60_000;

async function freshness(
  userId: string,
  source: string,
): Promise<{ fetchedAt: number | null; stale: boolean; error: string | null }> {
  const { rows } = await pool.query<{ last_ok_at: string | null; last_error: string | null }>(
    'SELECT last_ok_at, last_error FROM source_state WHERE user_id = $1 AND source = $2',
    [userId, source],
  );
  const row = rows[0];
  const fetchedAt = row?.last_ok_at ? Number(row.last_ok_at) : null;
  return {
    fetchedAt,
    stale: fetchedAt === null || Date.now() - fetchedAt > STALE_MS,
    error: row?.last_error ?? null,
  };
}

dataRouter.get('/attention', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;
  await triggerRefreshIfStale(userId, 'github');

  const jobs = await pool.query(
    `SELECT * FROM jobs WHERE user_id = $1
     AND (last_status = 'error' OR consecutive_failures > 0
       OR (next_due_at IS NOT NULL AND next_due_at + 300000 < $2))
     ORDER BY name`,
    [userId, Date.now()],
  );
  const reviews = await pool.query(
    'SELECT COUNT(*) AS n FROM gh_reviews WHERE user_id = $1',
    [userId],
  );
  const down = await pool.query(
    'SELECT name FROM claw_channels WHERE user_id = $1 AND connected = false',
    [userId],
  );

  res.json({
    jobs: jobs.rows,
    reviewsWaiting: Number(reviews.rows[0]?.n ?? 0),
    channelsDown: down.rows.map((c: { name: string }) => c.name),
    counts: {
      jobs: jobs.rows.length,
      reviews: Number(reviews.rows[0]?.n ?? 0),
      channelsDown: down.rows.length,
    },
    now: Date.now(),
  });
});

dataRouter.get('/jobs', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;

  const { rows } = await pool.query('SELECT * FROM jobs WHERE user_id = $1 ORDER BY name', [userId]);

  const total = rows.length;
  const failing = rows.filter((j: { last_status: string }) => j.last_status === 'error').length;
  const disabled = rows.filter((j: { enabled: boolean }) => !j.enabled).length;

  res.json({
    jobs: rows,
    counts: { total, failing, disabled },
    ...(await freshness(userId, 'openclaw-cron')),
  });
});

dataRouter.get('/jobs/:id', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;
  const { id } = req.params;

  const { rows: jobRows } = await pool.query(
    'SELECT * FROM jobs WHERE user_id = $1 AND id = $2',
    [userId, id],
  );
  if (!jobRows[0]) {
    res.status(404).json({ error: 'not found', id });
    return;
  }

  const { rows: runRows } = await pool.query(
    `SELECT started_at, duration_ms, status, error FROM runs
     WHERE user_id = $1 AND job_id = $2 ORDER BY started_at DESC LIMIT 10`,
    [userId, id],
  );

  const okCount = runRows.filter((r: { status: string }) => r.status === 'ok').length;
  res.json({
    job: jobRows[0],
    runs: runRows,
    recent: { total: runRows.length, ok: okCount, failed: runRows.length - okCount },
    ...(await freshness(userId, 'openclaw-cron')),
  });
});

dataRouter.get('/gh/summary', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;
  await triggerRefreshIfStale(userId, 'github');

  const repos = await pool.query(
    'SELECT * FROM gh_repos WHERE user_id = $1 ORDER BY name',
    [userId],
  );
  const reviews = await pool.query(
    'SELECT repo, account, number, title FROM gh_reviews WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 20',
    [userId],
  );
  const accounts = await pool.query(
    'SELECT DISTINCT account FROM gh_repos WHERE user_id = $1 AND account IS NOT NULL ORDER BY account',
    [userId],
  );

  res.json({
    repos: repos.rows,
    reviews: reviews.rows,
    reviewsWaiting: reviews.rows.length,
    accounts: accounts.rows.map((r: { account: string }) => r.account),
    ...(await freshness(userId, 'github')),
  });
});

dataRouter.get('/gh/repo/:name', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;
  const q = req.params.name ?? '';

  const { rows: repoRows } = await pool.query(
    `SELECT * FROM gh_repos WHERE user_id = $1 AND (name = $2 OR name LIKE $3) LIMIT 1`,
    [userId, q, `%/${q}`],
  );
  if (!repoRows[0]) {
    res.status(404).json({ error: 'not found', name: q });
    return;
  }

  const full = String(repoRows[0].name);
  const prs = await pool.query(
    `SELECT number, title, author, state, draft, branch, updated_at
     FROM gh_prs WHERE user_id = $1 AND repo = $2 ORDER BY updated_at DESC LIMIT 10`,
    [userId, full],
  );
  const runs = await pool.query(
    `SELECT run_id, name, branch, event, status, conclusion, started_at, duration_ms
     FROM gh_runs WHERE user_id = $1 AND repo = $2 ORDER BY started_at DESC LIMIT 10`,
    [userId, full],
  );
  const branches = await pool.query(
    `SELECT name, sha, last_run_at, last_run_status
     FROM gh_branches WHERE user_id = $1 AND repo = $2 ORDER BY last_run_at DESC LIMIT 10`,
    [userId, full],
  );

  res.json({
    repo: repoRows[0],
    prs: prs.rows,
    runs: runs.rows,
    branches: branches.rows,
    ...(await freshness(userId, 'github')),
  });
});

dataRouter.get('/claw/summary', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;

  const channels = await pool.query(
    'SELECT * FROM claw_channels WHERE user_id = $1 ORDER BY name',
    [userId],
  );
  const sessions = await pool.query(
    'SELECT * FROM claw_sessions WHERE user_id = $1 ORDER BY last_at DESC LIMIT 5',
    [userId],
  );
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const today = await pool.query(
    'SELECT COUNT(*) AS n FROM claw_activity WHERE user_id = $1 AND at >= $2',
    [userId, since],
  );

  res.json({
    channels: channels.rows,
    sessions: sessions.rows,
    actionsToday: Number(today.rows[0]?.n ?? 0),
    ...(await freshness(userId, 'openclaw-sessions')),
  });
});

dataRouter.get('/claw/today', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;
  const since = Date.now() - 24 * 60 * 60 * 1000;

  const { rows } = await pool.query(
    'SELECT * FROM claw_activity WHERE user_id = $1 AND at >= $2 ORDER BY at DESC LIMIT 50',
    [userId, since],
  );

  res.json({
    items: rows,
    ...(await freshness(userId, 'openclaw-sessions')),
  });
});

dataRouter.post('/check', async (req: Request, res: Response) => {
  const { userId } = req as AuthedRequest;
  const { claim } = req.body as { claim?: string };

  if (!claim) {
    res.status(400).json({ error: 'claim is required' });
    return;
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  await pool.query(
    `INSERT INTO fact_checks (id, user_id, claim, verdict, confidence, sources, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, userId, claim, 'pending', null, '[]', now],
  );

  res.status(201).json({ id, claim, verdict: 'pending', checked_at: now });
});
