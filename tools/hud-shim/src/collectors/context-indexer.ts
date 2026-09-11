import { config } from '../config.ts';
import { db, markSource } from '../db.ts';

/**
 * Context indexer — populates `context_snippets` from private sources.
 *
 * Runs every 5 minutes (configurable). Pulls recent messages from Slack
 * channels configured in SLACK_CHANNELS, and OpenClaw session transcripts.
 * The fact-check endpoint searches this table, so the quality of results
 * depends on how much context lives here.
 *
 * Design decisions:
 *   - Uses Slack's `conversations.history` with a time window, not
 *     `conversations.list` + full scan. Keeps both the token scope and the
 *     request count small.
 *   - Inserts are upserted by ID so re-indexing the same window is free.
 *   - Prunes snippets older than `lookbackDays` on every pass.
 */

export const SOURCE = 'context-indexer';

type SlackMessage = {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
};

type SlackHistoryResponse = {
  ok: boolean;
  messages?: SlackMessage[];
  error?: string;
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

/** Resolve channel name → ID if needed (Slack API requires IDs). */
async function resolveChannel(token: string, nameOrId: string): Promise<string> {
  // Already an ID (starts with C, D, or G)
  if (/^[CDG][A-Z0-9]+$/.test(nameOrId)) return nameOrId;

  // Strip leading #
  const name = nameOrId.replace(/^#/, '');
  const res = await fetch('https://slack.com/api/conversations.list?limit=200&types=public_channel,private_channel', {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as { ok: boolean; channels?: { id: string; name: string }[] };
  if (!data.ok || !data.channels) throw new Error(`Slack conversations.list failed`);
  const found = data.channels.find((c) => c.name === name);
  if (!found) throw new Error(`Slack channel "${name}" not found`);
  return found.id;
}

async function indexSlackChannel(
  token: string,
  channelIdOrName: string,
  oldestMs: number,
): Promise<{ indexed: number; channel: string }> {
  const channelId = await resolveChannel(token, channelIdOrName);
  const oldest = (oldestMs / 1000).toFixed(6); // Slack uses seconds with microseconds

  const res = await fetch(
    `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${oldest}&limit=200`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const data = (await res.json()) as SlackHistoryResponse;
  if (!data.ok) throw new Error(`Slack history for ${channelId}: ${data.error ?? 'unknown error'}`);

  const messages = data.messages ?? [];
  const now = Date.now();
  const upsert = db().prepare(
    `INSERT INTO context_snippets (id, source, channel, author, text, ts, fetched_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET text = excluded.text, fetched_at = excluded.fetched_at`,
  );

  let indexed = 0;
  for (const msg of messages) {
    // Skip bot messages, subtypes (joins, leaves, etc.), and empty messages
    if (msg.subtype || msg.bot_id || !msg.text?.trim()) continue;

    const tsMs = Math.round(parseFloat(msg.ts) * 1000);
    upsert.run(
      `slack:${channelId}:${msg.ts}`,
      'slack',
      channelIdOrName,
      msg.user ?? null,
      msg.text,
      tsMs,
      now,
    );
    indexed++;
  }

  return { indexed, channel: channelIdOrName };
}

/** Index OpenClaw session transcripts via the gateway. */
async function indexOpenClawSessions(oldestMs: number): Promise<{ indexed: number }> {
  if (!config.openclaw.gatewayToken) return { indexed: 0 };

  try {
    const res = await fetch(`${config.openclaw.gatewayUrl}/tools/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.openclaw.gatewayToken}`,
      },
      body: JSON.stringify({ tool: 'sessions_history', args: { limit: 50 } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { indexed: 0 };

    const body = (await res.json()) as {
      result?: Array<{
        key: string;
        agent?: string;
        messages?: Array<{ role: string; content: string; ts?: number }>;
      }>;
    };

    const sessions = body.result ?? [];
    const now = Date.now();
    const upsert = db().prepare(
      `INSERT INTO context_snippets (id, source, channel, author, text, ts, fetched_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET text = excluded.text, fetched_at = excluded.fetched_at`,
    );

    let indexed = 0;
    for (const session of sessions) {
      const msgs = session.messages ?? [];
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]!;
        const ts = msg.ts ?? now;
        if (ts < oldestMs) continue;
        if (!msg.content?.trim()) continue;

        upsert.run(
          `openclaw:${session.key}:${i}`,
          'openclaw',
          session.key,
          msg.role === 'user' ? session.agent ?? 'user' : msg.role,
          msg.content,
          ts,
          now,
        );
        indexed++;
      }
    }

    return { indexed };
  } catch {
    return { indexed: 0 };
  }
}

export async function collectContext(): Promise<{ slack: number; openclaw: number; skipped?: string }> {
  const { slack: slackConfig } = config;
  const hasSlack = slackConfig.userToken && slackConfig.channels.length > 0;
  const hasOpenClaw = !!config.openclaw.gatewayToken;

  if (!hasSlack && !hasOpenClaw) {
    markSource(SOURCE, false, 'not configured: set SLACK_USER_TOKEN + SLACK_CHANNELS, or OPENCLAW_GATEWAY_TOKEN');
    return { slack: 0, openclaw: 0, skipped: 'not configured' };
  }

  const lookbackMs = slackConfig.lookbackDays * 24 * 60 * 60 * 1000;
  const oldestMs = Date.now() - lookbackMs;
  const failures: string[] = [];

  // ── Slack ────────────────────────────────────────────────────────────
  let slackTotal = 0;
  if (hasSlack) {
    for (const channel of slackConfig.channels) {
      try {
        const { indexed } = await indexSlackChannel(slackConfig.userToken!, channel, oldestMs);
        slackTotal += indexed;
      } catch (err) {
        failures.push(`slack/${channel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── OpenClaw ─────────────────────────────────────────────────────────
  let openclawTotal = 0;
  if (hasOpenClaw) {
    try {
      const { indexed } = await indexOpenClawSessions(oldestMs);
      openclawTotal = indexed;
    } catch (err) {
      failures.push(`openclaw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Prune old snippets ──────────────────────────────────────────────
  db().prepare('DELETE FROM context_snippets WHERE ts < ?').run(oldestMs);

  markSource(
    SOURCE,
    failures.length === 0,
    failures.length ? failures.join(' | ') : undefined,
  );

  return { slack: slackTotal, openclaw: openclawTotal };
}
