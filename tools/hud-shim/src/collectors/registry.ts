import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { db, insertRun, upsertJob } from '../db.ts';
import { collectOpenClawCron, SOURCE as CRON_SOURCE } from './openclaw-cron.ts';
import { collectGitHub, SOURCE as GH_SOURCE } from './github.ts';
import {
  collectChannelHealth,
  collectOpenClawSessions,
  SOURCE as SESSIONS_SOURCE,
} from './openclaw-sessions.ts';

/**
 * Collector scheduler.
 *
 * Each collector registers itself in the `jobs` table and records a `runs` row on
 * every pass. That is not bookkeeping for its own sake: without it the thing
 * watching everything else is the one thing nobody watches, and it would fail in
 * exactly the silent way this whole design exists to catch. A stalled collector
 * shows up on the Jobs screen as overdue, like any other job.
 */

export type Collector = {
  id: string;
  name: string;
  intervalMs: number;
  run: () => Promise<unknown> | unknown;
};

export const collectors: Collector[] = [
  {
    id: CRON_SOURCE,
    name: 'Collector · OpenClaw cron',
    intervalMs: config.intervals.openclawCronMs,
    run: collectOpenClawCron,
  },
  {
    id: SESSIONS_SOURCE,
    name: 'Collector · OpenClaw sessions',
    intervalMs: config.intervals.openclawSessionsMs,
    run: async () => {
      const r = await collectOpenClawSessions();
      await collectChannelHealth();
      return r;
    },
  },
  {
    id: GH_SOURCE,
    name: 'Collector · GitHub',
    intervalMs: config.intervals.githubMs,
    run: collectGitHub,
  },
];

const jobId = (c: Collector) => `collector:${c.id}`;

/** Run one collector and write its own job/run rows. Never throws. */
export async function runCollector(c: Collector): Promise<void> {
  const startedAt = Date.now();
  let status = 'ok';
  let error: string | null = null;

  try {
    const result = (await c.run()) as { skipped?: string } | undefined;
    // "not configured" is a real state, not a failure — a source you have not
    // set up yet should read as unknown rather than as something broken.
    if (result?.skipped === 'not configured') status = 'unknown';
    else if (result?.skipped === 'error') status = 'error';
  } catch (err) {
    status = 'error';
    error = err instanceof Error ? err.message : String(err);
  }

  const finishedAt = Date.now();
  const duration = finishedAt - startedAt;

  upsertJob({
    id: jobId(c),
    source: 'hud-shim',
    external_id: c.id,
    name: c.name,
    schedule_expr: `every ${Math.round(c.intervalMs / 1000)}s`,
    enabled: 1,
    agent: null,
    next_due_at: finishedAt + c.intervalMs,
    last_run_at: startedAt,
    last_status: status,
    last_reason: error ? 'collector' : null,
    last_error: error,
    last_duration_ms: duration,
    consecutive_failures: status === 'error' ? previousFailures(jobId(c)) + 1 : 0,
    updated_at: finishedAt,
  });

  insertRun({
    id: randomUUID(),
    job_id: jobId(c),
    source: 'hud-shim',
    started_at: startedAt,
    duration_ms: duration,
    status,
    reason: error ? 'collector' : null,
    error,
    session_id: null,
    created_at: finishedAt,
  });
}

function previousFailures(id: string): number {
  const row = db()
    .prepare('SELECT consecutive_failures AS n FROM jobs WHERE id = ?')
    .get(id) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function startScheduler(): () => void {
  const timers = collectors.map((c) => {
    void runCollector(c);
    return setInterval(() => void runCollector(c), c.intervalMs);
  });
  return () => timers.forEach(clearInterval);
}

/** One pass over every collector, for `npm run collect`. */
export async function collectOnce(): Promise<void> {
  for (const c of collectors) await runCollector(c);
}
