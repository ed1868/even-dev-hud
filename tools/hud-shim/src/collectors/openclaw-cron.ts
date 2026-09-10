import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { insertRun, markSource, upsertJob } from '../db.ts';

/**
 * OpenClaw cron collector.
 *
 * Reads `~/.openclaw/cron/` directly off disk rather than through the gateway.
 * That is deliberate: `cron` sits on the gateway's HTTP deny list as a
 * "persistent automation control plane", and the tempting fix —
 * `gateway.tools.allow: ["cron"]` — would re-open the whole control plane over
 * HTTP just to read status. The collector is co-located, so it never needs a
 * privilege the gateway deliberately refuses to grant.
 */

export const SOURCE = 'openclaw-cron';

type CronSchedule = { kind?: string; expr?: string; at?: string | number; staggerMs?: number };

type CronState = {
  lastRunAtMs?: number;
  lastRunStatus?: string;
  lastStatus?: string;
  lastDurationMs?: number;
  lastError?: string;
  lastErrorReason?: string;
  lastDeliveryStatus?: string;
  nextRunAtMs?: number;
  consecutiveErrors?: number;
};

type CronJob = {
  id: string;
  name?: string;
  enabled?: boolean;
  agentId?: string;
  schedule?: CronSchedule;
  state?: CronState;
};

type RunRecord = {
  jobId?: string;
  runAtMs?: number;
  durationMs?: number;
  status?: string;
  error?: string;
  sessionId?: string;
  nextRunAtMs?: number;
  ts?: number;
};

function scheduleText(s: CronSchedule | undefined): string | null {
  if (!s) return null;
  if (s.expr) return s.expr;
  if (s.at !== undefined) return `at ${String(s.at)}`;
  return s.kind ?? null;
}

/**
 * Run records carry no id of their own, so derive a stable one. Collectors
 * re-read the same file tail on every pass; a content hash makes reinserts
 * idempotent without tracking file offsets.
 */
function runId(jobId: string, rec: RunRecord, line: string): string {
  const at = rec.runAtMs ?? rec.ts ?? 0;
  const digest = createHash('sha1').update(line).digest('hex').slice(0, 12);
  return `${SOURCE}:${jobId}:${at}:${digest}`;
}

function readJobs(cronDir: string): CronJob[] {
  const path = join(cronDir, 'jobs.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { jobs?: CronJob[] } | CronJob[];
  const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs ?? []);
  return jobs.filter((j): j is CronJob => Boolean(j && typeof j.id === 'string'));
}

/** Only the tail matters — the HUD shows recent runs, not the whole history. */
function readRuns(cronDir: string, jobId: string, limit: number): RunRecord[] {
  const path = join(cronDir, 'runs', `${jobId}.jsonl`);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-limit).flatMap((line) => {
    try {
      return [{ ...(JSON.parse(line) as RunRecord), __line: line } as RunRecord & { __line: string }];
    } catch {
      return [];
    }
  });
}

export function collectOpenClawCron(): { jobs: number; runs: number } {
  const dir = config.openclaw.cronDir;
  try {
    const jobs = readJobs(dir);
    const now = Date.now();
    let runCount = 0;

    for (const job of jobs) {
      const st = job.state ?? {};
      const id = `${SOURCE}:${job.id}`;

      upsertJob({
        id,
        source: SOURCE,
        external_id: job.id,
        name: job.name ?? job.id,
        schedule_expr: scheduleText(job.schedule),
        enabled: job.enabled === false ? 0 : 1,
        agent: job.agentId ?? null,
        next_due_at: st.nextRunAtMs ?? null,
        last_run_at: st.lastRunAtMs ?? null,
        last_status: st.lastRunStatus ?? st.lastStatus ?? null,
        last_reason: st.lastErrorReason ?? null,
        last_error: st.lastError ?? null,
        last_duration_ms: st.lastDurationMs ?? null,
        consecutive_failures: st.consecutiveErrors ?? 0,
        updated_at: now,
      });

      for (const rec of readRuns(dir, job.id, 50)) {
        const line = (rec as RunRecord & { __line?: string }).__line ?? JSON.stringify(rec);
        const startedAt = rec.runAtMs ?? rec.ts;
        if (!startedAt) continue;
        insertRun({
          id: runId(job.id, rec, line),
          job_id: id,
          source: SOURCE,
          started_at: startedAt,
          duration_ms: rec.durationMs ?? null,
          status: rec.status ?? 'unknown',
          reason: null,
          error: rec.error ?? null,
          session_id: rec.sessionId ?? null,
          created_at: now,
        });
        runCount += 1;
      }
    }

    markSource(SOURCE, true);
    return { jobs: jobs.length, runs: runCount };
  } catch (err) {
    markSource(SOURCE, false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
