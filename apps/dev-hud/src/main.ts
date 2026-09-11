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

type ScreenName = 'jobs' | 'github' | 'openclaw';

const MENU = { jobs: 1, github: 2, openclaw: 3, account: 4, view: 5, back: 6, refresh: 7 } as const;
const POLL_MS = 3000;

let screen: Screen | undefined;
let current: ScreenName = 'jobs';
let detail: string | null = null;
let repoTab: RepoTab = 'prs';
let ghAccount: string | null = null;
let busy = false;

async function main(): Promise<void> {
  if (!isEvenAppWebView()) {
    log('Not inside the Even App WebView.');
    log('Run `npm run qr -w @even/dev-hud` and scan from the Even Hub tab.');
    return;
  }

  const app = await EvenApp.start();
  log(`bridge ready`);

  const cached = readCache(current);
  const items = cached ? listFor(current, cached.data) : ['loading…'];
  const view = cached ? renderSummary(current, cached.data) : undefined;
  screen = await Screen.mount(app.bridge, buildPage(items, view));
  log('mounted');

  app.events.on('menu', (e) => {
    log(`menu ${e.itemID}`);
    switch (e.itemID) {
      case MENU.jobs: void switchTo('jobs'); break;
      case MENU.github: void switchTo('github'); break;
      case MENU.openclaw: void switchTo('openclaw'); break;
      case MENU.back: detail = null; void tick(); break;
      case MENU.refresh: void tick(); break;
      case MENU.view:
        repoTab = repoTab === 'prs' ? 'runs' : repoTab === 'runs' ? 'branches' : 'prs';
        void tick();
        break;
      case MENU.account:
        void cycleAccount();
        break;
    }
  });

  app.events.on('list', (e) => {
    const idx = e.currentSelectItemIndex;
    if (typeof idx !== 'number' || idx < 0) return;
    log(`list ${idx}`);
    void openIndex(idx);
  });

  app.events.on('longPress', ({ pressed }) => {
    if (pressed) { log('long-press'); void tick(); }
  });

  const timer = setInterval(() => void tick(), POLL_MS);
  app.onDispose(() => clearInterval(timer));

  await tick();
}

/**
 * Build a page with all content embedded. When `view` is provided, text
 * containers are pre-filled — no `textContainerUpgrade` call is needed after
 * the rebuild, which avoids the SDK crash that occurs when setText is called
 * immediately after rebuildPageContainer.
 */
function buildPage(items: string[], view?: ScreenView): PageBuilder {
  const r0 = view?.rows[0];
  const r1 = view?.rows[1];
  const r2 = view?.rows[2];
  return new PageBuilder()
    .text({ name: 'header', x: 24, y: 18, width: 528, height: 30, content: view?.header ?? 'Dev HUD', brightness: 3 })
    .text({ name: 'row1', x: 24, y: 56, width: 528, height: 30, content: r0?.text ?? '', brightness: r0?.brightness ?? 1 })
    .text({ name: 'row2', x: 24, y: 90, width: 528, height: 30, content: r1?.text ?? '', brightness: r1?.brightness ?? 1 })
    .text({ name: 'row3', x: 24, y: 124, width: 528, height: 30, content: r2?.text ?? '', brightness: r2?.brightness ?? 1 })
    .list({ name: 'items', x: 24, y: 158, width: 528, height: 46, items: items.length ? items : ['—'], focus: true })
    .text({ name: 'footer', x: 24, y: 212, width: 528, height: 30, content: view?.footer ?? '', brightness: 1 })
    .menuItem('Jobs', MENU.jobs)
    .menuItem('GitHub', MENU.github)
    .menuItem('OpenClaw', MENU.openclaw)
    .menuItem('Account', MENU.account)
    .menuItem('Next view', MENU.view)
    .menuItem('Back', MENU.back)
    .menuItem('Refresh', MENU.refresh);
}

/**
 * Switch screen: rebuild the entire page with content baked in.
 * No setText is called after rebuild — the bridge needs time to settle.
 * The next poll tick (≤3 s) will refresh with live data via paint().
 */
async function switchTo(next: ScreenName): Promise<void> {
  if (busy || !screen) return;
  busy = true;
  try {
    current = next;
    detail = null;

    const cached = readCache(next);
    const items = cached ? listFor(next, cached.data) : ['loading…'];
    const view = cached ? renderSummary(next, cached.data) : undefined;
    await screen.rebuild(buildPage(items, view));
    log(`→ ${next} · ${items.length}`);
  } catch (err) {
    log(`switch err: ${err instanceof Error ? err.message : String(err)}`);
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
    if (picked) { detail = picked.id; log(`drill → ${picked.name}`); void tick(); }
  } else if (current === 'github') {
    const repos = githubRepos(cached.data as GhResponse, ghAccount);
    const picked = repos[idx];
    if (picked) {
      detail = picked.name.split('/')[1] ?? picked.name;
      repoTab = 'prs';
      log(`drill → ${detail}`);
      void tick();
    }
  }
}

async function cycleAccount(): Promise<void> {
  if (current !== 'github' || busy || !screen) return;
  busy = true;
  try {
    const cached = readCache('github');
    const accounts = cached ? ((cached.data as GhResponse).accounts ?? []) : [];
    if (accounts.length < 2) return;
    const order: (string | null)[] = [null, ...accounts];
    const idx = order.indexOf(ghAccount);
    ghAccount = order[(idx + 1) % order.length] ?? null;
    detail = null;
    log(`account → ${ghAccount ?? 'all'}`);

    if (cached) {
      const items = listFor('github', cached.data);
      const view = renderSummary('github', cached.data);
      await screen.rebuild(buildPage(items, view));
      log(`→ github · ${items.length}`);
    }
  } catch (err) {
    log(`account err: ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * Poll tick. Fetches data and updates text containers only — never rebuilds.
 * The 3-second interval means the bridge always has time to settle after any
 * rebuild from switchTo().
 */
async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  const name = current;
  const item = detail;
  try {
    if (item) {
      const view =
        name === 'jobs'
          ? jobDetailScreen(await api.job(item) as JobDetail)
          : repoDetailScreen(await api.repo(item) as RepoDetail, repoTab);
      if (name !== current || item !== detail) return;
      await paint(view);
      return;
    }

    const data =
      name === 'jobs' ? await api.jobs() :
      name === 'github' ? await api.github() : await api.claw();
    if (name !== current || detail !== null) return;

    writeCache(name, data);
    await paint(renderSummary(name, data));
  } catch (err) {
    if (name !== current) return;
    const cached = readCache(name);
    const message = err instanceof ShimError ? err.message : 'error';
    log(`tick: ${message}`);
    await paint(errorScreen(titleOf(name), message, cached?.at ?? null));
  } finally {
    busy = false;
  }
}

function titleOf(name: ScreenName): string {
  return name === 'jobs' ? 'Jobs' : name === 'github' ? 'GitHub' : 'OpenClaw';
}

async function paint(view: ScreenView): Promise<void> {
  if (!screen) return;
  try {
    await screen.setText('header', view.header, { brightness: 3 });
    const rows = ['row1', 'row2', 'row3'] as const;
    for (let i = 0; i < rows.length; i++) {
      const row = view.rows[i];
      await screen.setText(rows[i]!, row?.text ?? '', { brightness: row?.brightness ?? 1 });
    }
    await screen.setText('footer', view.footer, { brightness: 1 });
  } catch (err) {
    log(`paint err: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch(fail);
