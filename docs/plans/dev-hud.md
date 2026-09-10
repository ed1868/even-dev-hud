# Plan — Dev HUD

One Even Hub app. Four screens. One read-only shim over a two-tier store.

Supersedes [`github-plugin.md`](github-plugin.md). The voice command work is parked as phase 2 —
see [`openclaw-plugin.md`](openclaw-plugin.md).

> **Read §4 first.** It is chronologically first — every item there must be true before any code
> in §3 is testable.

**What it is.** Glance at the glasses and see whether the machinery you depend on is healthy:
builds and PRs, your agent platform, and every scheduled job on the box. Read-only. Nothing on the
glasses can change anything, which is what makes it cheap and safe.

**The organising idea.** Every screen answers the same question — *what deserves my attention?* —
and the answer is almost always "nothing," rendered as a dim screen you look away from in two
seconds. The design exists for the rare bright line.

---

## 1. How it works on the server

### 1.1 Shape

```
   sources                collector          hot store        shim         glasses
┌──────────────┐         ┌──────────┐      ┌──────────┐   ┌─────────┐   ┌─────────┐
│ OpenClaw cron│──tail──▶│          │─────▶│  SQLite  │◀──│  :7777  │◀──│ Dev HUD │
│ OpenClaw sess│──HTTP──▶│ collector│      │  (hot)   │   │ read-   │   │ 4 screens│
│ GitHub API   │──poll──▶│          │      └────┬─────┘   │ only    │   └─────────┘
│ system cron  │──wrap──▶│          │           │         └─────────┘        ▲
└──────────────┘         └──────────┘           │ nightly                    │
                                                ▼                    Tailscale HTTPS
                                          ┌──────────┐
                                          │ Postgres │◀── MacBook, over tailnet
                                          │ (archive)│
                                          └──────────┘
```

**SQLite is the only thing the shim reads.** Postgres is an archive and the seed for a broader
developer-tools platform — long retention, real queries, and a thing your MacBook can point a
client at over the tailnet to see the same history. It is never in the glasses' hot path, so a
Postgres outage cannot make the dashboard lie.

The flow is **one-directional**: SQLite → Postgres. No bidirectional reconciliation, so no conflict
resolution and no "which side wins" question.

### 1.2 Sources

| Source | How it gets in | Why not otherwise |
|---|---|---|
| OpenClaw cron | Tail `~/.openclaw/cron/runs/*.jsonl`, read `jobs.json` for the registry | `cron` is on the gateway's HTTP deny list as a "persistent automation control plane". **Do not add `gateway.tools.allow: ["cron"]`** — the collector is co-located and reads the files directly, so the deny list stays intact. |
| OpenClaw sessions | `/tools/invoke` → `sessions_list`, `sessions_history`, `session_status` | None are on the deny list; all three are callable over HTTP. |
| OpenClaw usage | Shell out to `openclaw status --usage` | Same-host convenience; no HTTP equivalent needed. |
| GitHub | Poll the REST API with ETags | Webhooks would require a public inbound endpoint. A `304` doesn't count against rate limit, so 30s polling is nearly free. |
| System cron / launchd | Wrap the command in a logger that inserts a `runs` row | Nothing to tail otherwise. |

Worth one check before building: `hooks.internal.enabled` is `true` in your config. If OpenClaw can
fire a hook on cron completion, that beats tailing. Tailing is the safe fallback.

### 1.3 Schema

Per-domain tables, not a generic `cards` blob. Three consumers is enough to see they're genuinely
different shapes; a universal card format would fit none of them well.

```sql
-- Job registry: what SHOULD run. Any source.
CREATE TABLE jobs (
  id                   TEXT PRIMARY KEY,   -- "<source>:<external_id>"
  source               TEXT NOT NULL,      -- openclaw | launchd | cron | gha
  external_id          TEXT NOT NULL,
  name                 TEXT NOT NULL,
  schedule_expr        TEXT,               -- cron expr, or ISO instant for one-shots
  enabled              INTEGER NOT NULL DEFAULT 1,
  agent                TEXT,
  next_due_at          INTEGER,            -- epoch ms
  last_run_at          INTEGER,
  last_status          TEXT,               -- ok | error | running | unknown
  last_reason          TEXT,               -- short: "auth", "timeout"
  last_error           TEXT,               -- full message, truncated at read time
  last_duration_ms     INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL
);

-- Run history: what DID run.
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  source      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  duration_ms INTEGER,
  status      TEXT NOT NULL,
  reason      TEXT,
  error       TEXT,
  session_id  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX runs_job_time ON runs (job_id, started_at DESC);

-- GitHub
CREATE TABLE gh_repos (
  name TEXT PRIMARY KEY, ci_state TEXT, ci_job TEXT, ci_run_id INTEGER, ci_at INTEGER,
  deploy_state TEXT, deploy_env TEXT, deploy_at INTEGER, etag TEXT, fetched_at INTEGER
);
CREATE TABLE gh_reviews (
  id TEXT PRIMARY KEY, repo TEXT, number INTEGER, title TEXT,
  requested_at INTEGER, fetched_at INTEGER
);

-- OpenClaw
CREATE TABLE claw_channels (name TEXT PRIMARY KEY, connected INTEGER, checked_at INTEGER);
CREATE TABLE claw_sessions (key TEXT PRIMARY KEY, agent TEXT, tokens INTEGER,
                            ctx_pct REAL, last_at INTEGER);
CREATE TABLE claw_activity (id TEXT PRIMARY KEY, at INTEGER, channel TEXT,
                            agent TEXT, kind TEXT, summary TEXT);
```

Identical DDL runs on Postgres (`INTEGER` → `BIGINT`, `REAL` → `DOUBLE PRECISION`).

### 1.4 The clause the whole thing hinges on

**A job that never fires writes no row, and "no rows" looks exactly like "all fine."**

This is why `jobs` carries `next_due_at` and not just run history. The attention query is:

```sql
SELECT * FROM jobs
WHERE  enabled = 1
  AND (last_status = 'error'
   OR  consecutive_failures > 0
   OR  (next_due_at IS NOT NULL AND :now > next_due_at + :grace_ms));  -- ← silence
```

That last clause catches the failure nothing else catches. Your Metrics Collector is in that state
right now: 102 consecutive failures, last run 5.5 hours ago, exponential backoff (30s → 1m → 5m →
15m → 60m) throttling it into something that looks idle rather than broken.

### 1.5 Nightly export, and the unmonitored-monitor trap

A launchd job at ~03:00 copies new rows SQLite → Postgres by `created_at` watermark. Append-only,
idempotent on primary key.

**The collector and the export job must themselves appear in `jobs`.** Otherwise the thing watching
everything is the one thing nobody watches — and it fails silently in exactly the way this whole
design exists to catch.

### 1.6 Shim endpoints

All read-only. All served from SQLite, never blocking on a source.

```
GET /v1/attention          → the cross-source "what needs me" list; drives every screen's top line
GET /v1/gh/summary         → repos + review count
GET /v1/gh/repo/:name      → detail: last runs, failing job, head commit
GET /v1/claw/summary       → channel health, activity count, sessions, tokens, ctx %
GET /v1/claw/today         → today's activity log
GET /v1/jobs               → job list with state
GET /v1/jobs/:id           → detail + recent runs
GET /v1/health             → { ok, sqlite, collectorLastRunAt, sources: {...} }
```

Auth: `Authorization: Bearer HUD_TOKEN` — a credential minted for the glasses, separate from
anything else and independently rotatable. **No GitHub token, OpenClaw gateway token, or database
credential ever leaves the shim.**

### 1.7 Freshness, staleness, and never lying

Three layers: sources → collector (30s), collector → SQLite (immediate), app → shim (2s while
open). Worst case you're looking at ~32-second-old data.

- Every response carries `fetchedAt` per source.
- A source older than 3 minutes is marked `stale: true`.
- **A failed poll never blanks the cache.** Serve last-good, labelled.
- If SQLite is unreachable, the shim returns an error and the app renders `no connection`. It does
  **not** fall back to Postgres — archive rows presented as current is the exact failure mode this
  design exists to prevent.

### 1.8 CORS and the Origin unknown

The Even Hub whitelist is **not** a CORS bypass; the shim sets its own headers.

Open question nobody has documented: **what `Origin` does the WebView send?** In dev it's your Vite
server. Packed, it may be a custom scheme or literal `null`. So the shim **logs every inbound
`Origin` from day one**, and the allowlist is config, not code. Do not guess, and do not answer
`Origin: null` with a wildcard.

---

## 2. How it looks in the HUD

576×288, top-left origin. **One page, built once**; screens swap via `textContainerUpgrade`, which
is far cheaper than `rebuildPageContainer` and keeps the contextual menu intact.

### 2.1 Container layout — shared by every screen

| Container | Type | Rect (x, y, w, h) | Role |
|---|---|---|---|
| `header` | text | 24, 18, 528, 30 | Screen name + data age |
| `row1` | text | 24, 56, 528, 30 | |
| `row2` | text | 24, 90, 528, 30 | |
| `row3` | text | 24, 124, 528, 30 | |
| `footer` | text | 24, 212, 528, 30 | The line that matters |
| `list` | list | 24, 158, 528, 46 | Focus holder (`isEventCapture: 1`), scrolls |

Six of 12 containers, five of 8 text. Identical across screens, so switching is a content swap and
never a rebuild. Exactly one container takes focus, or the page receives no input at all.

### 2.2 The four screens

```
GITHUB                                   OPENCLAW
┌────────────────────────────────────┐  ┌────────────────────────────────────┐
│ GitHub · 14s ago                   │  │ OpenClaw · 22s ago                 │
│ ✗ evenRealities  typecheck   2m    │  │ ✓ WhatsApp    ✓ Slack              │
│ ✓ orca-api       deployed   14m    │  │ 14 actions today · 3 agents        │
│ ● dashboards     building  3/7     │  │ main  68% ctx · 412k tok           │
│ 2 PRs waiting on you               │  │ last 11:32  WA → Sam               │
└────────────────────────────────────┘  └────────────────────────────────────┘

JOBS                                     JOB DETAIL
┌────────────────────────────────────┐  ┌────────────────────────────────────┐
│ Jobs · 3 · 2 failing               │  │ Social Media Publisher             │
│ ✗ Social Publisher    err×583      │  │ ✗ auth · 583 consecutive           │
│ ✗ Metrics Collector   err×102      │  │ out of extra usage                 │
│ ⏸ Retry Metrics       disabled     │  │ last 23:19 · 31s · every 15m       │
│ auth · out of extra usage          │  │ next: overdue 47m                  │
└────────────────────────────────────┘  └────────────────────────────────────┘
```

### 2.3 The footer line, per screen

Each screen's footer carries the failure that **nothing else nags you about** — the recurring theme
of this whole design:

| Screen | Footer | Why that one |
|---|---|---|
| GitHub | `2 PRs waiting on you` | A red build finds you eventually. A pending review just silently blocks someone else. |
| OpenClaw | `✓ WhatsApp  ✓ Slack` | If a channel drops, your entire command path is dead and you'd read the silence as "thinking". |
| Jobs | `auth · out of extra usage` | A job in 60m backoff has stopped working and looks idle. |

### 2.4 Brightness is the only visual channel

No colour exists. `textColor` 0–4 carries urgency, and the goal is that **"is anything broken?" is
answerable from peripheral vision, before you read a word.**

| State | Brightness | Glyph |
|---|---|---|
| Error / overdue / channel down | 4 | `✗` |
| Running / building | 3 | `●` |
| Healthy | 2 | `✓` |
| Disabled / stale / unknown | 1 | `⏸` `·` |

One bright line in a dim list is the entire interaction, most of the time.

### 2.5 Interaction

| Input | Action |
|---|---|
| List scroll | Move through rows |
| Click | Open detail for the selected row |
| Long press | Force refresh past the poll interval |
| Contextual menu | `GitHub` (1) · `OpenClaw` (2) · `Jobs` (3) · `Refresh` (4) · `Exit` (5) |

### 2.6 Rules baked in

- **Three rows on screen, scroll for more.** A feed you scroll on 576×288 is a worse phone. If you
  scroll constantly, the source list is wrong, not the UI.
- **Always show data age**, with `⚠` past the stale threshold.
- **Never blank on error.** Last-good, explicitly labelled.
- **Cold start paints from `localStorage`** before the first fetch returns. Android may suspend the
  WebView and relaunch cold; the app must never open on a spinner.
- **Truncate errors intelligently.** `lastError` runs 400+ characters. Show `last_reason` (`auth`)
  as the glanceable field and the human clause of the message beneath it — never the exception class.
- **No audio output exists.** The SDK's audio is input-only. All feedback is visual.

---

## 3. Steps to code and test

Each step ends in something verifiable. Do not proceed on an unverified step.

### Phase A — store and collector, no glasses

1. `tools/hud-shim` workspace package. SQLite via `better-sqlite3`; schema from §1.3 as migrations.
2. OpenClaw cron collector: read `jobs.json` → upsert `jobs`; tail `runs/*.jsonl` → insert `runs`.
3. The attention query from §1.4, including the overdue clause.
4. Register the collector itself in `jobs`.

**Verify:** run it against your real cron state. It must surface both failing jobs with 583 and 102
consecutive errors. Then disable a job, set `next_due_at` to the past, and confirm it appears as
**overdue** rather than silently healthy. That test is the point of the whole design.

### Phase B — GitHub source

5. Fine-grained PAT from env; client with ETag storage and conditional requests.
6. Poll Actions runs, commit status, deployments, review-requested search.
7. Confirm `304` responses **do not decrement** `x-ratelimit-remaining`.
8. Kill the network; confirm last-good is served with `stale: true`, not an error.

**Verify:** push a commit, watch `building → passing` land in SQLite.

### Phase C — OpenClaw source

9. `/tools/invoke` → `sessions_list`, `sessions_history`, `session_status`.
10. `openclaw status --usage` shell-out for provider quota windows.
11. Channel health into `claw_channels`.
12. Activity counting: walk transcripts for tool calls, **cache the result** — do not recompute per
    request.

**Verify:** disconnect Slack, confirm the channel flips to down within one collector cycle.

### Phase D — shim API

13. All `GET` endpoints from §1.6 behind bearer auth. 401 without it.
14. `Origin` logging middleware on every request.
15. `fetchedAt` + `stale` on every response.

**Verify:** `curl` each endpoint. Stop the collector, confirm staleness appears rather than silence.

### Phase E — glasses app

16. `apps/dev-hud/` from `hello-hud`. `app.json` with the whitelist origin and `network` permission.
17. `PageBuilder` layout from §2.1; the four screens as content swaps.
18. `localStorage` cache; paint before first fetch.
19. Brightness mapping from §2.4; menu navigation from §2.5.

**Verify over `npm run qr`:** break a build on purpose, glance, see it go bright. Then force-stop
the app on Android, relaunch, and confirm it paints instantly from cache.

### Phase F — Postgres archive

20. Postgres on the Mini; schema mirrored.
21. Export job: watermark on `created_at`, append-only, idempotent on PK.
22. launchd entry at ~03:00. **Register the export job in `jobs`.**
23. Bind Postgres to the tailscale interface; `pg_hba.conf` allowing the tailnet range only.

**Verify:** connect from the MacBook over the tailnet and query the same history. Then break the
export and confirm it shows up on the **Jobs screen** — that's the unmonitored-monitor test.

### Phase G — hardening

24. Rate-limit backoff under a forced GitHub `403`.
25. PAT expiry simulation — must surface as `auth failed`, never as silent staleness.
26. `Origin` allowlist populated from what Phase E actually logged.
27. `launchSource === 'glassesMenu'` — open from the glasses, phone untouched, first paint <2s.

---

## 4. Deployment steps — before any code

### 4.1 Prove the WebView accepts the Tailscale cert — ✅ PASSED (2026-09-10)

Everything depends on the Even app's WebView trusting `*.ts.net`. Real Let's Encrypt cert, so it
should — but it is unverified and it is the single point of failure.

Built and ready: `tools/cert-probe`. Four staged tests that separate a rejected cert from a CORS
block from "the phone isn't on the tailnet" — see [`tools/cert-probe/index.html`](../../tools/cert-probe/index.html).

```bash
npm run dev -w @even/cert-probe     # serves on 0.0.0.0:5180
npm run qr  -w @even/cert-probe     # QR pointing at this machine's LAN IP
```

Check Safari on the phone first as a baseline: open `https://ais-mac-mini.tail7ed4e6.ts.net`. If
Safari fails too, the problem is the tailnet or the cert generally, not the WebView.

**Result on device (iPhone, Even app WebView, dev-mode QR):**

| # | Test | Result |
|---|---|---|
| 0 | control fetch | PASS |
| 1 | image over TLS | **PASS** — the WebView trusts the cert |
| 2 | fetch `no-cors` | PASS — transport is fine |
| 3 | fetch cors | FAIL — `TypeError: Load failed` |

Test 3 failing is **expected and harmless**: the gateway's `controlUi.allowedOrigins` does not
include the dev server origin, so it correctly refused. Tests 1 and 2 prove the transport, which is
the only thing that was actually unknown. The shim sets its own CORS headers.

Note the staging mattered — a single naive fetch would have returned `Load failed` and looked
exactly like a rejected certificate, which would have killed a working design.

**Still unknown:** the `Origin` a *packed* `.ehpk` sends. Dev mode sends the Vite origin as
expected; keep the shim's Origin logging from Phase D.

### 4.2 Tailscale — expose the shim

```bash
tailscale serve --bg --set-path /hud http://127.0.0.1:7777
```

Confirm in `tailscale serve status`, then reach it from the phone **on cellular with Wi-Fi off** —
that's what proves the tailnet rather than the LAN.

### 4.3 Tailscale on the phone — ✅ DONE

`iphone181` (100.102.249.57) is on the tailnet with a **direct** peer connection, not DERP-relayed.

Diagnostic worth keeping: Safari saying *"server can't be found"* is **DNS**, meaning the phone is
not on the tailnet. A rejected cert says *"This Connection Is Not Private."* Different failures,
different fixes.

This makes Tailscale on the phone a permanent operational dependency — if it drops, the HUD goes
dark. That is why the app renders an explicit `no connection` state rather than stale data.

### 4.4 Install Postgres — ✅ DONE

Running as `devhud-postgres` (`postgres:17-alpine`) via `infra/docker-compose.yml`. All eight tables
from §1.3 are created. Published to `127.0.0.1:5432` only; tailnet access via
`tailscale serve --bg --tcp 5432`, so the MacBook connects at
`postgresql://devhud@ais-mac-mini.tail7ed4e6.ts.net:5432/devhud` and the LAN cannot reach it.
Password in `infra/.env` (chmod 600, gitignored). See [`infra/README.md`](../../infra/README.md).

### 4.5 GitHub token

Fine-grained PAT, scoped to **only** the repos you want on the glasses. Minimum: Actions read,
Contents read, Pull requests read, Deployments read, Commit statuses read. Set an expiry and put a
calendar reminder a week before it — a silently expired token looks exactly like "GitHub is down."

### 4.6 Decide the repo list

Three repos is the design target. If your instinct is ten, the honest version is that you check
three and worry about seven.

### 4.7 Secrets

```bash
openssl rand -hex 32     # HUD_TOKEN
```

`HUD_TOKEN`, `GITHUB_TOKEN`, `OPENCLAW_GATEWAY_TOKEN`, `PGPASSWORD` into a gitignored `.env` or the
keychain. **Never into `app.json`, never into the bundle, never committed.**

### 4.8 Pick the thresholds

Decide before building, because they define what the screen means:

- **Stale** — a source older than this shows `⚠`. Suggest 3 minutes.
- **Overdue grace** — how far past `next_due_at` before a job counts as missed. Suggest 2× its
  interval, floor of 5 minutes, so a job with a slow start doesn't flap.

### 4.9 Scope boundary

**Personal, tailnet-only. This does not go to Even Hub.** The whitelist points at your machine and
the shim sits in front of a GitHub token, your agent platform, and a database. Do not pack it, do
not submit it.

---

## Open questions

| Question | Resolved by | Risk |
|---|---|---|
| ~~Does the WebView trust the `.ts.net` cert?~~ | ✅ §4.1 — **PASSED** | resolved |
| What `Origin` does a packed app send? | Phase E logs | Medium — CORS misconfig |
| Can `hooks.internal` fire on cron completion? | §1.2 check | Low — tailing works either way |
| Is there a queryable pending-approvals queue? | One lookup | Low — would make a better OpenClaw footer than activity count |
| Do three rows read legibly at 576×288? | Phase E on-device | Low — layout tuning |

## Deliberately out of scope

- **Writes of any kind.** Read-only is what makes this cheap and safe. Re-run-a-failed-job is the
  first write worth adding once the read path is proven, and it needs the staged-confirm gate from
  [`openclaw-plugin.md`](openclaw-plugin.md) §1.3.
- **Voice commands.** Phase 2. Send through WhatsApp or Slack, which already works and already
  solves recipient resolution, editing, and confirmation by existing.
- **Dollar costs.** Unavailable on your `anthropic:openclaw` OAuth path — dollar estimates are
  API-key-only. Show tokens and context percentage instead; `main 68% ctx` is more actionable than
  a dollar figure you can't act on mid-day.
