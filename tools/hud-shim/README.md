# @even/hud-shim

Read-only aggregation service behind the Dev HUD. **Holds every credential in the system; the
glasses hold none.** See [`docs/plans/dev-hud.md`](../../docs/plans/dev-hud.md).

Zero runtime dependencies — `node:http`, `node:sqlite`, `node:crypto`. Runs `.ts` directly via
Node 24's native type stripping, so there is no build step.

## Run

```bash
export HUD_TOKEN=$(openssl rand -hex 32)      # the glasses' credential
npm run collect -w @even/hud-shim             # one pass, prints what the HUD would show
npm start       -w @even/hud-shim             # serve on 127.0.0.1:7777
```

## Environment

| Var | Default | Notes |
|---|---|---|
| `HUD_TOKEN` | — | **Required.** Refuses to start without it. |
| `HUD_PORT` / `HUD_HOST` | `7777` / `127.0.0.1` | Loopback; tailnet via `tailscale serve` |
| `HUD_DB` | `~/.devhud/hud.sqlite` | |
| `HUD_ALLOWED_ORIGINS` | empty | Comma-separated. Fill from logged Origins — never wildcard. |
| `OPENCLAW_GATEWAY_TOKEN` | — | Sessions source; cron works without it |
| `GITHUB_TOKEN` / `GITHUB_REPOS` | — | `owner/repo,owner/repo` |
| `HUD_STALE_MS` | `180000` | Older than this shows ⚠ |
| `HUD_OVERDUE_GRACE_MS` | `300000` | Floor before a missed run counts as overdue |

An unset source reports `unknown`, not `error` — "not configured yet" is a different state from
"broken", and conflating them makes the Jobs screen cry wolf.

## Endpoints

All `GET`, all served from SQLite, none blocking on a third party.

```
/v1/health          liveness + per-source freshness   (unauthenticated by design)
/v1/attention       cross-source "what needs me"
/v1/jobs            job list with state
/v1/jobs/:id        detail + last 10 runs
/v1/gh/summary      repos + PRs waiting on you
/v1/gh/repo/:name
/v1/claw/summary    channel health, sessions, tokens
/v1/claw/today      activity log
```

Everything except `/v1/health` requires `Authorization: Bearer $HUD_TOKEN`, compared in constant
time. `/v1/health` is open on purpose: it reports liveness only, no data, and it must be probeable
when the token itself is what's misconfigured.

## Why the cron collector reads files

`cron` sits on the OpenClaw gateway's HTTP deny list as a "persistent automation control plane".
The tempting fix — `gateway.tools.allow: ["cron"]` — would reopen that whole control plane over
HTTP just to read status. The collector is co-located, so it reads `~/.openclaw/cron/` directly and
never needs a privilege the gateway deliberately refuses.

## The design's load-bearing idea

A job that never fires writes no run row, and **"no rows" looks exactly like "all fine."** So the
`jobs` registry carries `next_due_at` and `attention.ts` detects *silence*, not just failure:

```
state = error    → last_status='error' or consecutive_failures > 0
        overdue  → now > next_due_at + grace          ← the one nothing else catches
        disabled → enabled = 0
```

Grace scales with the job's own cadence (2× its interval, floor 5 min) so a fifteen-minute job
isn't judged by the same window as a nightly one.

Collectors register themselves as jobs and record their own runs. Without that, the thing watching
everything is the one thing nobody watches.
