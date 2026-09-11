import { AudioInputSource, EvenApp, isEvenAppWebView } from '@even/core';
import { PageBuilder, Screen } from '@even/ui';
import { api, ShimError, type CheckResult, type ChecksResponse } from './client.js';
import {
  checkingScreen, errorScreen, idleScreen, recordingScreen, recentCheckItem,
  resultScreen, type ScreenView,
} from './render.js';
import { AudioRingBuffer } from './audio-buffer.js';
import { fail, log } from './log.js';

/**
 * Conversation Fact Checker.
 *
 * State machine:
 *
 *   idle  ──long-press──▶  recording  ──release──▶  checking  ──result──▶  result
 *     ▲                                                                      │
 *     └──────────────────── long-press ──────────────────────────────────────┘
 *
 * The glasses mic runs continuously while the app is open. Audio is buffered in
 * a 30-second ring buffer. Long-press freezes the buffer, encodes it as WAV,
 * and sends it to the shim for Whisper transcription + context search.
 *
 * If Whisper is not configured on the shim, the app falls back to the "text
 * input" mode where the most recent check is shown on re-open.
 */

const MENU = {
  history: 1,
  retry: 2,
  refresh: 3,
} as const;

type State = 'idle' | 'recording' | 'checking' | 'result' | 'error';

let screen: Screen | undefined;
let state: State = 'idle';
let lastResult: CheckResult | null = null;
let contextSnippets = 0;
let listItems: string[] = [];
let audioEnabled = false;

const audioBuffer = new AudioRingBuffer();

async function main(): Promise<void> {
  if (!isEvenAppWebView()) {
    log('Not inside the Even App WebView.');
    log('Run `npm run qr -w @even/fact-check` and scan from the Even Hub tab.');
    return;
  }

  const app = await EvenApp.start();
  log(`bridge ready · launch=${app.launchSource ?? 'pending'}`);

  screen = await Screen.mount(app.bridge, buildPage(['loading…']));
  log('page mounted');

  // Enable glasses mic — must happen after page is created
  audioEnabled = await app.bridge.audioControl(true, AudioInputSource.Glasses);
  log(`mic: ${audioEnabled ? 'enabled' : 'FAILED — page not ready?'}`);

  app.onDispose(() => {
    if (audioEnabled) void app.bridge.audioControl(false).catch(() => {});
  });

  // ── Audio events: fill the ring buffer ──────────────────────────────
  app.events.on('audio', (event) => {
    if (state === 'checking') return; // don't buffer while a check is in flight
    audioBuffer.push(event.audioPcm);
  });

  // ── Long-press: trigger a check ─────────────────────────────────────
  app.events.on('longPress', ({ pressed }) => {
    if (pressed) {
      // Press down → show recording state
      if (state === 'idle' || state === 'result' || state === 'error') {
        state = 'recording';
        void paint(recordingScreen());
        log('recording — release to check');
      }
    } else {
      // Released → freeze buffer and send for checking
      if (state === 'recording') {
        void doCheck();
      }
    }
  });

  // ── Menu navigation ─────────────────────────────────────────────────
  app.events.on('menu', (e) => {
    switch (e.itemID) {
      case MENU.history: void showHistory(); break;
      case MENU.retry:
        state = 'idle';
        void paint(idleScreen(audioBuffer.seconds, contextSnippets));
        break;
      case MENU.refresh: void refreshContext(); break;
    }
  });

  // ── Initial paint ───────────────────────────────────────────────────
  await refreshContext();
  await paint(idleScreen(audioBuffer.seconds, contextSnippets));
  log('ready — long-press to check a claim');

  // Periodic update of buffer seconds display (only when idle)
  const timer = setInterval(() => {
    if (state === 'idle' && screen) {
      void paint(idleScreen(audioBuffer.seconds, contextSnippets));
    }
  }, 5000);
  app.onDispose(() => clearInterval(timer));
}

async function doCheck(): Promise<void> {
  if (!audioBuffer.hasAudio) {
    state = 'error';
    await paint(errorScreen('no audio captured — try again'));
    log('no audio in buffer');
    return;
  }

  // Freeze the buffer and encode as WAV
  const wavBase64 = audioBuffer.toWavBase64();
  const seconds = audioBuffer.seconds;
  log(`captured ${seconds.toFixed(1)}s of audio, sending for check…`);

  state = 'checking';
  await paint(checkingScreen(`${seconds.toFixed(0)}s of audio…`));

  try {
    const result = await api.checkAudio(wavBase64);
    lastResult = result;
    state = 'result';

    // Update the display with the transcript once we have it
    log(`transcript: "${result.transcript}"`);
    log(`matches: ${result.matches.length}`);
    if (result.matches.length > 0) {
      log(`top match: "${result.matches[0]!.text.slice(0, 80)}…" (score: ${result.matches[0]!.score.toFixed(2)})`);
    }

    await paint(resultScreen(result));
  } catch (err) {
    state = 'error';
    const message = err instanceof ShimError ? err.message : 'check failed';
    log(`error: ${message}`);
    await paint(errorScreen(message));
  }
}

async function showHistory(): Promise<void> {
  try {
    const data = await api.checks();
    contextSnippets = data.context.snippets;

    const items = data.checks.map(recentCheckItem);
    await setList(items.length > 0 ? items : ['no checks yet']);

    if (data.checks.length > 0) {
      const latest = data.checks[0]!;
      const topMatch = latest.top_match ? JSON.parse(latest.top_match) : null;
      if (screen) {
        await screen.setText('header', `History · ${data.checks.length} checks`, { brightness: 3 });
        await screen.setText('row1', latest.transcript.slice(0, 40), { brightness: 2 });
        await screen.setText('row2', topMatch ? `${topMatch.source} · ${topMatch.channel ?? ''}` : 'no match', { brightness: 1 });
        await screen.setText('row3', '', { brightness: 1 });
        await screen.setText('footer', `${data.context.snippets} context snippets`, { brightness: 1 });
      }
    }
  } catch (err) {
    const message = err instanceof ShimError ? err.message : 'failed to load history';
    log(`history error: ${message}`);
  }
}

async function refreshContext(): Promise<void> {
  try {
    const data = await api.checks();
    contextSnippets = data.context.snippets;
    log(`context: ${contextSnippets} snippets from ${data.context.sources.join(', ') || 'none'}`);
  } catch {
    log('could not fetch context stats');
  }
}

// ── Display helpers ──────────────────────────────────────────────────────

function buildPage(items: string[]): PageBuilder {
  return new PageBuilder()
    .text({ name: 'header', x: 24, y: 18, width: 528, height: 30, content: 'Fact Check', brightness: 3 })
    .text({ name: 'row1', x: 24, y: 56, width: 528, height: 30, content: '' })
    .text({ name: 'row2', x: 24, y: 90, width: 528, height: 30, content: '' })
    .text({ name: 'row3', x: 24, y: 124, width: 528, height: 30, content: '' })
    .list({ name: 'items', x: 24, y: 158, width: 528, height: 46, items: items.length ? items : ['—'], focus: true })
    .text({ name: 'footer', x: 24, y: 212, width: 528, height: 30, content: '', brightness: 1 })
    .menuItem('History', MENU.history)
    .menuItem('New check', MENU.retry)
    .menuItem('Refresh', MENU.refresh);
}

async function setList(items: string[]): Promise<void> {
  const same = items.length === listItems.length && items.every((v, i) => v === listItems[i]);
  if (same || !screen) return;
  listItems = items;
  await screen.rebuild(buildPage(items));
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
