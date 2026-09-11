/**
 * Browser simulator for the Dev HUD glasses app.
 *
 * Exercises the same render functions and API client as main.ts, but renders
 * to a DOM element instead of the glasses. Every bridge call that main.ts
 * would make is logged with timing so we can spot the patterns that crash
 * the real SDK.
 */

import {
  api, ShimError,
  type ClawResponse, type GhResponse, type JobDetail, type JobsResponse, type RepoDetail,
} from './client.js';
import {
  clawScreen, errorScreen, githubRepos, githubScreen, jobDetailScreen,
  jobsScreen, repoDetailScreen, type RepoTab, type ScreenView,
} from './render.js';
import { readCache, writeCache } from './cache.js';

type ScreenName = 'jobs' | 'github' | 'openclaw';

const MENU = { jobs: 1, github: 2, openclaw: 3, account: 4, view: 5, back: 6, refresh: 7 } as const;
const POLL_MS = 3000;

let current: ScreenName = 'jobs';
let detail: string | null = null;
let repoTab: RepoTab = 'prs';
let ghAccount: string | null = null;
let busy = false;

// ── Simulated glasses display ────────────────────────────────────────────

const BRIGHTNESS_MAP: Record<number, string> = {
  0: '#111', 1: '#666', 2: '#999', 3: '#ccc', 4: '#fff',
};

type SimContainer = { name: string; x: number; y: number; w: number; h: number; type: 'text' | 'list' };

let containers: SimContainer[] = [];
let textContent: Record<string, { content: string; brightness: number }> = {};
let listItems: string[] = [];
let selectedListIndex = 0;

function bridgeLog(method: string, detail: string): void {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
  const el = document.getElementById('bridge-log')!;
  const line = document.createElement('div');
  line.textContent = `${t}  ${method}  ${detail}`;
  line.className = method === 'ERROR' ? 'err' : '';
  el.prepend(line);
  if (el.childNodes.length > 200) el.lastChild?.remove();
}

function stateLog(msg: string): void {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
  const el = document.getElementById('state-log')!;
  const line = document.createElement('div');
  line.textContent = `${t}  ${msg}`;
  el.prepend(line);
  if (el.childNodes.length > 200) el.lastChild?.remove();
}

function renderDisplay(): void {
  const canvas = document.getElementById('display') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const scale = 2;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 576 * scale, 288 * scale);

  for (const c of containers) {
    if (c.type === 'text') {
      const t = textContent[c.name];
      if (!t || !t.content) continue;
      ctx.fillStyle = BRIGHTNESS_MAP[t.brightness] ?? '#fff';
      ctx.font = `${14 * scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillText(t.content, c.x * scale, (c.y + 18) * scale, c.w * scale);
    } else if (c.type === 'list') {
      for (let i = 0; i < listItems.length && i < 3; i++) {
        const isSelected = i === selectedListIndex;
        ctx.fillStyle = isSelected ? '#fff' : '#888';
        ctx.font = `${12 * scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        const itemY = c.y + 16 + i * 16;
        if (isSelected) {
          ctx.fillStyle = '#333';
          ctx.fillRect(c.x * scale, (itemY - 12) * scale, c.w * scale, 16 * scale);
          ctx.fillStyle = '#fff';
        }
        ctx.fillText(listItems[i] ?? '', c.x * scale, itemY * scale, c.w * scale);
      }
      if (listItems.length > 3) {
        ctx.fillStyle = '#444';
        ctx.font = `${10 * scale}px monospace`;
        ctx.fillText(`… +${listItems.length - 3} more`, c.x * scale, (c.y + 16 + 3 * 16) * scale);
      }
    }
  }
}

// ── Mock bridge operations ───────────────────────────────────────────────

function mockMount(items: string[], view?: ScreenView): void {
  bridgeLog('createStartUpPageContainer', `${containers.length || 6} containers`);
  applyPage(items, view);
  renderDisplay();
}

function mockRebuild(items: string[], view?: ScreenView): void {
  bridgeLog('rebuildPageContainer', `${items.length} items`);
  applyPage(items, view);
  renderDisplay();
}

function mockSetText(name: string, content: string, brightness: number): void {
  bridgeLog('textContainerUpgrade', `"${name}" = "${content.slice(0, 40)}${content.length > 40 ? '…' : ''}" b=${brightness}`);
  textContent[name] = { content, brightness };
  renderDisplay();
}

function applyPage(items: string[], view?: ScreenView): void {
  containers = [
    { name: 'header', x: 24, y: 18, w: 528, h: 30, type: 'text' },
    { name: 'row1', x: 24, y: 56, w: 528, h: 30, type: 'text' },
    { name: 'row2', x: 24, y: 90, w: 528, h: 30, type: 'text' },
    { name: 'row3', x: 24, y: 124, w: 528, h: 30, type: 'text' },
    { name: 'items', x: 24, y: 158, w: 528, h: 46, type: 'list' },
    { name: 'footer', x: 24, y: 212, w: 528, h: 30, type: 'text' },
  ];
  textContent = {
    header: { content: view?.header ?? 'Dev HUD', brightness: 3 },
    row1: { content: view?.rows[0]?.text ?? '', brightness: view?.rows[0]?.brightness ?? 1 },
    row2: { content: view?.rows[1]?.text ?? '', brightness: view?.rows[1]?.brightness ?? 1 },
    row3: { content: view?.rows[2]?.text ?? '', brightness: view?.rows[2]?.brightness ?? 1 },
    footer: { content: view?.footer ?? '', brightness: 1 },
  };
  listItems = items.length ? items : ['—'];
  selectedListIndex = 0;
}

// ── State machine (mirrors main.ts) ─────────────────────────────────────

async function switchTo(next: ScreenName): Promise<void> {
  if (busy) { stateLog(`switch → ${next} BLOCKED (busy)`); return; }
  busy = true;
  try {
    current = next;
    detail = null;
    stateLog(`switch → ${next}`);

    const cached = readCache(next);
    const items = cached ? listFor(next, cached.data) : ['loading…'];
    const view = cached ? renderSummary(next, cached.data) : undefined;
    mockRebuild(items, view);
    stateLog(`rebuild done · ${items.length} items`);
  } catch (err) {
    stateLog(`switch err: ${err instanceof Error ? err.message : String(err)}`);
    bridgeLog('ERROR', String(err));
  } finally {
    busy = false;
  }
}

async function openIndex(idx: number): Promise<void> {
  const cached = readCache(current);
  if (!cached) return;
  if (current === 'jobs') {
    const jobs = (cached.data as JobsResponse).jobs;
    const picked = jobs[idx];
    if (picked) { detail = picked.id; stateLog(`drill → ${picked.name}`); void tick(); }
  } else if (current === 'github') {
    const repos = githubRepos(cached.data as GhResponse, ghAccount);
    const picked = repos[idx];
    if (picked) {
      detail = picked.name.split('/')[1] ?? picked.name;
      repoTab = 'prs';
      stateLog(`drill → ${detail}`);
      void tick();
    }
  }
}

async function cycleAccount(): Promise<void> {
  if (current !== 'github' || busy) return;
  busy = true;
  try {
    const cached = readCache('github');
    const accounts = cached ? ((cached.data as GhResponse).accounts ?? []) : [];
    if (accounts.length < 2) return;
    const order: (string | null)[] = [null, ...accounts];
    const idx = order.indexOf(ghAccount);
    ghAccount = order[(idx + 1) % order.length] ?? null;
    detail = null;
    stateLog(`account → ${ghAccount ?? 'all'}`);

    if (cached) {
      const items = listFor('github', cached.data);
      const view = renderSummary('github', cached.data);
      mockRebuild(items, view);
    }
  } catch (err) {
    stateLog(`account err: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    busy = false;
  }
}

function renderSummary(name: ScreenName, data: unknown): ScreenView {
  if (name === 'jobs') return jobsScreen(data as JobsResponse);
  if (name === 'github') return githubScreen(data as GhResponse, ghAccount);
  return clawScreen(data as ClawResponse);
}

function listFor(name: ScreenName, data: unknown): string[] {
  if (name === 'jobs') return (data as JobsResponse).jobs.map((j) => j.name);
  if (name === 'github') {
    return githubRepos(data as GhResponse, ghAccount).map((r) => r.name.split('/')[1] ?? r.name);
  }
  return (data as ClawResponse).channels.map((c) => c.name);
}

async function tick(): Promise<void> {
  if (busy) { stateLog('tick skipped (busy)'); return; }
  busy = true;
  const name = current;
  const item = detail;
  try {
    if (item) {
      stateLog(`fetching detail: ${name}/${item}`);
      const view =
        name === 'jobs'
          ? jobDetailScreen(await api.job(item) as JobDetail)
          : repoDetailScreen(await api.repo(item) as RepoDetail, repoTab);
      if (name !== current || item !== detail) { stateLog('stale, skip paint'); return; }
      await paint(view);
      return;
    }

    stateLog(`fetching ${name}…`);
    const data =
      name === 'jobs' ? await api.jobs() :
      name === 'github' ? await api.github() : await api.claw();
    if (name !== current || detail !== null) { stateLog('stale, skip paint'); return; }

    writeCache(name, data);
    await paint(renderSummary(name, data));
    stateLog(`painted ${name}`);
  } catch (err) {
    if (name !== current) return;
    const cached = readCache(name);
    const message = err instanceof ShimError ? err.message : 'error';
    stateLog(`tick error: ${message}`);
    await paint(errorScreen(titleOf(name), message, cached?.at ?? null));
  } finally {
    busy = false;
  }
}

function titleOf(name: ScreenName): string {
  return name === 'jobs' ? 'Jobs' : name === 'github' ? 'GitHub' : 'OpenClaw';
}

async function paint(view: ScreenView): Promise<void> {
  mockSetText('header', view.header, 3);
  const rows = ['row1', 'row2', 'row3'] as const;
  for (let i = 0; i < rows.length; i++) {
    const row = view.rows[i];
    mockSetText(rows[i]!, row?.text ?? '', row?.brightness ?? 1);
  }
  mockSetText('footer', view.footer, 1);
}

// ── Boot ─────────────────────────────────────────────────────────────────

function wireButtons(): void {
  const actions: Record<string, () => void> = {
    'btn-jobs': () => void switchTo('jobs'),
    'btn-github': () => void switchTo('github'),
    'btn-openclaw': () => void switchTo('openclaw'),
    'btn-account': () => void cycleAccount(),
    'btn-view': () => {
      repoTab = repoTab === 'prs' ? 'runs' : repoTab === 'runs' ? 'branches' : 'prs';
      stateLog(`view → ${repoTab}`);
      void tick();
    },
    'btn-back': () => { detail = null; stateLog('back'); void tick(); },
    'btn-refresh': () => { stateLog('refresh'); void tick(); },
    'btn-list-0': () => { selectedListIndex = 0; renderDisplay(); void openIndex(0); },
    'btn-list-1': () => { selectedListIndex = 1; renderDisplay(); void openIndex(1); },
    'btn-list-2': () => { selectedListIndex = 2; renderDisplay(); void openIndex(2); },
  };

  for (const [id, handler] of Object.entries(actions)) {
    document.getElementById(id)?.addEventListener('click', handler);
  }
}

async function boot(): Promise<void> {
  wireButtons();

  // Expose state for the status bar (sim.html reads these).
  const w = window as unknown as Record<string, unknown>;
  setInterval(() => {
    w.__sim_current = current;
    w.__sim_detail = detail;
    w.__sim_busy = busy;
    w.__sim_tab = repoTab;
  }, 100);

  stateLog('simulator started');

  const cached = readCache(current);
  const items = cached ? listFor(current, cached.data) : ['loading…'];
  const view = cached ? renderSummary(current, cached.data) : undefined;
  mockMount(items, view);
  stateLog('page mounted');

  await tick();

  setInterval(() => void tick(), POLL_MS);
  stateLog('poll started (3s)');
}

boot().catch((err) => {
  stateLog(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  bridgeLog('ERROR', String(err));
});
