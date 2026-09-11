import { config } from '../config.ts';
import { db, freshness, sourceStates } from '../db.ts';
import { allJobs, attention, jobById } from '../attention.ts';
import { gatewayUp } from '../collectors/openclaw-sessions.ts';
import { runCheck, recentChecks } from '../check.ts';
import type { PostRequest, Route } from '../server.ts';

/**
 * Every route reads SQLite and returns immediately. Nothing here blocks on
 * GitHub or the OpenClaw gateway — the app must never wait on a third party, and
 * a source being down must surface as labelled staleness rather than a hang.
 */

const SOURCES = {
  cron: 'openclaw-cron',
  sessions: 'openclaw-sessions',
  github: 'github',
  context: 'context-indexer',
} as const;

export const routes: Route[] = [
  {
    method: 'GET',
    pattern: '/v1/health',
    handler: async () => ({
      ok: true,
      db: config.db.path,
      gateway: (await gatewayUp()) ? 'up' : 'down',
      sources: sourceStates(),
      now: Date.now(),
    }),
  },

  {
    method: 'GET',
    pattern: '/v1/attention',
    handler: () => {
      const jobs = attention();
      const reviews = db().prepare('SELECT COUNT(*) AS n FROM gh_reviews').get() as { n: number };
      const down = db()
        .prepare('SELECT name FROM claw_channels WHERE connected = 0')
        .all() as unknown as { name: string }[];
      return {
        jobs,
        reviewsWaiting: reviews.n,
        channelsDown: down.map((c) => c.name),
        counts: { jobs: jobs.length, reviews: reviews.n, channelsDown: down.length },
        now: Date.now(),
      };
    },
  },

  {
    method: 'GET',
    pattern: '/v1/jobs',
    handler: () => {
      const jobs = allJobs();
      return {
        jobs,
        counts: {
          total: jobs.length,
          failing: jobs.filter((j) => j.state === 'error').length,
          overdue: jobs.filter((j) => j.state === 'overdue').length,
          disabled: jobs.filter((j) => j.state === 'disabled').length,
        },
        ...freshness(SOURCES.cron),
      };
    },
  },

  {
    method: 'GET',
    pattern: '/v1/jobs/:id',
    handler: (_req, params) => {
      const job = jobById(params.id ?? '');
      if (!job) return { error: 'not found', id: params.id };
      const runs = db()
        .prepare(
          `SELECT started_at, duration_ms, status, error
             FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 10`,
        )
        .all(job.id) as unknown as { status: string }[];
      const okCount = runs.filter((r) => r.status === 'ok').length;
      return {
        job,
        runs,
        recent: { total: runs.length, ok: okCount, failed: runs.length - okCount },
        ...freshness(SOURCES.cron),
      };
    },
  },

  {
    method: 'GET',
    pattern: '/v1/gh/summary',
    handler: () => {
      const repos = db()
        .prepare('SELECT * FROM gh_repos ORDER BY name')
        .all() as unknown as Record<string, unknown>[];
      const reviews = db()
        .prepare(
          'SELECT repo, account, number, title FROM gh_reviews ORDER BY requested_at DESC LIMIT 20',
        )
        .all() as unknown as { account: string | null }[];
      // Distinct accounts, so the glasses can offer a filter without knowing
      // the shim's configuration.
      const accounts = (
        db()
          .prepare('SELECT DISTINCT account FROM gh_repos WHERE account IS NOT NULL ORDER BY account')
          .all() as unknown as { account: string }[]
      ).map((r) => r.account);
      return {
        repos,
        reviews,
        reviewsWaiting: reviews.length,
        accounts,
        ...freshness(SOURCES.github),
      };
    },
  },

  {
    // Detail for one repo. `:name` is the bare repo name or the full owner/repo —
    // the glasses only ever have the short one, since that is what fits on screen.
    method: 'GET',
    pattern: '/v1/gh/repo/:name',
    handler: (_req, params) => {
      const q = params.name ?? '';
      const repo = db()
        .prepare(`SELECT * FROM gh_repos WHERE name = ? OR name LIKE ? LIMIT 1`)
        .get(q, `%/${q}`) as Record<string, unknown> | undefined;
      if (!repo) return { error: 'not found', name: q };
      const full = String(repo.name);
      return {
        repo,
        prs: db()
          .prepare(
            `SELECT number, title, author, state, draft, branch, updated_at
               FROM gh_prs WHERE repo = ? ORDER BY updated_at DESC LIMIT 10`,
          )
          .all(full),
        runs: db()
          .prepare(
            `SELECT run_id, name, branch, event, status, conclusion, started_at, duration_ms
               FROM gh_runs WHERE repo = ? ORDER BY started_at DESC LIMIT 10`,
          )
          .all(full),
        branches: db()
          .prepare(
            `SELECT name, sha, last_run_at, last_run_status
               FROM gh_branches WHERE repo = ? ORDER BY last_run_at DESC LIMIT 10`,
          )
          .all(full),
        ...freshness(SOURCES.github),
      };
    },
  },

  {
    method: 'GET',
    pattern: '/v1/claw/summary',
    handler: () => {
      const channels = db().prepare('SELECT * FROM claw_channels ORDER BY name').all();
      const sessions = db()
        .prepare('SELECT * FROM claw_sessions ORDER BY last_at DESC LIMIT 5')
        .all();
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const today = db()
        .prepare('SELECT COUNT(*) AS n FROM claw_activity WHERE at >= ?')
        .get(since) as { n: number };
      return { channels, sessions, actionsToday: today.n, ...freshness(SOURCES.sessions) };
    },
  },

  {
    method: 'GET',
    pattern: '/v1/claw/today',
    handler: () => {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const items = db()
        .prepare('SELECT * FROM claw_activity WHERE at >= ? ORDER BY at DESC LIMIT 50')
        .all(since);
      return { items, ...freshness(SOURCES.sessions) };
    },
  },

  // ── Fact check ──────────────────────────────────────────────────────

  {
    method: 'POST',
    pattern: '/v1/check',
    handler: async (req) => {
      const body = (req as PostRequest)._parsedBody as
        | { text?: string; audio?: string }
        | undefined;
      if (!body || (!body.text && !body.audio)) {
        return { error: 'body must include "text" or "audio"' };
      }
      return await runCheck(body);
    },
  },

  {
    method: 'GET',
    pattern: '/v1/checks',
    handler: () => {
      const checks = recentChecks(20);
      const snippetCount = (
        db().prepare('SELECT COUNT(*) AS n FROM context_snippets').get() as { n: number }
      ).n;
      const sources = (
        db()
          .prepare('SELECT DISTINCT source FROM context_snippets')
          .all() as unknown as { source: string }[]
      ).map((r) => r.source);
      return {
        checks,
        context: { snippets: snippetCount, sources },
        ...freshness(SOURCES.context),
      };
    },
  },

  {
    method: 'GET',
    pattern: '/v1/context/stats',
    handler: () => {
      const total = (
        db().prepare('SELECT COUNT(*) AS n FROM context_snippets').get() as { n: number }
      ).n;
      const bySource = db()
        .prepare(
          `SELECT source, COUNT(*) AS count, MIN(ts) AS oldest, MAX(ts) AS newest
           FROM context_snippets GROUP BY source`,
        )
        .all() as unknown as Array<{
        source: string;
        count: number;
        oldest: number;
        newest: number;
      }>;
      return { total, bySource, ...freshness(SOURCES.context) };
    },
  },
];
