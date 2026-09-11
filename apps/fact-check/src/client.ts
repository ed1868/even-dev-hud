/**
 * Client for the hud-shim fact-check endpoints.
 *
 * Same credential pattern as the Dev HUD: the token is the glasses'
 * read-only credential, not the OpenAI or Slack token.
 */

const BASE = (import.meta.env.VITE_HUD_BASE as string | undefined) ?? '';
const TOKEN = (import.meta.env.VITE_HUD_TOKEN as string | undefined) ?? '';

export class ShimError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'network' | 'server') {
    super(message);
    this.name = 'ShimError';
  }
}

export type CheckMatch = {
  id: string;
  text: string;
  source: string;
  channel: string | null;
  author: string | null;
  ts: number;
  score: number;
};

export type CheckResult = {
  id: string;
  transcript: string;
  claim: string | null;
  matches: CheckMatch[];
  searched: string[];
  checkedAt: number;
};

export type RecentCheck = {
  id: string;
  transcript: string;
  claim: string | null;
  match_count: number;
  top_match: string | null;
  checked_at: number;
};

export type ChecksResponse = {
  checks: RecentCheck[];
  context: { snippets: number; sources: string[] };
  fetchedAt: number | null;
  stale: boolean;
};

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  if (!BASE || !TOKEN) {
    throw new ShimError('VITE_HUD_BASE / VITE_HUD_TOKEN not set — see .env.example', 'auth');
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
  } catch (err) {
    throw new ShimError(
      err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'no connection',
      'network',
    );
  }
  if (res.status === 401) throw new ShimError('auth failed', 'auth');
  if (!res.ok) throw new ShimError(`server ${res.status}`, 'server');
  return (await res.json()) as T;
}

export const api = {
  /** Submit text for fact-checking. */
  checkText: (text: string) => request<CheckResult>('POST', '/v1/check', { text }),

  /** Submit audio (base64 WAV) for transcription + fact-checking. */
  checkAudio: (audio: string) => request<CheckResult>('POST', '/v1/check', { audio }, 30_000),

  /** Get recent checks and context stats. */
  checks: () => request<ChecksResponse>('GET', '/v1/checks'),
};
