import { closeDb, db } from './db.ts';
import { collectOnce } from './collectors/registry.ts';
import { allJobs } from './attention.ts';

/**
 * One collection pass, then print what the HUD would show. This is the fastest
 * way to see whether the overdue detection is working without a phone involved.
 */
db();
await collectOnce();

const jobs = allJobs();
const pad = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);

console.log(`\n${jobs.length} jobs\n`);
for (const j of jobs) {
  const glyph = { error: '✗', overdue: '⏱', running: '●', ok: '✓', disabled: '⏸', unknown: '·' }[j.state];
  const detail =
    j.state === 'error'   ? `${j.reason ?? 'error'} ×${j.consecutiveFailures}` :
    j.state === 'overdue' ? `overdue ${Math.round((j.overdueByMs ?? 0) / 60000)}m` :
    j.lastRunAt           ? `${Math.round((Date.now() - j.lastRunAt) / 60000)}m ago` : '—';
  console.log(`${glyph} ${pad(j.name, 38)} ${pad(j.state, 9)} ${pad(detail, 22)} ${j.errorBrief ?? ''}`);
}
console.log();
closeDb();
