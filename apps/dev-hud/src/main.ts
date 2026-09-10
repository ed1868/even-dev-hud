import { EvenApp, isEvenAppWebView } from '@even/core';
import { PageBuilder, Screen } from '@even/ui';
import {
  api, ShimError,
  type ClawResponse, type GhResponse, type JobDetail, type JobsResponse, type RepoDetail,
} from './client.js';
import {
  clawScreen, errorScreen, githubRepos, githubScreen, jobDetailScreen, jobsScreen,
  repoDetailScreen, type RepoTab, type ScreenView,
} from './render.js';
import { readCache, writeCache } from './cache.js';
import { fail, log } from './log.js';

/**
 * Dev HUD. Three read-only screens, each drillable into detail.
 *
 * Interaction model: **the list holds content, the menu holds navigation.**
 * Scroll the list to move through jobs or repos, click to open that item's
 * detail. Screen switching lives in the contextual menu, so the list never has
 * to double as a nav bar.
 *
 * Two behaviours matter more than the layout:
 *
 *   1. Paint from cache before the first fetch returns. Android may suspend the
 *      WebView and relaunch it cold, and a status board that opens on a spinner
 *      is useless for a two-second glance.
 *   2. Never render stale data as if it were current. A failed poll keeps the
 *      last-good screen but marks it; a lost connection says so.
 */

type ScreenName = 'jobs' | 'github' | 'openclaw';

const MENU = { jobs: 1, github: 2, openclaw: 3, account: 4, view: 5, back: 6, refresh: 7 } as const;
const POLL_MS = 2000;

let screen: Screen | undefined;
let current: ScreenName = 'jobs';
/** Selected item id when drilled in; null on the summary screen. */
let detail: string | null = null;
let repoTab: RepoTab = 'prs';
/** GitHub account filter: null = every account, otherwise one identity. */
let ghAccount: string | null = null;
/** Last list contents, so we only rebuild the page when they actually change. */
let listItems: string[] = [];

async function main(): Promise<void> {
  if (!isEvenAppWebView()) {
    log('Not inside the Even App WebView.');
    log('Run `npm run qr -w @even/dev-hud` and scan from the Even Hub tab.');
    return;
  }

  const app = await EvenApp.start();
  log(`bridge ready · launch=${app.launchSource ?? 'pending'}`);

  screen = await Screen.mount(app.bridge, buildPage(['loading…']));
  log('page mounted');

  const cached = readCache(current);
  if (cached) await paint(renderSummary(current, cached.data));

  app.events.on('menu', (e) => {
    switch (e.itemID) {
      case MENU.jobs: void switchTo('jobs'); break;
      case MENU.github: void switchTo('github'); break;
      case MENU.openclaw: void switchTo('openclaw'); break;
      case MENU.back: detail = null; void tick(); break;
      case MENU.refresh: void tick(); break;
      case MENU.view:
        // Repo detail holds more than one screen can show, so cycle the view.
        repoTab = repoTab === 'prs' ? 'runs' : repoTab === 'runs' ? 'branches' : 'prs';
        void tick();
        break;
      case MENU.account:
        void cycleAccount();
        break;
    }
  });

  // Clicking a list row drills into that item. Scrolling alone does not — you
  // would otherwise fire a request for every row you pass over.
  app.events.on('list', (e) => {
    const idx = e.currentSelectItemIndex;
    if (typeof idx !== 'number' || idx < 0) return;
    void openIndex(idx);
  });

  app.events.on('longPress', ({ pressed }) => { if (pressed) void tick(); });

  const timer = setInterval(() => void tick(), POLL_MS);
  app.onDispose(() => clearInterval(timer));

  await tick();
}

/** Page layout is constant; only the list contents vary, so rebuilds are rare. */
function buildPage(items: string[]): PageBuilder {
  return new PageBuilder()
    .text({ name: 'header', x: 24, y: 18, width: 528, height: 30, content: 'Dev HUD', brightness: 3 })
    .text({ name: 'row1', x: 24, y: 56, width: 528, height: 30, content: '' })
    .text({ name: 'row2', x: 24, y: 90, width: 528, height: 30, content: '' })
    .text({ name: 'row3', x: 24, y: 124, width: 528, height: 30, content: '' })
    .list({ name: 'items', x: 24, y: 158, width: 528, height: 46, items: items.length ? items : ['—'], focus: true })
    .text({ name: 'footer', x: 24, y: 212, width: 528, height: 30, content: '', brightness: 1 })
    .menuItem('Jobs', MENU.jobs)
    .menuItem('GitHub', MENU.github)
    .menuItem('OpenClaw', MENU.openclaw)
    .menuItem('Account', MENU.account)
    .menuItem('Next view', MENU.view)
    .menuItem('Back', MENU.back)
    .menuItem('Refresh', MENU.refresh);
}

/**
 * Rebuild only when the list actually changed. `rebuildPageContainer` replaces
 * every container, so doing it on each 2s poll would make the display flicker
 * and waste the link.
 */
async function setList(items: string[]): Promise<void> {
  const same = items.length === listItems.length && items.every((v, i) => v === listItems[i]);
  if (same || !screen) return;
  listItems = items;
  await screen.rebuild(buildPage(items));
}

async function switchTo(next: ScreenName): Promise<void> {
  current = next;
  detail = null;
  const cached = readCache(next);
  if (cached) await paint(renderSummary(next, cached.data));
  await tick();
}

async function openIndex(idx: number): Promise<void> {
  const cached = readCache(current);
  if (!cached) return;
  if (current === 'jobs') {
    const jobs = (cached.data as JobsResponse).jobs;
    const picked = jobs[idx];
    if (picked) { detail = picked.id; await tick(); }
  } else if (current === 'github') {
    const repos = githubRepos(cached.data as GhResponse, ghAccount);
    const picked = repos[idx];
    if (picked) { detail = picked.name.split('/')[1] ?? picked.name; repoTab = 'prs'; await tick(); }
  }
}

/**
 * Cycle: all accounts → each account in turn → back to all. The available
 * accounts come from the payload, so adding one to the shim's config makes it
 * appear here without an app change.
 */
async function cycleAccount(): Promise<void> {
  if (current !== 'github') return;
  const cached = readCache('github');
  const accounts = cached ? ((cached.data as GhResponse).accounts ?? []) : [];
  if (accounts.length < 2) return; // nothing to filter between
  const order: (string | null)[] = [null, ...accounts];
  const idx = order.indexOf(ghAccount);
  ghAccount = order[(idx + 1) % order.length] ?? null;
  detail = null;
  if (cached) {
    await setList(listFor('github', cached.data));
    await paint(renderSummary('github', cached.data));
  }
  await tick();
}

function renderSummary(name: ScreenName, data: unknown): ScreenView {
  if (name === 'jobs') return jobsScreen(data as JobsResponse);
  if (name === 'github') return githubScreen(data as GhResponse, ghAccount);
  return clawScreen(data as ClawResponse);
}

function listFor(name: ScreenName, data: unknown): string[] {
  if (name === 'jobs') return (data as JobsResponse).jobs.map((j) => j.name);
  if (name === 'github') {
    // Must match exactly what githubScreen renders, or clicking row N opens the
    // wrong repo.
    return githubRepos(data as GhResponse, ghAccount).map((r) => r.name.split('/')[1] ?? r.name);
  }
  return (data as ClawResponse).channels.map((c) => c.name);
}

async function tick(): Promise<void> {
  const name = current;
  const item = detail;
  try {
    if (item) {
      const view =
        name === 'jobs'
          ? jobDetailScreen(await api.job(item) as JobDetail)
          : repoDetailScreen(await api.repo(item) as RepoDetail, repoTab);
      // A slow response must not overwrite a screen you already navigated away from.
      if (name !== current || item !== detail) return;
      await paint(view);
      return;
    }

    const data =
      name === 'jobs' ? await api.jobs() :
      name === 'github' ? await api.github() : await api.claw();
    if (name !== current || detail !== null) return;

    writeCache(name, data);
    await setList(listFor(name, data));
    await paint(renderSummary(name, data));
  } catch (err) {
    if (name !== current) return;
    const cached = readCache(name);
    const message = err instanceof ShimError ? err.message : 'error';
    await paint(errorScreen(titleOf(name), message, cached?.at ?? null));
  }
}

function titleOf(name: ScreenName): string {
  return name === 'jobs' ? 'Jobs' : name === 'github' ? 'GitHub' : 'OpenClaw';
}

async function paint(view: ScreenView): Promise<void> {
  if (!screen) return;
  const rows = ['row1', 'row2', 'row3'] as const;
  await screen.setText('header', view.header, { brightness: 3 });
  for (let i = 0; i < rows.length; i++) {
    const row = view.rows[i];
    await screen.setText(rows[i]!, row?.text ?? '', { brightness: row?.brightness ?? 1 });
  }
  await screen.setText('footer', view.footer, { brightness: 1 });
}

main().catch(fail);
