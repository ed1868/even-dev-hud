/**
 * Client for the hud-shim.
 *
 * The token here is the glasses' own read-only credential — deliberately *not*
 * the GitHub token or the OpenClaw gateway token, which never leave the shim.
 * It is still a secret inlined into a web bundle, so this app is personal and
 * tailnet-only: never packed for distribution, never submitted to Even Hub.
 */

const BASE = (import.meta.env.VITE_HUD_BASE as string | undefined) ?? '';
const TOKEN = (import.meta.env.VITE_HUD_TOKEN as string | undefined) ?? '';

export class ShimError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'network' | 'server') {
    super(message);
    this.name = 'ShimError';
  }
}

export type JobView = {
  id: string;
  source: string;
  name: string;
  state: 'error' | 'overdue' | 'running' | 'disabled' | 'ok' | 'unknown';
  lastRunAt: number | null;
  overdueByMs: number | null;
  consecutiveFailures: number;
  reason: string | null;
  errorBrief: string | null;
};

export type JobsResponse = {
  jobs: JobView[];
  counts: { total: number; failing: number; overdue: number; disabled: number };
  fetchedAt: number | null;
  stale: boolean;
};

export type GhRepo = {
  name: string;
  account: string | null;
  ci_state: string | null;
  ci_job: string | null;
  ci_at: number | null;
};

export type GhResponse = {
  repos: GhRepo[];
  reviews: { repo: string; account: string | null; number: number; title: string }[];
  reviewsWaiting: number;
  /** Distinct accounts present, in order — drives the on-glasses filter. */
  accounts: string[];
  fetchedAt: number | null;
  stale: boolean;
};

export type ClawResponse = {
  channels: { name: string; connected: number }[];
  sessions: { key: string; agent: string | null; tokens: number | null; ctx_pct: number | null }[];
  actionsToday: number;
  fetchedAt: number | null;
  stale: boolean;
  error: string | null;
};

async function get<T>(path: string, timeoutMs = 4000): Promise<T> {
  if (!BASE || !TOKEN) {
    throw new ShimError('VITE_HUD_BASE / VITE_HUD_TOKEN not set — see .env.example', 'auth');
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
  } catch (err) {
    // The overwhelmingly likely cause is Tailscale being off on the phone, which
    // is worth naming: otherwise it reads as "the glasses are broken".
    throw new ShimError(
      err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'no connection',
      'network',
    );
  }
  if (res.status === 401) throw new ShimError('auth failed', 'auth');
  if (!res.ok) throw new ShimError(`server ${res.status}`, 'server');
  return (await res.json()) as T;
}

export type JobDetail = {
  job: JobView & {
    scheduleExpr: string | null;
    lastDurationMs: number | null;
    nextDueAt: number | null;
    agent: string | null;
    error: string | null;
  };
  recent: { total: number; ok: number; failed: number };
};

export type RepoDetail = {
  repo: {
    name: string;
    ci_state: string | null;
    ci_job: string | null;
    open_prs: number | null;
    head_sha: string | null;
    head_msg: string | null;
    head_author: string | null;
    head_at: number | null;
  };
  prs: { number: number; title: string; author: string; state: string; branch: string; updated_at: number }[];
  runs: { name: string; branch: string; status: string; conclusion: string | null; started_at: number }[];
  branches: { name: string; last_run_at: number; last_run_status: string | null }[];
};

export const api = {
  jobs: () => get<JobsResponse>('/v1/jobs'),
  job: (id: string) => get<JobDetail>(`/v1/jobs/${encodeURIComponent(id)}`),
  github: () => get<GhResponse>('/v1/gh/summary'),
  repo: (name: string) => get<RepoDetail>(`/v1/gh/repo/${encodeURIComponent(name)}`),
  claw: () => get<ClawResponse>('/v1/claw/summary'),
};
