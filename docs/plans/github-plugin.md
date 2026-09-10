# Plan — GitHub Dashboard Plugin

> **Superseded by [`dev-hud.md`](dev-hud.md)**, which merges this with the OpenClaw and Jobs
> screens into one app over one shim. Kept for the GitHub-specific detail: ETag polling, PAT
> scopes, and the write-action allowlist.

Full build plan. Read-heavy, with a small set of write actions behind the same confirmation gate as
the OpenClaw plugin.

> **Read §4 first.** It is chronologically first — every item there has to be true before any
> code in §3 can be tested.

**What it does.** Glance at the glasses and know whether the things you shipped are green: CI state,
deploy state, PRs waiting on you, and anything that just broke. Approve a merge or re-run a failed
job without opening a laptop.

---

## 1. How it works on the server

### 1.1 The constraint that decides the architecture

**An Even Hub app cannot be pushed at.** No push notifications, no background execution while
closed. On iOS the WebView survives backgrounding with JS state intact; on Android it "may be
suspended under memory pressure," and Even's own docs say to treat that as *"the app starts cold."*

So there are no alerts. Every design here is **glance-on-demand**, and the thing that makes it
bearable is launching from the glasses menu (`launchSource === 'glassesMenu'`) — from "I wonder" to
"I know" without touching your phone.

The corollary: **freshness is the server's job, not the app's.** The app must never wait on GitHub.
It asks the shim for the current picture and renders whatever is already there.

### 1.2 Why the app never calls GitHub directly

Three independent reasons, any one sufficient:

1. **The whitelist is not a CORS bypass.** Adding `api.github.com` to `app.json` does not make
   GitHub send you CORS headers.
2. **A token in the app is a token in a web page.** Anything in the bundle is readable, and `.ehpk`
   files get uploaded.
3. **Rate limit and battery.** Polling GitHub from a phone every few seconds burns 5,000 req/hr and
   your battery for information that changes every few minutes.

So the same `tools/hud-shim` from the OpenClaw plan gains a GitHub module. One server, one
credential for the glasses, one Tailscale origin.

### 1.3 Poll, don't webhook

Webhooks require GitHub to reach *you*, which means a public inbound endpoint. Your shim is
tailnet-only and should stay that way — exposing it publicly would put an operator-adjacent service
on the internet to save a few seconds of latency.

**Poll with conditional requests instead.** Send `If-None-Match` with the stored ETag; a `304 Not
Modified` **does not count against your rate limit**. Polling a handful of repos every 30 seconds
costs you almost nothing.

```
每 30s   GET /repos/{o}/{r}/actions/runs?per_page=5     If-None-Match: <etag>
         GET /repos/{o}/{r}/commits/{sha}/status
每 60s   GET /search/issues?q=is:pr+review-requested:@me
每 60s   GET /repos/{o}/{r}/deployments
```

Backoff on `403` with `x-ratelimit-remaining: 0`, respect `Retry-After`, and never let a failed poll
blank the cache — serve stale with an age marker instead.

### 1.4 The cache is the product

The shim keeps a single in-memory snapshot, refreshed by the poller, persisted to SQLite so a
restart doesn't open cold.

```jsonc
{
  "updatedAt": 1757400000,
  "repos": [{
    "name": "evenRealities",
    "ci":     { "state": "failing", "job": "typecheck", "at": 1757399880, "runId": 123 },
    "deploy": { "state": "live", "env": "prod", "at": 1757399100 },
    "stale":  false
  }],
  "reviews": { "count": 2, "items": [{ "repo": "orca-api", "title": "Fix auth redirect", "number": 412 }] }
}
```

`stale: true` when the last successful poll for that repo is older than ~3 minutes. **The HUD must
show staleness.** A dashboard that silently shows old data is worse than one that admits it — you
will make a decision on it.

### 1.5 Endpoints

```
GET  /v1/gh/summary          → the snapshot above; served from cache, never blocks on GitHub
GET  /v1/gh/repo/:name       → detail for one repo: last 5 runs, failing job, head commit
POST /v1/gh/intent           → stage a write action  → { actionId, summary, expiresAt }
POST /v1/gh/confirm          → execute               → { status: "done" }
POST /v1/gh/cancel           → discard
```

Same bearer auth (`HUD_TOKEN`), same rate limit, same audit log as the OpenClaw plugin.

### 1.6 Write actions use the identical two-phase gate

Reads are free; writes are not. A merge you didn't mean is as unrecoverable as a message you didn't
mean, so writes reuse the gate verbatim — stage, render, approve, execute — enforced **in the shim**,
never in the app.

| Action | Allowed from glasses | Why |
|---|---|---|
| Re-run a failed job | Yes | Idempotent, cheap to undo, no side effects |
| Approve a PR review | Yes | Reversible; you can dismiss it |
| Merge a PR | **Only if** already approved by someone and all checks green | Otherwise you're merging what you can't read |
| Force merge / admin merge | No | Never from a 576×288 screen |
| Close an issue or PR | Yes | Reversible |
| Anything touching prod deploys | No — show "needs laptop" | The blast radius doesn't fit on the display |

Encode this as an explicit allowlist in the shim, not as a rule in the app. The app renders what the
shim says is permitted.

### 1.7 Auth to GitHub

Prefer a **fine-grained personal access token** over a classic PAT or a GitHub App. Rationale: a
GitHub App is the right answer for something multi-user or installable, and it is significant extra
setup — App registration, private key, installation token exchange — for a single-user tool. A
fine-grained PAT scoped to specific repositories gets you there in five minutes with a tighter
permission surface than a classic PAT.

Minimum permissions: **Actions** read (+ write only if you want job re-runs), **Contents** read,
**Pull requests** read (+ write for approve/merge), **Deployments** read, **Commit statuses** read.

Set an expiry and put a calendar reminder on it. A silently expired token presents as "everything
is stale," which is a confusing failure.

---

## 2. How it looks in the HUD

576×288, top-left origin. Two screens, one page, swapped with `textContainerUpgrade`.

### 2.1 Container layout

| Container | Type | Rect (x, y, w, h) | Role |
|---|---|---|---|
| `header` | text | 24, 18, 528, 30 | Repo count + freshness |
| `row1` | text | 24, 56, 528, 30 | Repo line 1 |
| `row2` | text | 24, 90, 528, 30 | Repo line 2 |
| `row3` | text | 24, 124, 528, 30 | Repo line 3 |
| `footer` | text | 24, 212, 528, 30 | Reviews waiting / hint |
| `list` | list | 24, 158, 528, 46 | Focus holder (`isEventCapture: 1`), scrolls repos |

Six of a possible 12 containers, five text of a possible 8. Exactly one container takes focus, or
the page receives no input.

### 2.2 Screens

```
SUMMARY                                  REPO DETAIL
┌────────────────────────────────────┐  ┌────────────────────────────────────┐
│ 3 repos · 14s ago                  │  │ evenRealities                      │
│ ✗ evenRealities  typecheck   2m    │  │ ✗ typecheck failed  ·  2m ago      │
│ ✓ orca-api       deployed   14m    │  │ commit a3f21e9 "fix container ids" │
│ ● dashboards     building  3/7     │  │                                    │
│ 2 PRs waiting on you               │  │ Re-run / Open on laptop            │
└────────────────────────────────────┘  └────────────────────────────────────┘

CONFIRM (write action)                   STALE
┌────────────────────────────────────┐  ┌────────────────────────────────────┐
│ Confirm                            │  │ 3 repos · 6m ago ⚠                 │
│ Re-run typecheck                   │  │ ✗ evenRealities  typecheck   8m    │
│ evenRealities #123                 │  │ ✓ orca-api       deployed   20m    │
│                                    │  │                                    │
│ Approve / Cancel                   │  │ can't reach GitHub — showing last  │
└────────────────────────────────────┘  └────────────────────────────────────┘
```

### 2.3 Reading it without reading it

**Brightness is the only visual channel** — no colour. `textColor` 0–4 carries urgency:

| State | Brightness | Glyph |
|---|---|---|
| Failing | 4 | `✗` |
| Building | 3 | `●` |
| Green | 2 | `✓` |
| Stale / unknown | 1 | `·` |

The goal: **"is anything broken?" answerable from peripheral vision, before you read a word.** One
bright line in a dim list is the entire interaction most of the time.

### 2.4 Interaction

| Input | Action |
|---|---|
| **List scroll** | Move through repos |
| **Click** | Open detail for the selected repo |
| **Long press** | Force refresh (bypass the poll interval) |
| **Contextual menu** | `Refresh` (1), `Re-run` (2), `Approve PR` (3), `Today` (4), `Exit` (5) |

Write actions appear in the menu **only when the selected repo has one available**, and never in the
first position — that's where a stray click lands.

### 2.5 Rules baked into the design

- **Three repos on screen, scroll for more.** A feed you have to scroll on a 576×288 display is a
  worse version of your phone. If you're regularly scrolling, the repo list is wrong, not the UI.
- **Always show data age.** `14s ago` in the header, and a `⚠` past the stale threshold.
- **Never blank on error.** Serve the last good snapshot with an explicit "can't reach GitHub."
- **Cold start paints from `localStorage`** before the first fetch returns. Android suspend means
  the app relaunches cold; it must never open on a spinner.
- **No audio output exists.** The SDK's audio is input-only. All feedback is visual and "done"
  holds ≥3s.

---

## 3. Steps to code and test

Each step ends in something verifiable. Do not proceed on an unverified step.

### Phase A — poller in isolation

1. `tools/hud-shim` GitHub module (the shim itself may already exist from the OpenClaw plan).
2. Fine-grained PAT from env. Client with ETag storage and conditional requests.
3. Poll one repo's Actions runs. Log the snapshot to stdout.
4. Verify `304` handling: confirm rate limit **does not decrement** on unchanged polls.

**Verify:** run for 10 minutes against a real repo. Push a commit, watch the state transition
`building → passing`. Check `x-ratelimit-remaining` barely moved.

### Phase B — full snapshot

5. Add commit status, deployments, and review-requested search.
6. SQLite persistence; stale marking at the 3-minute threshold.
7. `GET /v1/gh/summary` behind bearer auth.
8. Failure behaviour: kill network, confirm it serves stale with `stale: true` rather than erroring.

**Verify:** `curl` the summary. Pull the ethernet. Confirm you still get the last good snapshot.

### Phase C — write actions

9. Action allowlist from §1.6 as explicit config.
10. `POST /v1/gh/intent` staging with 60s TTL, single-use `actionId`.
11. `POST /v1/gh/confirm` executing re-run and PR approve.
12. Merge guard: verify approved-and-green **server-side** before staging, never client-side.

**Verify:** stage a merge on a red PR and confirm the shim **refuses to stage it at all**. That
refusal is the test that matters.

### Phase D — glasses app

13. `apps/hud/` (shared with the OpenClaw plugin) or a sibling app. `app.json` with the whitelist
    origin and `network` permission.
14. `PageBuilder` layout from §2.1; summary and detail screens.
15. Poll `/v1/gh/summary` every 2s while open; render from `localStorage` first.
16. Brightness mapping from §2.3.

**Verify over `npm run qr`:** break a build deliberately, glance at the glasses, see it go bright.

### Phase E — write actions on glass

17. Menu wiring with conditional items.
18. Confirm screen with countdown; expiry renders as expiry, not as failure.
19. Re-run a genuinely failed job from the glasses end to end.

**Verify:** kill the shim mid-confirm. Nothing executes, HUD recovers cleanly.

### Phase F — hardening

20. Rate-limit backoff under a forced `403`.
21. Token expiry simulation — confirm it surfaces as "auth failed," not as silent staleness.
22. `launchSource === 'glassesMenu'` — open from the glasses, phone untouched, first paint under 2s.
23. Android cold-start path: background the app, force-stop it, relaunch, confirm instant paint.

---

## 4. Deployment steps — before any code

### 4.1 Prove the WebView accepts the Tailscale cert ← do this first

Shared with the OpenClaw plan and it gates both. Serve a static page that `fetch()`es
`https://ais-mac-mini.tail7ed4e6.ts.net`, load it via `evenhub qr`, see whether the request
succeeds. **If it fails, stop** — the transport needs rethinking and nothing below matters yet.

### 4.2 Create the GitHub token

Fine-grained PAT, scoped to **only** the repos you want on the glasses. Permissions per §1.7. Set an
expiry, and put a reminder in your calendar for a week before it — a silently expired token looks
exactly like "GitHub is down."

### 4.3 Decide the repo list

Write it down before you write code. **Three repos is the design target.** If your instinct is ten,
the honest version is that you check three and worry about seven — the glasses should show the
three.

### 4.4 Tailscale — expose the shim

```bash
tailscale serve --bg --set-path /hud http://127.0.0.1:7777
```

Verify with `tailscale serve status`, then confirm the phone reaches it **on cellular with Wi-Fi
off**. That's what proves you're on the tailnet rather than just the LAN.

### 4.5 Tailscale on the phone

Installed, signed into the same tailnet, connected. Without it the origin is unreachable and the
failure looks like a whitelist problem.

### 4.6 Secrets

```bash
openssl rand -hex 32     # HUD_TOKEN, if not already created for the OpenClaw plugin
```

`HUD_TOKEN` and `GITHUB_TOKEN` into a gitignored `.env` or your keychain. **Never into `app.json`,
never into the bundle, never committed.**

### 4.7 Pick the stale threshold

Decide before building: how old is too old? 3 minutes is a reasonable default for CI. It determines
when `⚠` appears, and it's the difference between a dashboard you trust and one you second-guess.

### 4.8 Scope boundary

**Personal, tailnet-only. This does not go to Even Hub.** The whitelist points at your machine and
the shim holds a GitHub token. Do not pack it, do not submit it.

---

## Open questions

| Question | Resolved by | Risk |
|---|---|---|
| Does the WebView trust the `.ts.net` cert? | §4.1 | **High** — blocks everything |
| What `Origin` does a packed app send? | Phase D logs | Medium — CORS misconfig |
| Is 2s polling from the app too aggressive for battery? | Phase D | Low — only while open |
| Does 3 repos actually fit legibly at 576×288? | Phase D on-device | Low — layout tuning |
| Fine-grained PAT vs GitHub App long-term | After it works | Low — PAT is right for one user |
