import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { routes } from './routes/index.ts';

/**
 * Minimal read-only HTTP surface. No framework: eight GET routes do not justify
 * a dependency tree in a service that holds every credential in the system.
 */

export type Handler = (req: IncomingMessage, params: Record<string, string>) => unknown;
export type Route = { method: 'GET'; pattern: string; handler: Handler };

/** Constant-time compare so the token can't be recovered by timing the 401. */
function tokenMatches(provided: string): boolean {
  const expected = config.hudToken ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  return tokenMatches(header.slice('Bearer '.length).trim());
}

/**
 * The Origin a packed `.ehpk` sends is undocumented — it may be a custom scheme
 * or literally `null`. So every Origin is logged and the allowlist is config,
 * never a wildcard. Fill it from what real devices actually send.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (config.logOrigins && origin) console.log(`[cors] Origin: ${origin}`);
  if (!origin) return;
  if (config.allowedOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-max-age', '600');
  } else if (config.allowedOrigins.length === 0) {
    console.warn(
      `[cors] no HUD_ALLOWED_ORIGINS set; refusing Origin ${origin}. ` +
        'Add it once you have seen what the device sends.',
    );
  }
}

function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    const val = s[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

export function createShimServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      send(res, 405, { error: 'read-only service' });
      return;
    }

    // Health is unauthenticated on purpose: it reports liveness only, no data,
    // and it needs to be probeable when the token is what's misconfigured.
    const isHealth = url.pathname === '/v1/health';
    if (!isHealth && !authorized(req)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    for (const route of routes) {
      const params = match(route.pattern, url.pathname);
      if (!params) continue;
      try {
        const result = route.handler(req, params);
        Promise.resolve(result).then(
          (body) => send(res, 200, body),
          (err: unknown) => {
            console.error('[shim]', err);
            send(res, 500, { error: err instanceof Error ? err.message : String(err) });
          },
        );
      } catch (err) {
        console.error('[shim]', err);
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    send(res, 404, { error: 'not found' });
  });
}
