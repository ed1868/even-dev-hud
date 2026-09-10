import { pool } from '../db/pool.ts';
import { collectGitHubForUser } from './github.ts';
import { collectContextForUser } from './context-indexer.ts';

const STALE_MS = 3 * 60_000;

const inflight = new Set<string>();

type Collector = (userId: string) => Promise<void>;

const collectors: Record<string, Collector> = {
  github: collectGitHubForUser,
  'context-indexer': collectContextForUser,
};

export async function triggerRefreshIfStale(userId: string, source: string): Promise<void> {
  const key = `${userId}:${source}`;
  if (inflight.has(key)) return;

  const { rows } = await pool.query<{ last_ok_at: string | null }>(
    'SELECT last_ok_at FROM source_state WHERE user_id = $1 AND source = $2',
    [userId, source],
  );

  const lastOk = rows[0]?.last_ok_at ? Number(rows[0].last_ok_at) : null;
  if (lastOk !== null && Date.now() - lastOk < STALE_MS) return;

  const collector = collectors[source];
  if (!collector) return;

  inflight.add(key);
  collector(userId)
    .catch((err) => {
      console.error(`[collector:${source}] user=${userId}`, err);
    })
    .finally(() => {
      inflight.delete(key);
    });
}

export async function markSource(
  userId: string,
  source: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  const now = Date.now();
  await pool.query(
    `INSERT INTO source_state (user_id, source, last_ok_at, last_try_at, last_error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, source) DO UPDATE SET
       last_ok_at = CASE WHEN $6 THEN $4 ELSE source_state.last_ok_at END,
       last_try_at = $4,
       last_error = $5`,
    [userId, source, ok ? now : null, now, error ?? null, ok],
  );
}
