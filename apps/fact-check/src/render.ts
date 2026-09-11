import type { CheckMatch, CheckResult, RecentCheck } from './client.js';

/**
 * Turns fact-check state into the lines a screen shows.
 *
 * Same pattern as the Dev HUD — SDK-free, testable, previewable in a terminal.
 */

export const LINE = 40;
export type Row = { text: string; brightness: number };
export type ScreenView = { header: string; rows: Row[]; footer: string };

const BRIGHT = { alert: 4, active: 3, healthy: 2, dim: 1 } as const;

function fit(s: string, n = LINE): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

function ago(ms: number | null | undefined): string {
  if (!ms) return '—';
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return 'now';
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

// ── Screen states ─────────────────────────────────────────────────────────

export type AppState =
  | { kind: 'idle'; audioSeconds: number }
  | { kind: 'recording' }
  | { kind: 'checking'; transcript: string }
  | { kind: 'result'; result: CheckResult }
  | { kind: 'error'; message: string };

export function idleScreen(audioSeconds: number, contextSnippets: number): ScreenView {
  return {
    header: `Fact Check · ${audioSeconds >= 1 ? 'listening' : 'mic starting…'}`,
    rows: [
      { text: '··· long-press to check ···', brightness: BRIGHT.dim },
      { text: `${Math.round(audioSeconds)}s buffered`, brightness: BRIGHT.dim },
      { text: contextSnippets > 0 ? `${contextSnippets} context snippets` : 'no context indexed', brightness: BRIGHT.dim },
    ],
    footer: 'long-press → capture → check',
  };
}

export function recordingScreen(): ScreenView {
  return {
    header: 'Fact Check · recording…',
    rows: [
      { text: 'release to check', brightness: BRIGHT.active },
      { text: '', brightness: BRIGHT.dim },
      { text: '', brightness: BRIGHT.dim },
    ],
    footer: 'capturing audio…',
  };
}

export function checkingScreen(transcript: string): ScreenView {
  return {
    header: 'Fact Check · checking…',
    rows: [
      { text: fit(`"${transcript}"`), brightness: BRIGHT.alert },
      { text: 'searching private context…', brightness: BRIGHT.healthy },
      { text: '', brightness: BRIGHT.dim },
    ],
    footer: 'this takes a few seconds',
  };
}

export function resultScreen(result: CheckResult): ScreenView {
  const hasMatch = result.matches.length > 0;
  const top = result.matches[0];
  const claim = result.claim ?? result.transcript;

  if (hasMatch && top) {
    return {
      header: `Fact Check · ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'}`,
      rows: [
        { text: fit(`✓ "${claim}"`), brightness: BRIGHT.alert },
        {
          text: fit(`${top.source}${top.channel ? ` · ${top.channel}` : ''} · ${ago(top.ts)}`),
          brightness: BRIGHT.healthy,
        },
        { text: fit(`"${top.text}"`), brightness: BRIGHT.healthy },
      ],
      footer: result.matches.length > 1
        ? `+${result.matches.length - 1} more · long-press for new check`
        : 'long-press for new check',
    };
  }

  return {
    header: 'Fact Check · no match',
    rows: [
      { text: fit(`· "${claim}"`), brightness: BRIGHT.active },
      { text: `searched: ${result.searched.join(', ')}`, brightness: BRIGHT.dim },
      { text: 'try a more specific claim', brightness: BRIGHT.dim },
    ],
    footer: 'long-press to retry',
  };
}

export function errorScreen(message: string): ScreenView {
  return {
    header: 'Fact Check ⚠',
    rows: [
      { text: message, brightness: BRIGHT.alert },
      { text: '', brightness: BRIGHT.dim },
      { text: '', brightness: BRIGHT.dim },
    ],
    footer: message === 'no connection' ? 'check Tailscale on your phone' : 'long-press to retry',
  };
}

// ── History list ──────────────────────────────────────────────────────────

/** Format a recent check for the list container. */
export function recentCheckItem(check: RecentCheck): string {
  const glyph = check.match_count > 0 ? '✓' : '·';
  const claim = (check.claim ?? check.transcript).slice(0, 24);
  return `${glyph} ${pad(claim, 28)} ${ago(check.checked_at)}`;
}
