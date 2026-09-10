import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * All configuration in one place, read once at startup.
 *
 * Secrets come from the environment only. Nothing here is ever sent to the
 * glasses: the app authenticates with HUD_TOKEN and receives derived state, so
 * the GitHub token, the OpenClaw gateway token, and the database password never
 * leave this process.
 */

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** "owner/repo" — tolerant of leading/trailing slashes and full URLs. */
function normalizeRepo(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '');
}

/**
 * Resolve a token, preferring a command over a literal.
 *
 * `GITHUB_<NAME>_TOKEN_CMD` keeps the secret out of `.env` entirely — e.g.
 * `gh auth token --user eddie-ruiz_len` reads it from the macOS keychain at
 * startup. That matters most for work accounts, whose tokens often carry far
 * more authority than this read-only service needs.
 */
function resolveToken(prefix: string): string | undefined {
  const cmd = env(`${prefix}_TOKEN_CMD`);
  if (cmd) {
    try {
      const [bin, ...args] = cmd.split(/\s+/);
      if (!bin) return undefined;
      const out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.trim() || undefined;
    } catch {
      console.warn(`[config] ${prefix}_TOKEN_CMD failed; that account will be skipped`);
      return undefined;
    }
  }
  return env(`${prefix}_TOKEN`);
}

export type GitHubAccount = { name: string; token: string; repos: string[] };

/**
 * Multiple GitHub identities, each with its own token and its own repos. A repo
 * is only ever requested with the token that can actually see it — work
 * credentials are never sent to personal repos, or the reverse.
 *
 *   GITHUB_ACCOUNTS=personal,work
 *   GITHUB_PERSONAL_TOKEN=...        (or _TOKEN_CMD)
 *   GITHUB_PERSONAL_REPOS=owner/repo,...
 *   GITHUB_WORK_TOKEN_CMD=gh auth token --user someone
 *   GITHUB_WORK_REPOS=org/repo,...
 *
 * Bare `GITHUB_TOKEN` / `GITHUB_REPOS` still work as an implicit "default"
 * account, so an existing single-account setup keeps running unchanged.
 */
function githubAccounts(): GitHubAccount[] {
  const named = (env('GITHUB_ACCOUNTS') ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

  const accounts: GitHubAccount[] = [];

  for (const name of named) {
    const prefix = `GITHUB_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const token = resolveToken(prefix);
    const repos = (env(`${prefix}_REPOS`) ?? '').split(',').map(normalizeRepo).filter(Boolean);
    if (token && repos.length) accounts.push({ name, token, repos });
    else if (repos.length) console.warn(`[config] account "${name}" has repos but no usable token`);
  }

  const legacyToken = resolveToken('GITHUB');
  const legacyRepos = (env('GITHUB_REPOS') ?? '').split(',').map(normalizeRepo).filter(Boolean);
  if (legacyToken && legacyRepos.length && !accounts.some((a) => a.name === 'default')) {
    accounts.push({ name: 'default', token: legacyToken, repos: legacyRepos });
  }

  return accounts;
}

function num(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num('HUD_PORT', 7777),
  host: env('HUD_HOST') ?? '127.0.0.1',

  /** The glasses' credential. Separate from every other secret so it can be rotated alone. */
  hudToken: env('HUD_TOKEN'),

  db: {
    path: env('HUD_DB') ?? join(homedir(), '.devhud', 'hud.sqlite'),
  },

  openclaw: {
    /** Read directly off disk — `cron` is on the gateway's HTTP deny list on purpose. */
    cronDir: env('OPENCLAW_CRON_DIR') ?? join(homedir(), '.openclaw', 'cron'),
    gatewayUrl: env('OPENCLAW_GATEWAY_URL') ?? 'http://127.0.0.1:18789',
    gatewayToken: env('OPENCLAW_GATEWAY_TOKEN'),
  },

  github: {
    accounts: githubAccounts(),
    apiBase: env('GITHUB_API') ?? 'https://api.github.com',
  },

  intervals: {
    openclawCronMs: num('HUD_POLL_CRON_MS', 30_000),
    openclawSessionsMs: num('HUD_POLL_SESSIONS_MS', 60_000),
    githubMs: num('HUD_POLL_GITHUB_MS', 30_000),
  },

  thresholds: {
    /** A source older than this is flagged `stale` and the HUD shows a warning. */
    staleMs: num('HUD_STALE_MS', 3 * 60_000),
    /**
     * How far past `next_due_at` before a job counts as missed. Floor exists so a
     * job with a slow start doesn't flap between overdue and healthy.
     */
    overdueGraceMs: num('HUD_OVERDUE_GRACE_MS', 5 * 60_000),
    overdueGraceFactor: num('HUD_OVERDUE_GRACE_FACTOR', 2),
  },

  /**
   * CORS allowlist. Deliberately config rather than code: the Origin a packed
   * `.ehpk` sends is undocumented, so every inbound Origin is logged and this
   * list is filled in from what real devices actually send. Never answer an
   * unknown Origin with a wildcard.
   */
  allowedOrigins: (env('HUD_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  logOrigins: env('HUD_LOG_ORIGINS') !== '0',
} as const;

export type Config = typeof config;

/** Fail loudly at startup rather than mysteriously on the first request. */
export function assertRuntimeConfig(): void {
  if (!config.hudToken) {
    throw new Error(
      'HUD_TOKEN is not set. Generate one with `openssl rand -hex 32` and export it; ' +
        'the shim refuses to serve without a credential.',
    );
  }
}
