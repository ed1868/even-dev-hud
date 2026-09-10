# OpenClaw Voice Commands

**Status:** explored — ready to build
**Shape:** plugin + a small shim server (`tools/hud-shim`)

## What it does

Long-press, speak a command, release. Your OpenClaw agent interprets it and answers on the
glasses. If the command is an *action* — "WhatsApp Sam that I'm running 20 late" — the HUD shows
what it's about to do and waits for you to confirm. Approve and it sends; the HUD shows "sent",
then you exit listening mode. A second screen shows what OpenClaw has done today.

## Why most of this is already built

The backend exists and is running. Verified on this machine:

| Piece | Status |
|---|---|
| Agent runtime with tools | OpenClaw `2026.4.5`, gateway live on `:18789` |
| WhatsApp + Slack | channels enabled, agent bindings configured |
| Speech-to-text | `openai-whisper-api` skill installed |
| Stable HTTPS origin for `app.json` | `https://ais-mac-mini.tail7ed4e6.ts.net` — Tailscale Serve, already proxying to the gateway |
| HTTP action API | `POST /tools/invoke` — *always enabled* |
| Agent turn API | `POST /v1/chat/completions` — **disabled by default**, enable in config |

`/v1/chat/completions` treats `model` as an agent target: `openclaw/<agentId>` routes to a
specific agent (you have `main`, `hwek`, `frontend`).

## The constraint that shapes the design

**Both HTTP surfaces are full operator access.** From OpenClaw's own docs, verbatim:

> Treat this endpoint as a **full operator-access** surface for the gateway instance… A valid
> Gateway token/password for this endpoint should be treated like an owner/operator credential.

With `gateway.auth.mode="token"` — which is your current setting — a bearer token restores the
full default operator scope set: `operator.admin`, `operator.approvals`, `operator.pairing`,
`operator.read`, `operator.talk.secrets`, `operator.write`. It explicitly **ignores** any
narrower `x-openclaw-scopes` you try to send.

An Even Hub app is a web page. Anything in it is readable. So:

> **The glasses app must never hold the gateway token.** It is not an API key with limited
> scope; it is root on your agent platform, including secrets.

Hence the shim: a small server that holds the gateway token, exposes three narrow endpoints, and
issues the glasses their own separate, revocable credential.

## Architecture

```
  G2 ──BLE── Even app ──WebView──┐
                                 │  HTTPS (Tailscale, whitelisted in app.json)
                                 ▼
                        ┌──────────────────┐   token stays here, never leaves
                        │  hud-shim :7777  │
                        │  · own credential│
                        │  · 2-phase gate  │
                        │  · action log    │
                        └────────┬─────────┘
                                 │  Bearer <gateway token>  (loopback only)
                                 ▼
                        OpenClaw gateway :18789 ──▶ WhatsApp / Slack / tools
```

## The two-phase gate — the important part

"Ask me if I'm sure" **must be enforced by the shim, not the glasses.** If the app decides
whether to confirm, then a JS bug, a dropped connection, or an Android suspend mid-flow can send
a message you never approved.

```
POST /intent   { audio } | { text }
   → shim transcribes, asks the agent to PARSE AND PLAN — explicitly not execute
   → { actionId, summary, channel, recipient, kind: 'answer' | 'action' }
   → nothing has been sent

   HUD renders summary + [Approve] [Cancel]

POST /confirm  { actionId }
   → shim executes via /tools/invoke
   → { status: 'sent' }

GET  /today    → actions executed today, for the dashboard screen
```

`actionId` is single-use and expires in ~60s. **The default outcome of every failure is that
nothing happens** — which is the only acceptable default when the action is a message to a human.

`kind: 'answer'` skips confirmation entirely; there's nothing to approve about an answer.

## Display sketch

576×288. Three states, one page, swapped with `setText` rather than rebuilt.

```
listening                    confirming                   done
┌────────────────────┐      ┌────────────────────┐      ┌────────────────────┐
│ ● listening…       │      │ WhatsApp → Sam     │      │ ✓ sent             │
│                    │      │ "running 20 late"  │      │                    │
│ release to send    │      │                    │      │ 4 actions today    │
└────────────────────┘      │ [Approve] [Cancel] │      └────────────────────┘
                            └────────────────────┘
                              ↑ contextual menu
```

There is **no audio output** on the G2 — the SDK's audio is input-only. Every piece of feedback
is visual, and "sent" needs to linger long enough to read.

## Audio path

`audioControl(true, AudioInputSource.Glasses)` → PCM frames on the `audio` event channel. Two
things worth knowing:

- The **startup page must exist first** or `audioControl` returns `false`. Ordering, not permissions.
- `speakerRole === Self` filters to your own speech. You get "ignore the people around me" for
  free, without solving diarization.

Buffer frames while the press is held, wrap as WAV (a header on raw PCM), POST on release.

## Feasibility

Not blocked. Open items, in order of risk:

1. Does the Even app's WebView accept the Tailscale Serve cert on iOS and Android? Real Let's
   Encrypt cert, so it should — but it's the single point of failure for the whole design.
2. `/v1/chat/completions` needs enabling in `openclaw.json` (it's off by default). `/tools/invoke`
   does not.
3. Whisper round-trip latency for a ~5s clip — unmeasured, and it sets the whole feel.
4. CORS: `gateway.controlUi.allowedOrigins` already lists the tailnet origin, but the shim sets
   its own headers regardless. The Even Hub whitelist is not a CORS bypass.

## Smallest version worth building

**Skip audio entirely for v1.** Contextual menu with 3 prebaked actions → `/intent` → confirm →
`/confirm` → "sent". That proves the entire chain — whitelist, Tailscale, shim, gateway, WhatsApp,
confirmation gate — with no STT and no latency risk.

Add push-to-talk second. The menu path stays useful forever as the reliable fallback.

## Notes

**Do not pack the token into an `.ehpk`, and do not ship this to Even Hub.** Personal build,
tailnet only. The shim's credential should be separate from the gateway token precisely so it can
be rotated without touching OpenClaw.

Related: [agent-inbox](agent-inbox.md) and [ship-status](ship-status.md) become extra `GET`
endpoints on this same shim rather than separate servers. [hud-bridge](hud-bridge.md) described
this shim before we knew OpenClaw was already there — the shim supersedes it.
