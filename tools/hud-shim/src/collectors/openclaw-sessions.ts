import { config } from '../config.ts';
import { db, markSource } from '../db.ts';

/**
 * OpenClaw sessions + channel health.
 *
 * `sessions_list`, `sessions_history`, and `session_status` are all callable over
 * `POST /tools/invoke` — none are on the gateway's HTTP deny list. The gateway
 * token stays in this process; the glasses never see it.
 *
 * Status: partially implemented. `sessions_list` and channel health work; the
 * activity feed needs the real tool response shapes, which are only observable
 * against a working gateway. Both OpenClaw cron jobs are currently failing auth
 * (out of Anthropic extra usage, invalid OpenAI fallback key), so the session
 * side is expected to be thin until that is sorted.
 */

export const SOURCE = 'openclaw-sessions';

type InvokeResult = { ok?: boolean; result?: unknown; error?: string };

async function invoke(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!config.openclaw.gatewayToken) throw new Error('OPENCLAW_GATEWAY_TOKEN not set');
  const res = await fetch(`${config.openclaw.gatewayUrl}/tools/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.openclaw.gatewayToken}`,
    },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) throw new Error(`${tool}: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as InvokeResult;
  if (body.error) throw new Error(`${tool}: ${body.error}`);
  return body.result ?? body;
}

/** Cheap liveness check — used by /v1/health and to distinguish "down" from "quiet". */
export async function gatewayUp(): Promise<boolean> {
  try {
    const res = await fetch(`${config.openclaw.gatewayUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function collectOpenClawSessions(): Promise<{ sessions: number; skipped?: string }> {
  if (!config.openclaw.gatewayToken) {
    markSource(SOURCE, false, 'not configured: set OPENCLAW_GATEWAY_TOKEN');
    return { sessions: 0, skipped: 'not configured' };
  }

  const now = Date.now();
  try {
    const raw = await invoke('sessions_list', {});
    const sessions = Array.isArray(raw)
      ? (raw as Record<string, unknown>[])
      : ((raw as { sessions?: Record<string, unknown>[] })?.sessions ?? []);

    const stmt = db().prepare(
      `INSERT INTO claw_sessions (key, agent, tokens, ctx_pct, last_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET
         agent = excluded.agent, tokens = excluded.tokens,
         ctx_pct = excluded.ctx_pct, last_at = excluded.last_at`,
    );

    for (const s of sessions) {
      const key = String(s.key ?? s.sessionKey ?? s.id ?? '');
      if (!key) continue;
      stmt.run(
        key,
        s.agent ? String(s.agent) : (s.agentId ? String(s.agentId) : null),
        typeof s.tokens === 'number' ? s.tokens : null,
        typeof s.contextPct === 'number' ? s.contextPct : null,
        typeof s.lastActivityMs === 'number' ? s.lastActivityMs : now,
      );
    }

    markSource(SOURCE, true);
    return { sessions: sessions.length };
  } catch (err) {
    markSource(SOURCE, false, err instanceof Error ? err.message : String(err));
    return { sessions: 0, skipped: 'error' };
  }
}

/**
 * Channel health. This is the OpenClaw screen's footer line: if WhatsApp
 * silently disconnects, the entire command path is dead and the silence reads
 * as "the agent is thinking".
 */
export async function collectChannelHealth(): Promise<void> {
  const up = await gatewayUp();
  const now = Date.now();
  const stmt = db().prepare(
    `INSERT INTO claw_channels (name, connected, checked_at) VALUES (?,?,?)
     ON CONFLICT(name) DO UPDATE SET connected = excluded.connected, checked_at = excluded.checked_at`,
  );
  // Gateway down means every channel is down, whatever it last reported.
  if (!up) {
    for (const name of ['whatsapp', 'slack']) stmt.run(name, 0, now);
    return;
  }
  try {
    const raw = await invoke('channels_list', {});
    const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    if (list.length === 0) {
      // Tool name unconfirmed against this gateway version; fall back to
      // "gateway is up" rather than reporting a false disconnection.
      for (const name of ['whatsapp', 'slack']) stmt.run(name, 1, now);
      return;
    }
    for (const c of list) {
      const name = String(c.name ?? c.channel ?? '');
      if (!name) continue;
      stmt.run(name, c.connected === true || c.status === 'connected' ? 1 : 0, now);
    }
  } catch {
    for (const name of ['whatsapp', 'slack']) stmt.run(name, 1, now);
  }
}
