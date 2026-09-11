import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { routes } from './routes/index.ts';

/**
 * Minimal HTTP surface. No framework: a handful of routes do not justify a
 * dependency tree in a service that holds every credential in the system.
 */

export type Handler = (req: IncomingMessage, params: Record<string, string>) => unknown;
export type Route = { method: 'GET' | 'POST'; pattern: string; handler: Handler };

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
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
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

/** Read a request body, capped at 10 MB. */
function readBody(req: IncomingMessage): Promise<string> {
  const MAX = 10 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) { req.destroy(); reject(new Error('payload too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Attach a `.body` field to POST requests before calling the handler. This
 * keeps the handler signature clean — it always receives an IncomingMessage,
 * but POST routes can read `(req as any)._parsedBody`.
 */
export type PostRequest = IncomingMessage & { _parsedBody?: unknown };

export function createShimServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health is unauthenticated on purpose: it reports liveness only, no data,
    // and it needs to be probeable when the token is what's misconfigured.
    const isHealth = url.pathname === '/v1/health';
    if (!isHealth && !authorized(req)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    const method = req.method ?? 'GET';
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = match(route.pattern, url.pathname);
      if (!params) continue;

      const run = async () => {
        // Parse JSON body for POST requests before calling the handler.
        if (method === 'POST') {
          const raw = await readBody(req);
          try {
            (req as PostRequest)._parsedBody = JSON.parse(raw);
          } catch {
            send(res, 400, { error: 'invalid JSON' });
            return;
          }
        }
        const body = await route.handler(req, params);
        send(res, 200, body);
      };

      run().catch((err: unknown) => {
        console.error('[shim]', err);
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    // No matching route for this method+path.
    if (method !== 'GET' && method !== 'POST') {
      send(res, 405, { error: 'method not allowed' });
    } else {
      send(res, 404, { error: 'not found' });
    }
  });
}
