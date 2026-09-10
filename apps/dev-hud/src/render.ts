import type { ClawResponse, GhRepo, GhResponse, JobsResponse, JobView } from './client.js';

/**
 * Turns API payloads into the four lines a screen shows.
 *
 * Kept free of any SDK import so it can be unit-tested and previewed on a
 * terminal — the shim's `npm run show` renders the same shapes at the same
 * width, which is a far faster loop than putting glasses on.
 */

/** Characters that fit comfortably on one 576×288 line. */
export const LINE = 40;

export type Row = { text: string; brightness: number };
export type ScreenView = { header: string; rows: Row[]; footer: string };

/**
 * Brightness is the only visual channel — there is no colour. It carries
 * urgency, so that "is anything broken?" is answerable from peripheral vision
 * before a single word is read.
 */
export const BRIGHT = { alert: 4, active: 3, healthy: 2, dim: 1 } as const;

export function fit(s: string, n = LINE): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return '—';
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return 'now';
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const JOB_GLYPH: Record<JobView['state'], string> = {
  error: '✗', overdue: '⏱', running: '●', ok: '✓', disabled: '⏸', unknown: '·',
};

const JOB_BRIGHT: Record<JobView['state'], number> = {
  error: BRIGHT.alert,
  overdue: BRIGHT.alert,
  running: BRIGHT.active,
  ok: BRIGHT.healthy,
  unknown: BRIGHT.dim,
  disabled: BRIGHT.dim,
};

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

export function jobsScreen(d: JobsResponse): ScreenView {
  const bad = d.counts.failing + d.counts.overdue;
  const rows: Row[] = d.jobs.slice(0, 3).map((j) => {
    const detail =
      j.state === 'error' ? `${j.reason ?? 'err'} ×${j.consecutiveFailures}`
      : j.state === 'overdue' ? `overdue ${Math.round((j.overdueByMs ?? 0) / 60000)}m`
      : j.state === 'disabled' ? 'disabled'
      : ago(j.lastRunAt);
    return {
      text: `${JOB_GLYPH[j.state]} ${pad(j.name, 24)} ${detail}`,
      brightness: JOB_BRIGHT[j.state],
    };
  });

  // The footer carries the failure nothing else nags you about.
  const worst = d.jobs.find((j) => j.state === 'error' || j.state === 'overdue');
  return {
    header: `Jobs · ${d.counts.total}${bad ? ` · ${bad} need you` : ''}${d.stale ? ' ⚠' : ''}`,
    rows,
    footer: worst?.errorBrief ?? (bad ? 'see detail' : 'all healthy'),
  };
}

const CI_GLYPH: Record<string, string> = {
  failing: '✗', building: '●', passing: '✓', unknown: '·',
};
const CI_BRIGHT: Record<string, number> = {
  failing: BRIGHT.alert, building: BRIGHT.active, passing: BRIGHT.healthy, unknown: BRIGHT.dim,
};

/**
 * `account` narrows the view to one identity. Work and personal repos answer
 * different questions — "is the team's build broken" versus "is my side project
 * broken" — and three visible rows is not enough to mix them.
 */
export function githubScreen(d: GhResponse, account: string | null = null): ScreenView {
  const repos = account ? d.repos.filter((r) => r.account === account) : d.repos;
  const reviews = account ? d.reviews.filter((r) => r.account === account) : d.reviews;
  const rows: Row[] = repos.slice(0, 3).map((r) => {
    const short = r.name.split('/')[1] ?? r.name;
    const state = r.ci_state ?? 'unknown';
    return {
      text: `${CI_GLYPH[state] ?? '·'} ${pad(short, 20)} ${pad(r.ci_job ?? state, 11)} ${ago(r.ci_at)}`,
      brightness: CI_BRIGHT[state] ?? BRIGHT.dim,
    };
  });
  return {
    header: `GitHub${account ? ` · ${account}` : ''} · ${ago(d.fetchedAt)}${d.stale ? ' ⚠' : ''}`,
    rows,
    // A red build finds you eventually; a pending review just blocks someone else.
    footer: reviews.length > 0
      ? `${reviews.length} PR${reviews.length === 1 ? '' : 's'} waiting on you`
      : 'no PRs waiting on you',
  };
}

/** Repos for the current filter — the list container must match what is rendered. */
export function githubRepos(d: GhResponse, account: string | null): GhRepo[] {
  return account ? d.repos.filter((r) => r.account === account) : d.repos;
}

export function clawScreen(d: ClawResponse): ScreenView {
  const down = d.channels.filter((c) => !c.connected);
  const chLine = d.channels.length
    ? d.channels.map((c) => `${c.connected ? '✓' : '✗'} ${c.name}`).join('   ')
    : '· channel health unavailable';

  const rows: Row[] = [
    { text: chLine, brightness: down.length ? BRIGHT.alert : BRIGHT.healthy },
    { text: `${d.actionsToday} actions today · ${d.sessions.length} sessions`, brightness: BRIGHT.healthy },
  ];

  const top = d.sessions[0];
  if (top) {
    const ctx = top.ctx_pct !== null ? `${Math.round(top.ctx_pct)}% ctx` : '';
    const tok = top.tokens !== null ? `${Math.round((top.tokens ?? 0) / 1000)}k tok` : '';
    rows.push({ text: `${pad(top.agent ?? top.key, 16)} ${ctx} ${tok}`.trim(), brightness: BRIGHT.dim });
  }

  return {
    header: `OpenClaw · ${d.fetchedAt ? ago(d.fetchedAt) : 'not configured'}${d.stale ? ' ⚠' : ''}`,
    rows,
    // If a channel silently drops, the whole command path is dead and the
    // silence reads as "the agent is thinking".
    footer: down.length ? `${down.map((c) => c.name).join(', ')} disconnected` : (d.error ?? 'channels ok'),
  };
}

export function errorScreen(title: string, message: string, cachedAt: number | null): ScreenView {
  return {
    header: `${title} ⚠`,
    rows: [
      { text: message, brightness: BRIGHT.alert },
      cachedAt
        ? { text: `showing cached from ${ago(cachedAt)} ago`, brightness: BRIGHT.dim }
        : { text: 'no cached data', brightness: BRIGHT.dim },
    ],
    footer: message === 'no connection' ? 'check Tailscale on your phone' : 'long press to retry',
  };
}

// ── Detail screens ─────────────────────────────────────────────────────────
// Reached by clicking a row in the list. The list stays on screen so you can
// move straight to the next item without going back first.

import type { JobDetail, RepoDetail } from './client.js';

export function jobDetailScreen(d: JobDetail): ScreenView {
  const j = d.job;
  const when = j.lastRunAt ? `${ago(j.lastRunAt)} ago` : 'never run';
  const dur = j.lastDurationMs ? `${(j.lastDurationMs / 1000).toFixed(1)}s` : '—';

  const rows: Row[] = [
    {
      text: `${JOB_GLYPH[j.state]} ${j.state}${j.reason ? ` · ${j.reason}` : ''}${
        j.consecutiveFailures ? ` · ${j.consecutiveFailures} in a row` : ''
      }`,
      brightness: JOB_BRIGHT[j.state],
    },
    { text: `last ${when} · ${dur} · ${j.scheduleExpr ?? 'no schedule'}`, brightness: BRIGHT.dim },
    {
      text: j.errorBrief ?? `last 10 runs: ${d.recent.ok} ok, ${d.recent.failed} failed`,
      brightness: j.errorBrief ? BRIGHT.alert : BRIGHT.healthy,
    },
  ];

  return {
    header: fit(j.name),
    rows,
    footer:
      j.state === 'overdue'
        ? `overdue by ${Math.round((j.overdueByMs ?? 0) / 60000)}m — it is not running`
        : `${d.recent.ok}/${d.recent.total} of the last runs succeeded`,
  };
}

/** Repo detail cycles through three views; one screen cannot hold all of it. */
export type RepoTab = 'prs' | 'runs' | 'branches';

export function repoDetailScreen(d: RepoDetail, tab: RepoTab): ScreenView {
  const short = d.repo.name.split('/')[1] ?? d.repo.name;

  if (tab === 'prs') {
    return {
      header: fit(`${short} · PRs (${d.prs.length})`),
      rows: d.prs.slice(0, 3).map((p) => ({
        text: `#${p.number} ${pad(p.title, 26)} ${p.state}`,
        brightness: p.state === 'open' ? BRIGHT.active : BRIGHT.dim,
      })),
      footer: `${d.repo.open_prs ?? 0} open · menu to switch view`,
    };
  }

  if (tab === 'runs') {
    return {
      header: fit(`${short} · Actions (${d.runs.length})`),
      rows: d.runs.slice(0, 3).map((r) => {
        const outcome = r.conclusion ?? r.status;
        return {
          text: `${outcome === 'success' ? '✓' : outcome === 'failure' ? '✗' : '●'} ${pad(r.name, 24)} ${ago(r.started_at)}`,
          brightness: outcome === 'failure' ? BRIGHT.alert : outcome === 'success' ? BRIGHT.healthy : BRIGHT.active,
        };
      }),
      footer: `${d.runs.filter((r) => r.conclusion === 'failure').length} of last ${d.runs.length} failed`,
    };
  }

  return {
    header: fit(`${short} · branches (${d.branches.length})`),
    rows: [
      ...d.branches.slice(0, 2).map((b) => ({
        text: `${b.last_run_status === 'failure' ? '✗' : '✓'} ${pad(b.name, 24)} ${ago(b.last_run_at)}`,
        brightness: b.last_run_status === 'failure' ? BRIGHT.alert : BRIGHT.healthy,
      })),
      {
        text: `${d.repo.head_sha ?? '—'} ${pad(d.repo.head_msg ?? '', 28)}`,
        brightness: BRIGHT.dim,
      },
    ],
    footer: d.repo.head_author ? `head by ${d.repo.head_author} · ${ago(d.repo.head_at)}` : 'no commit data',
  };
}
