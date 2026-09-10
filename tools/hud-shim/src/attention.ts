import { config } from './config.ts';
import { db, type JobRow } from './db.ts';

/**
 * The cross-source "what deserves my attention" query.
 *
 * The clause that matters is `overdue`. A job that never fires writes no run
 * row, and "no rows" is indistinguishable from "all fine" — so the registry
 * carries `next_due_at` and we detect *silence*, not just failure. Without it a
 * job sitting in exponential backoff (30s → 1m → 5m → 15m → 60m) reads as idle
 * rather than broken, which is exactly how a job fails for months unnoticed.
 */

export type JobState = 'error' | 'overdue' | 'running' | 'disabled' | 'ok' | 'unknown';

export type JobView = {
  id: string;
  source: string;
  name: string;
  state: JobState;
  enabled: boolean;
  agent: string | null;
  scheduleExpr: string | null;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  nextDueAt: number | null;
  overdueByMs: number | null;
  consecutiveFailures: number;
  /** Short, glanceable: "auth", "timeout". This is what the HUD shows. */
  reason: string | null;
  /** The human clause of the error, already trimmed for a 576×288 display. */
  errorBrief: string | null;
  /** Full text, for the detail screen and for debugging. */
  error: string | null;
};

/**
 * `lastError` runs to hundreds of characters of stack-adjacent text. The glasses
 * get roughly forty. Strip the exception class prefix and keep the sentence a
 * human wrote.
 */
export function briefError(raw: string | null, max = 64): string | null {
  if (!raw) return null;
  let s = raw.trim();

  // "FallbackSummaryError: All models failed (3): anthropic/...: LLM request
  // rejected: You're out of extra usage." -> keep the last meaningful clause.
  s = s.replace(/^[A-Za-z_$][\w$]*(Error|Exception):\s*/, '');

  // Multi-model fallback errors chain provider failures with " | ". The first
  // one is representative; the rest are the same story.
  const firstBranch = s.split(' | ')[0];
  if (firstBranch) s = firstBranch;

  // Drop a leading "All models failed (n): provider/model:" preamble.
  s = s.replace(/^All models failed \(\d+\):\s*[^:]+:\s*/, '');

  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * Grace before a missed run counts as overdue. Scales with the job's own cadence
 * so a 15-minute job isn't judged by the same window as a nightly one, with a
 * floor so a slow start doesn't flap.
 */
function graceFor(job: JobRow): number {
  const { overdueGraceMs, overdueGraceFactor } = config.thresholds;
  if (job.last_run_at && job.next_due_at && job.next_due_at > job.last_run_at) {
    const interval = job.next_due_at - job.last_run_at;
    return Math.max(overdueGraceMs, interval * overdueGraceFactor);
  }
  return overdueGraceMs;
}

export function classify(job: JobRow, now = Date.now()): { state: JobState; overdueByMs: number | null } {
  if (!job.enabled) return { state: 'disabled', overdueByMs: null };

  const overdueBy =
    job.next_due_at !== null ? now - (job.next_due_at + graceFor(job)) : null;
  const isOverdue = overdueBy !== null && overdueBy > 0;

  if (job.last_status === 'error' || job.consecutive_failures > 0) {
    return { state: 'error', overdueByMs: isOverdue ? overdueBy : null };
  }
  if (isOverdue) return { state: 'overdue', overdueByMs: overdueBy };
  if (job.last_status === 'running') return { state: 'running', overdueByMs: null };
  if (job.last_status === 'ok') return { state: 'ok', overdueByMs: null };
  return { state: 'unknown', overdueByMs: null };
}

function toView(job: JobRow, now: number): JobView {
  const { state, overdueByMs } = classify(job, now);
  return {
    id: job.id,
    source: job.source,
    name: job.name,
    state,
    enabled: job.enabled === 1,
    agent: job.agent,
    scheduleExpr: job.schedule_expr,
    lastRunAt: job.last_run_at,
    lastDurationMs: job.last_duration_ms,
    nextDueAt: job.next_due_at,
    overdueByMs,
    consecutiveFailures: job.consecutive_failures,
    reason: job.last_reason,
    errorBrief: briefError(job.last_error),
    error: job.last_error,
  };
}

const SEVERITY: Record<JobState, number> = {
  error: 0,
  overdue: 1,
  running: 2,
  unknown: 3,
  ok: 4,
  disabled: 5,
};

export function allJobs(now = Date.now()): JobView[] {
  const rows = db()
    .prepare('SELECT * FROM jobs ORDER BY name')
    .all() as unknown as JobRow[];
  return rows
    .map((r) => toView(r, now))
    .sort((a, b) =>
      SEVERITY[a.state] !== SEVERITY[b.state]
        ? SEVERITY[a.state] - SEVERITY[b.state]
        : a.name.localeCompare(b.name),
    );
}

export function jobById(id: string, now = Date.now()): JobView | null {
  const row = db().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as
    | JobRow
    | undefined;
  return row ? toView(row, now) : null;
}

/** Only what needs a human. Drives the footer line on every screen. */
export function attention(now = Date.now()): JobView[] {
  return allJobs(now).filter((j) => j.state === 'error' || j.state === 'overdue');
}
