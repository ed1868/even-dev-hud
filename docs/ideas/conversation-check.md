# Conversation Check

**Status:** building
**Shape:** app + hud-shim endpoints

## What it does

You're in a conversation — a meeting, a 1:1, a call. Someone says "we moved the deploy window
to Thursdays" or "the Slack bot hasn't posted in two days." Long-press the glasses. The last
15 seconds of buffered audio get transcribed and checked against your **private** context — Slack
messages, OpenClaw conversation history, calendar events — not the open web. The glasses show a
matching quote and its source, or say "no match found."

```
✓  "deploy window → Thu"
   #ops-deploys · 3 days ago
   "Moving deploy window to Thu effective next wk"
```

Or:

```
·  no match found
   searched: Slack, OpenClaw
   long-press to retry
```

## Why this, not Conversate

Even's first-party fact checker (Conversate) searches the open web and returns `TRUE` / `FALSE`.
Our differentiators:

1. **User picks the claim.** Long-press, not automatic extraction. No noise from statements
   nobody questioned.
2. **Check against private context**, not Wikipedia. "Did we decide X?" is the question, and the
   answer lives in Slack, not on the internet.
3. **Refuse to render a verdict when you can't ground it.** Conversate returned `FALSE` on claims
   it simply couldn't verify. We show "no match" — a different, honest answer.

## Architecture

```
 ┌─────────────────────┐         ┌─────────────────────────────────┐
 │  G2 glasses app     │         │  hud-shim (Mac Mini)            │
 │                     │  POST   │                                 │
 │  audio ring buffer  │────────▶│  POST /v1/check                 │
 │  (last 30s PCM)     │         │   ├─ Whisper STT                │
 │                     │◀────────│   ├─ extract claims              │
 │  display result     │  JSON   │   ├─ search context_snippets    │
 │                     │         │   └─ return matches or "none"   │
 └─────────────────────┘         │                                 │
                                 │  Collector: context-indexer     │
                                 │   ├─ Slack: channels + DMs      │
                                 │   ├─ OpenClaw: session history   │
                                 │   └─ → context_snippets table   │
                                 └─────────────────────────────────┘
```

## Capabilities it needs

- [x] Glasses mic (`audioControl`) — always-on while the app is open
- [ ] IMU / head motion
- [ ] Location
- [ ] Camera / album
- [x] Network — hud-shim origin for `/v1/check`
- [x] Persisted state — last few results for re-reading

## Display sketch

576×288, top-left origin. Six containers: header, 3 result rows, list (recent checks), footer.

### Idle state
```
┌──────────────────────────────────────────────────┐
│  Fact Check · listening                           │  header (brightness 2)
│                                                   │
│  ··· long-press to check ···                      │  row1 (brightness 1)
│                                                   │  row2 empty
│                                                   │  row3 empty
│                                                   │
│  "deploy → Thu"  ✓  3d                            │  list: recent checks
│  "bot down 2d"   ·  5d                            │
│                                                   │
│  3 checks today                                   │  footer (brightness 1)
└──────────────────────────────────────────────────┘
```

### Checking state
```
┌──────────────────────────────────────────────────┐
│  Fact Check · checking…                           │  header (brightness 3)
│                                                   │
│  "we moved deploys to Thursdays"                  │  row1: the claim (brightness 4)
│  searching Slack, OpenClaw…                       │  row2 (brightness 2)
│                                                   │  row3 empty
│                                                   │
│  3 checks today                                   │  footer (brightness 1)
└──────────────────────────────────────────────────┘
```

### Result: match found
```
┌──────────────────────────────────────────────────┐
│  Fact Check · match                               │  header (brightness 3)
│                                                   │
│  ✓ "deploy window → Thu"                          │  row1: claim summary (brightness 4)
│  #ops-deploys · 3 days ago                        │  row2: source (brightness 2)
│  "Moving deploy window to Thu"                    │  row3: quote (brightness 2)
│                                                   │
│  long-press to check another                      │  footer (brightness 1)
└──────────────────────────────────────────────────┘
```

### Result: no match
```
┌──────────────────────────────────────────────────┐
│  Fact Check · no match                            │  header (brightness 2)
│                                                   │
│  · "the bot hasn't posted in 2 days"              │  row1: claim (brightness 3)
│  searched: Slack, OpenClaw                        │  row2: what was searched (brightness 1)
│  try a more specific claim                        │  row3: hint (brightness 1)
│                                                   │
│  long-press to retry                              │  footer (brightness 1)
└──────────────────────────────────────────────────┘
```

## Feasibility

- **Does it need the glasses to work without the phone?** No.
- **Does it need to see what the wearer sees?** No.
- **Does it need free-form drawing?** No — text is ideal.

### Real constraints

| Constraint | Impact | Mitigation |
|---|---|---|
| Audio PCM → Whisper latency | ~2s for 15s clip via OpenAI API | Acceptable; show "checking…" state |
| LLM claim extraction | Adds 1-2s and costs tokens | Start without it — search raw transcript |
| Slack API rate limits | Tier 2: ~20 req/min for conversations.history | Collector caches in SQLite; app never hits Slack directly |
| No background execution | Buffer resets if app is closed mid-conversation | Acceptable — you wouldn't check a closed conversation |
| OpenAI Whisper cost | $0.006/min of audio | ~15s clip = $0.0015 per check — negligible |
| Context corpus quality | Keyword search misses semantic matches | Start with keyword; add embedding search later if needed |

### API keys needed

| Key | Purpose | Location |
|---|---|---|
| `OPENAI_API_KEY` | Whisper STT + optional claim extraction | `.env` (hud-shim) |
| `SLACK_USER_TOKEN` | Read Slack messages for context indexing | `.env` (hud-shim) |

The Slack user token (`xoxp-`) is needed instead of a bot token because we're reading the user's
own messages and DMs — bots can't see DMs. This is a personal tool on a personal machine; the
token stays in the shim's `.env` and never leaves the Mac.

## Smallest version worth building

**Phase 1 — keyword search, no embedding:**

1. Collector pulls last 7 days of Slack messages from 3 channels into `context_snippets`
2. `POST /v1/check` receives raw text (skip audio for now — test the search path first)
3. Keyword search: split transcript into words, `LIKE '%word%'` on context_snippets
4. Return top 3 matches with source and timestamp
5. Glasses app: text input via menu (not audio yet) → display result

**Phase 2 — audio pipeline:**

1. Glasses mic → ring buffer (30s of PCM)
2. Long-press → freeze buffer → POST audio to shim
3. Shim → Whisper API → transcript → keyword search → result

**Phase 3 — LLM claim extraction:**

1. Whisper transcript → Claude/GPT extracts the factual claim
2. Better search: the claim's keywords, not the whole transcript's noise
3. Optional: embedding search with `text-embedding-3-small` for semantic matching

## Shim additions

### New tables

```sql
CREATE TABLE IF NOT EXISTS context_snippets (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,        -- 'slack', 'openclaw', 'calendar'
  channel    TEXT,                 -- Slack channel name or OpenClaw session key
  author     TEXT,
  text       TEXT NOT NULL,
  ts         INTEGER NOT NULL,     -- original message timestamp
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ctx_source ON context_snippets (source, ts DESC);
CREATE INDEX IF NOT EXISTS ctx_text   ON context_snippets (text);
```

### New endpoint

```
POST /v1/check
  Body: { text: string } | { audio: base64 }
  Response: {
    claim: string,
    matches: Array<{
      text: string,
      source: string,
      channel: string,
      author: string,
      ts: number,
      score: number
    }>,
    searched: string[],
    checkedAt: number
  }
```

### New collector

```
context-indexer:
  - Slack: conversations.history on configured channels, last 7 days
  - OpenClaw: session transcripts via sessions_history
  - Runs every 5 minutes (context doesn't need real-time)
```

## Notes

The audio pipeline (mic → PCM buffer → Whisper) is shared with
[name-rescue](name-rescue.md). Building this first means name-rescue gets the hard part
for free.

The claim extraction step is where the LLM adds value, but it's also where cost and latency
live. Start without it and see if raw keyword search is useful enough. If "deploy window
Thursday" matches a Slack message containing those words, that's good enough — you don't need
an LLM to tell you that.
