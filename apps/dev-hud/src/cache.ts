/**
 * Last-good payload per screen, in localStorage.
 *
 * Android may suspend the WebView under memory pressure and relaunch it cold —
 * Even's own docs say to treat that as "the app starts cold". For a board you
 * glance at for two seconds, opening on a spinner is a failure. So every
 * successful fetch is cached and every screen paints from cache first.
 *
 * The cache is never used to *hide* a failure: `at` is surfaced so an error
 * screen can say how old the data it's showing actually is.
 */

const KEY = (name: string) => `devhud.cache.${name}`;

export type Cached<T = unknown> = { at: number; data: T };

export function readCache<T = unknown>(name: string): Cached<T> | null {
  try {
    const raw = localStorage.getItem(KEY(name));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached<T>;
    return typeof parsed?.at === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCache(name: string, data: unknown): void {
  try {
    localStorage.setItem(KEY(name), JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Quota or a locked-down WebView. A missing cache costs a spinner, not correctness.
  }
}
