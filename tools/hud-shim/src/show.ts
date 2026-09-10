import { config } from './config.ts';

/**
 * Renders every HUD screen in the terminal at the real width, by calling the
 * shim's own HTTP API — the same endpoints the glasses hit. So this exercises
 * auth, routing, and payload shape, not just the database.
 *
 * Usage:
 *   npm run show                 every screen, plus one drill-down of each kind
 *   npm run show -- jobs         jobs summary + detail for the worst job
 *   npm run show -- repo <name>  repo detail: PRs, Actions, branches
 *
 * Formatting is intentionally duplicated from `apps/dev-hud/src/render.ts`
 * rather than shared: Node does not strip types inside `node_modules`, so a
 * workspace package of `.ts` source is not importable here. Keep the two in step
 * when you change a row format.
 */

const W = 40;
const BASE = `http://${config.host}:${config.port}`;

const fit = (s: string, n = W) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

function ago(ms: number | null | undefined): string {
  if (!ms) return '—';
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return 'now';
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function frame(title: string, rows: string[], footer: string): void {
  console.log(`┌${'─'.repeat(W + 2)}┐`);
  console.log(`│ ${pad(title, W)} │`);
  for (let i = 0; i < 3; i++) console.log(`│ ${pad(rows[i] ?? '', W)} │`);
  console.log(`│ ${' '.repeat(W)} │`);
  console.log(`│ ${pad(footer, W)} │`);
  console.log(`└${'─'.repeat(W + 2)}┘\n`);
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${config.hudToken ?? ''}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return (await res.json()) as T;
}

type Job = {
  id: string; name: string; state: string; reason: string | null; errorBrief: string | null;
  consecutiveFailures: number; lastRunAt: number | null; lastDurationMs: number | null;
  overdueByMs: number | null; scheduleExpr: string | null;
};

const JOB_GLYPH: Record<string, string> = {
  error: '✗', overdue: '⏱', running: '●', ok: '✓', disabled: '⏸', unknown: '·',
};

async function showJobs(withDetail: boolean): Promise<void> {
  const d = await api<{ jobs: Job[]; counts: Record<string, number>; stale: boolean }>('/v1/jobs');
  const bad = (d.counts.failing ?? 0) + (d.counts.overdue ?? 0);
  frame(
    `Jobs · ${d.counts.total}${bad ? ` · ${bad} need you` : ''}${d.stale ? ' ⚠' : ''}`,
    d.jobs.map((j) => {
      const detail =
        j.state === 'error' ? `${j.reason ?? 'err'} ×${j.consecutiveFailures}`
        : j.state === 'overdue' ? `overdue ${Math.round((j.overdueByMs ?? 0) / 60000)}m`
        : j.state === 'disabled' ? 'disabled' : ago(j.lastRunAt);
      return `${JOB_GLYPH[j.state] ?? '·'} ${pad(j.name, 24)} ${detail}`;
    }),
    d.jobs.find((j) => j.errorBrief)?.errorBrief ?? (bad ? 'see detail' : 'all healthy'),
  );

  if (!withDetail || !d.jobs[0]) return;
  const worst = d.jobs[0];
  console.log(`   ↓ click "${worst.name}"\n`);
  const det = await api<{ job: Job; recent: { total: number; ok: number; failed: number } }>(
    `/v1/jobs/${encodeURIComponent(worst.id)}`,
  );
  const j = det.job;
  frame(
    j.name,
    [
      `${JOB_GLYPH[j.state] ?? '·'} ${j.state}${j.reason ? ` · ${j.reason}` : ''}${
        j.consecutiveFailures ? ` · ${j.consecutiveFailures} in a row` : ''
      }`,
      `last ${ago(j.lastRunAt)} ago · ${
        j.lastDurationMs ? `${(j.lastDurationMs / 1000).toFixed(1)}s` : '—'
      } · ${j.scheduleExpr ?? 'no schedule'}`,
      j.errorBrief ?? `last 10: ${det.recent.ok} ok, ${det.recent.failed} failed`,
    ],
    `${det.recent.ok}/${det.recent.total} of the last runs succeeded`,
  );
}

type Repo = {
  name: string; account: string | null;
  ci_state: string | null; ci_job: string | null; ci_at: number | null;
};

const CI_GLYPH: Record<string, string> = {
  failing: '✗', building: '●', passing: '✓', unknown: '·',
};

async function showGithub(withDetail: boolean, account: string | null = null): Promise<void> {
  const d = await api<{
    repos: Repo[];
    reviews: { account: string | null }[];
    accounts: string[];
    fetchedAt: number;
    stale: boolean;
  }>('/v1/gh/summary');

  const repos = account ? d.repos.filter((r) => r.account === account) : d.repos;
  const reviews = account ? d.reviews.filter((r) => r.account === account) : d.reviews;

  frame(
    `GitHub${account ? ` · ${account}` : ''} · ${ago(d.fetchedAt)}${d.stale ? ' ⚠' : ''}`,
    repos.map((r) => {
      const short = r.name.split('/')[1] ?? r.name;
      const state = r.ci_state ?? 'unknown';
      return `${CI_GLYPH[state] ?? '·'} ${pad(short, 20)} ${pad(r.ci_job ?? state, 11)} ${ago(r.ci_at)}`;
    }),
    reviews.length > 0 ? `${reviews.length} PRs waiting on you` : 'no PRs waiting on you',
  );

  if (!account && d.accounts.length > 1) {
    console.log(`   accounts: ${d.accounts.join(' · ')}   (menu "Account" cycles these)\n`);
  }

  if (!withDetail || !repos[0]) return;
  const short = repos[0].name.split('/')[1] ?? repos[0].name;
  console.log(`   ↓ click "${short}"\n`);
  await showRepo(short);
}

type RepoDetail = {
  repo: Repo & {
    open_prs: number | null; head_sha: string | null; head_msg: string | null;
    head_author: string | null; head_at: number | null;
  };
  prs: { number: number; title: string; state: string; branch: string }[];
  runs: { name: string; branch: string; status: string; conclusion: string | null; started_at: number }[];
  branches: { name: string; last_run_at: number; last_run_status: string | null }[];
};

export async function showRepo(name: string): Promise<void> {
  const d = await api<RepoDetail>(`/v1/gh/repo/${encodeURIComponent(name)}`);
  const short = d.repo.name.split('/')[1] ?? d.repo.name;

  frame(
    `${short} · PRs (${d.prs.length})`,
    d.prs.map((p) => `#${p.number} ${pad(p.title, 26)} ${p.state}`),
    `${d.repo.open_prs ?? 0} open · menu to switch view`,
  );

  frame(
    `${short} · Actions (${d.runs.length})`,
    d.runs.map((r) => {
      const o = r.conclusion ?? r.status;
      const g = o === 'success' ? '✓' : o === 'failure' ? '✗' : '●';
      return `${g} ${pad(r.name, 24)} ${ago(r.started_at)}`;
    }),
    `${d.runs.filter((r) => r.conclusion === 'failure').length} of last ${d.runs.length} failed`,
  );

  frame(
    `${short} · branches (${d.branches.length})`,
    [
      ...d.branches.slice(0, 2).map(
        (b) => `${b.last_run_status === 'failure' ? '✗' : '✓'} ${pad(b.name, 24)} ${ago(b.last_run_at)}`,
      ),
      `${d.repo.head_sha ?? '—'} ${pad(d.repo.head_msg ?? '', 28)}`,
    ],
    d.repo.head_author ? `head by ${d.repo.head_author} · ${ago(d.repo.head_at)}` : 'no commit data',
  );
}

async function showClaw(): Promise<void> {
  const d = await api<{
    channels: { name: string; connected: number }[];
    sessions: unknown[];
    actionsToday: number;
    fetchedAt: number | null;
    error: string | null;
  }>('/v1/claw/summary');
  const down = d.channels.filter((c) => !c.connected);
  frame(
    `OpenClaw · ${d.fetchedAt ? ago(d.fetchedAt) : 'not configured'}`,
    [
      d.channels.length
        ? d.channels.map((c) => `${c.connected ? '✓' : '✗'} ${c.name}`).join('   ')
        : '· channel health unavailable',
      `${d.actionsToday} actions today · ${d.sessions.length} sessions`,
    ],
    down.length ? `${down.map((c) => c.name).join(', ')} disconnected` : (d.error ?? 'channels ok'),
  );
}

// ── entry ──────────────────────────────────────────────────────────────────
const [what, arg] = process.argv.slice(2);

try {
  if (what === 'repo' && arg) await showRepo(arg);
  else if (what === 'jobs') await showJobs(true);
  else if (what === 'github') await showGithub(true, arg ?? null);
  else if (what === 'openclaw') await showClaw();
  else {
    await showJobs(true);
    await showGithub(true);
    await showClaw();
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${msg}\n`);
  console.error(`  The shim must be running: ./scripts/devhud status\n`);
  process.exit(1);
}
