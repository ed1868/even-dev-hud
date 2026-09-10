# Plan — OpenClaw Voice Command Plugin

> **Parked as phase 2.** The dashboard work moved to [`dev-hud.md`](dev-hud.md); commands go
> through WhatsApp/Slack, which already solve recipient resolution, editing, and confirmation.
> Revisit if two weeks of real use shows you genuinely miss hands-free sending. The two-phase
> confirm gate in §1.3 is still the reference for any future write action.

Full build plan. Push-to-talk is in scope from the start; the prebaked menu ships alongside it as
the fallback path, not as a replacement for it.

> **Read §4 first.** It is chronologically first — every item there has to be true before any
> code in §3 can be tested.

**What it does.** Hold to talk. Speak a command. Your OpenClaw agent interprets it and answers on
the glasses. If it's an action — *"WhatsApp Sam I'm running 20 late"* — the HUD shows exactly what
it's about to do and waits for you to approve. Approve, it sends, HUD confirms, you exit listening
mode. A second screen shows everything OpenClaw has done today.

---

## 1. How it works on the server

### 1.1 Why there's a shim at all

OpenClaw's gateway cannot be called directly from the glasses. Its own docs, verbatim, about both
HTTP surfaces:

> Treat this endpoint as a **full operator-access** surface for the gateway instance… A valid
> Gateway token/password for this endpoint should be treated like an owner/operator credential.

With `gateway.auth.mode="token"` (your current setting) a bearer token restores the full operator
scope set — `operator.admin`, `operator.approvals`, `operator.pairing`, `operator.read`,
`operator.talk.secrets`, `operator.write` — and **explicitly ignores** any narrower
`x-openclaw-scopes` you send.

An Even Hub app is a web page. Anything in it is readable, and `.ehpk` files get uploaded to Even
Hub. So the gateway token can never live in the app.

`tools/hud-shim` holds the gateway token, exposes a narrow API, and issues the glasses a separate,
revocable credential.

```
G2 ──BLE── Even app ──WebView──┐
                               │ HTTPS · Tailscale · whitelisted in app.json
                               ▼
                     ┌─────────────────────────┐
                     │  hud-shim :7777         │
                     │  · HUD_TOKEN (glasses)  │
                     │  · GATEWAY_TOKEN (kept) │
                     │  · two-phase gate       │
                     │  · action log (SQLite)  │
                     └───────┬─────────────────┘
                             │ Bearer GATEWAY_TOKEN · loopback only
                             ▼
                 OpenClaw gateway :18789 ──▶ WhatsApp / Slack / tools
```

### 1.2 Plan and execute are deliberately different code paths

The single most important design decision. **The planning step must not be able to send anything.**

If you plan by asking the OpenClaw agent "what should I do with this?", the agent has tools and may
simply do it. Then your confirmation gate is decorative.

So:

| Phase | Who does it | Can it send? |
|---|---|---|
| Transcribe | Whisper API, called by the shim | No |
| Parse intent | A **direct LLM call with no tools bound** | Structurally cannot |
| Execute | OpenClaw `POST /tools/invoke`, explicit tool + args | Yes, only here |
| Answer (non-action) | OpenClaw `POST /v1/chat/completions` | Read-only turn |

The parse step returns strict JSON and nothing else:

```jsonc
{
  "kind": "action" | "answer" | "unclear",
  "channel": "whatsapp" | "slack" | "email" | null,
  "recipient": "Sam",           // as spoken; resolved separately
  "body": "running 20 late",
  "confidence": 0.0-1.0
}
```

`kind: "answer"` goes to the agent as a normal read-only turn and renders — nothing to approve.
`kind: "unclear"` renders as "didn't catch that" and never becomes an action.

### 1.3 Two-phase gate

"Ask me if I'm sure" is enforced **by the shim**, not the app. If the app decided, a JS exception, a
dropped connection, or an Android WebView suspend mid-flow could send a message you never approved.

```
POST /v1/intent
  body: multipart { audio: WAV }  |  { text: string }
  →  transcribe → parse → resolve recipient → stage
  →  200 { actionId, kind, summary, channel, recipient, body, expiresAt }
     NOTHING HAS BEEN SENT

POST /v1/confirm   { actionId }   → executes → { status: "sent", at }
POST /v1/cancel    { actionId }   → discards
GET  /v1/today                    → { actions: [...], counts }
GET  /v1/health                   → { ok, gateway: "up"|"down", version }
```

`actionId` is a 128-bit random, **single-use**, **60-second TTL**, held in memory only. Restart the
shim and every pending action evaporates.

> **Every failure path defaults to nothing happening.** That is the only acceptable default when
> the action is a message to a human.

### 1.4 Recipient resolution — the sharp edge

"Sam" is not an address. Resolution happens in the shim, before staging, and its result goes into
the confirmation summary so you approve a *resolved* target, never a guess.

- Maintain an explicit contacts map (`contacts.json`): spoken name → `{ channel, address, display }`.
- **Exactly one match** → stage it.
- **Zero or multiple matches** → do not stage. Return `kind: "unclear"` with the candidates so the
  HUD can list them for selection.
- Never fuzzy-match into a send. A homophone that picks the wrong Sam is unrecoverable.

The confirmation screen always shows the resolved display name **and** channel, never the raw
spoken token.

### 1.5 What the shim is made of

`tools/hud-shim/` — Node + TypeScript, added as a workspace package.

| Concern | Choice | Why |
|---|---|---|
| HTTP | Fastify or Express | Either; Express matches OpenClaw's own dep |
| STT | OpenAI Whisper API, called directly | One hop, not two. Latency is the whole feel. |
| Intent parse | Anthropic or OpenAI, **no tools bound** | Structural guarantee, not a prompt-level one |
| Pending actions | In-memory `Map` | Must not survive restart |
| Action log | SQLite (`better-sqlite3`) | Powers `/v1/today`; survives restart |
| Auth | `Authorization: Bearer HUD_TOKEN` | Separate from the gateway token, independently rotatable |
| Rate limit | ~30 req/min per token | Cheap insurance on a voice endpoint |
| Audit | Append-only log of every stage/confirm/cancel | You will want this the first time something odd sends |

Secrets come from the environment, never the repo: `HUD_TOKEN`, `OPENCLAW_GATEWAY_TOKEN`,
`OPENAI_API_KEY`.

### 1.6 CORS, and an unknown worth planning for

The Even Hub whitelist is **not** a CORS bypass — the shim sets its own headers.

The open question: **what `Origin` does the WebView send?** During dev it's your Vite server
(`http://<lan-ip>:5173`). Packed into an `.ehpk` it may be a custom scheme or literal `null`.
Nobody has documented this.

Plan for it: the shim **logs every inbound `Origin`** from day one, and the allowlist is config, not
code. First real device request tells you the answer. Do not guess it in advance and do not respond
to `Origin: null` with a wildcard.

---

## 2. How it looks in the HUD

576×288, top-left origin. One page built once; states swap via `textContainerUpgrade`, which is far
cheaper than `rebuildPageContainer` and keeps the contextual menu intact.

### 2.1 Container layout

| Container | Type | Rect (x, y, w, h) | Role |
|---|---|---|---|
| `title` | text | 24, 20, 528, 34 | Mode label |
| `line1` | text | 24, 66, 528, 40 | Primary content |
| `line2` | text | 24, 110, 528, 40 | Secondary content |
| `hint` | text | 24, 210, 528, 32 | What to do next |
| `menu` | list | 24, 156, 528, 46 | Focus holder (`isEventCapture: 1`) |

Five containers of a possible 12, four text of a possible 8. Room for the dashboard rows without a
rebuild. Exactly one container takes focus, or the page receives no input at all.

### 2.2 States

```
IDLE                         LISTENING                    THINKING
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ OpenClaw             │    │ ● listening          │    │ thinking…            │
│                      │    │                      │    │                      │
│ 4 actions today      │    │ 0:03                 │    │                      │
│ hold to talk         │    │ release to send      │    │                      │
└──────────────────────┘    └──────────────────────┘    └──────────────────────┘

CONFIRM                      SENT                         UNCLEAR
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ Confirm send         │    │ ✓ sent               │    │ Didn't catch that    │
│ WhatsApp → Sam Rivera│    │ WhatsApp → Sam Rivera│    │                      │
│ "running 20 late"    │    │                      │    │                      │
│ Approve / Cancel     │    │ 5 actions today      │    │ hold to try again    │
└──────────────────────┘    └──────────────────────┘    └──────────────────────┘

ANSWER                       TODAY
┌──────────────────────┐    ┌──────────────────────┐
│ OpenClaw             │    │ Today · 5 actions    │
│ Deploy finished 11m  │    │ 09:14 WA  → Sam      │
│ ago, all checks green│    │ 10:02 Slack → #eng   │
│ hold to talk         │    │ 11:30 WA  → Mum      │
└──────────────────────┘    └──────────────────────┘
```

### 2.3 Interaction

| Input | Action |
|---|---|
| **Long press** (hold) | Start capture. Release ends it. `longPress` channel reports source: `GLASSES_L`, `GLASSES_R`, or `RING`. |
| **Contextual menu** | `Approve` (1), `Cancel` (2), `Today` (3), `Quick…` (4), `Exit` (5) |
| **List scroll** | Scroll the Today log, or pick among prebaked commands |

`Approve` is only in the menu while a staged action exists, and it is **never the first item** —
that position is where a stray click lands.

### 2.4 Rules baked into the design

- **Brightness is the only visual channel.** No colour. `textColor` 0–4: confirm state at 4,
  normal at 3, history at 1. "Something needs me" must be answerable from peripheral vision.
- **No audio output exists.** The SDK's audio is input-only — no TTS, no beep. Every confirmation
  is visual, and "sent" holds for ≥3s before returning to idle.
- **`Cancel` is always available; `Approve` is conditional.** Cancelling by accident costs nothing.
- **Timer visible while staged.** A staged action expires in 60s; show the countdown so an expiry
  never looks like a failure.
- **Cold start paints from `localStorage`.** Android may suspend the WebView and return cold. Cache
  the last `/v1/today` count so the idle screen never opens on a spinner.

### 2.5 Prebaked commands

`Quick…` opens a list of fixed commands from `contacts.json` — *"tell Sam running late"*, *"ping
#eng standby"*. These still route through `/v1/intent` → confirm → `/v1/confirm`; identical gate,
just no microphone. This path keeps working when it's loud, when you're in a meeting, and when
Whisper is down.

---

## 3. Steps to code and test

Each step ends in something you can actually verify. Do not proceed on an unverified step.

### Phase A — shim skeleton, no OpenClaw

1. `tools/hud-shim` workspace package; add to root `tsconfig.json` references.
2. `GET /v1/health` → `{ ok: true }`. Bearer auth middleware; unauthenticated requests get 401.
3. `POST /v1/intent` with `{ text }` → hardcoded stub response, real `actionId`, real 60s TTL.
4. `POST /v1/confirm` → logs to SQLite, returns `{ status: "sent" }`. Sends nothing yet.
5. Origin logging middleware — every request records its `Origin` header.

**Verify:** `curl` the full stage→confirm cycle. Confirm an expired `actionId` returns 410 and a
reused one returns 409.

### Phase B — real intent parsing

6. Whisper call: accept `multipart/form-data` WAV, return a transcript.
7. Intent parser: direct LLM call, **no tools bound**, strict-JSON output, schema-validated.
8. `contacts.json` and the resolver. Zero/multi match → `kind: "unclear"` with candidates.

**Verify:** feed 20 recorded phrases including deliberate traps — two contacts named Sam, a
homophone, an empty clip, pure background noise. **Every ambiguous case must land on `unclear`,
never on a staged action.** This is the test that matters most; write it before you need it.

### Phase C — OpenClaw wired up

9. `tools_list` against the gateway to get the **exact** messaging tool name and arg schema. Do not
   guess it — the plan deliberately leaves it unnamed.
10. Execute path: `POST /tools/invoke` with explicit tool + args.
11. Answer path: `POST /v1/chat/completions`, `model: "openclaw/main"`.
12. `GET /v1/today` from the SQLite log.

**Verify:** send yourself a WhatsApp message end to end from `curl`. Then kill the gateway and
confirm the shim degrades to a clean error rather than a hang.

### Phase D — glasses app

13. `apps/hud/` from `hello-hud`. `app.json` with the whitelist origin and the `network` permission.
14. `PageBuilder` layout from §2.1; state machine driving `setText`.
15. Client with bearer auth, timeouts, and a visible error state for every failure.
16. Menu wiring: Approve / Cancel / Today / Quick / Exit.

**Verify over `npm run qr`:** menu path only — stage, confirm, send, real message arrives.

### Phase E — audio

17. `audioControl(true, AudioInputSource.Glasses)` — **after** the startup page exists, or it
    returns `false`.
18. Buffer frames on `longPress` down, stop on release, filter to `speakerRole === Self`.
19. PCM → WAV (a header on the raw frames) → POST to `/v1/intent`.
20. Latency instrumentation at each hop: capture, upload, Whisper, parse, render.

**Verify:** measure the real round trip. Under ~3s feels live; over ~6s you will stop using it.
If it's slow, the fix is usually upload size, not the model.

### Phase F — hardening

21. Rate limit; audit log; `Origin` allowlist populated from what Phase D actually logged.
22. Restart the shim mid-stage — confirm the pending action is gone and the HUD shows expiry.
23. Airplane-mode the phone mid-confirm — confirm nothing sends and the HUD recovers.
24. `launchSource === 'glassesMenu'` path — open from the glasses, no phone touched.

---

## 4. Deployment steps — before any code

Every one of these must be true before Phase A is testable. **The first item is the one that can
sink the whole design, so do it first.**

### 4.1 Prove the WebView accepts the Tailscale cert ← do this first

Everything depends on the Even app's WebView trusting `*.ts.net`. It's a real Let's Encrypt cert so
it should, but it is unverified and it is the single point of failure.

Cheapest possible test, no shim needed:

1. Serve a static page with a `fetch()` to your existing `https://ais-mac-mini.tail7ed4e6.ts.net`.
2. Load it via `evenhub qr` from the Even app.
3. See whether the request succeeds.

**If this fails, stop.** The design needs a different transport and none of the rest is worth
building yet.

### 4.2 Tailscale — expose the shim

Your gateway is already served at the tailnet root. The shim needs its own path or port:

```bash
tailscale serve --bg --set-path /hud http://127.0.0.1:7777
```

Confirm it appears in `tailscale serve status`, and that the phone can reach it **on cellular with
Wi-Fi off** — that proves you're on the tailnet, not just the LAN.

### 4.3 Tailscale on the phone

The Tailscale app installed, signed into the same tailnet, and connected. Without it the origin is
unreachable and the failure looks like a whitelist problem, which will cost you an hour.

### 4.4 Enable the OpenClaw chat endpoint

`POST /v1/chat/completions` is **disabled by default** and you need it for the answer path.
`/tools/invoke` is always enabled and needs nothing.

Also review `gateway.tools.deny`. The default HTTP deny list already blocks `exec`, `shell`,
`fs_write`, `fs_delete`, `apply_patch`, `sessions_spawn`, `gateway`, and `nodes` — good defaults.
**Do not weaken them for this project.**

### 4.5 Secrets

```bash
openssl rand -hex 32     # HUD_TOKEN — the glasses credential
```

Three env vars for the shim: `HUD_TOKEN`, `OPENCLAW_GATEWAY_TOKEN`, `OPENAI_API_KEY`. Into a
`.env` that is gitignored, or your keychain. **Never into `app.json`, never into the bundle, never
committed.**

### 4.6 Contacts

Write `contacts.json` by hand before any code — spoken name → channel + address + display name.
Start with three people you'd actually message. This file is also your ambiguity test fixture.

### 4.7 Confirm the messaging tool name

`tools_list` over the gateway, and record the exact tool name and arg schema for WhatsApp and
Slack sends. Phase C blocks on this and the plan deliberately does not guess it.

### 4.8 Decide the recording posture

The glasses mic captures whoever is nearby, not only you. `speakerRole === Self` filters *what you
act on*, but frames still reach the shim and Whisper.

Decide now, and write it down: buffer discarded on release, nothing but the transcript persisted,
audio never written to disk. It is much harder to retrofit this than to build it in.

### 4.9 Scope boundary

**This is a personal, tailnet-only build. It does not go to Even Hub.** The whitelist points at
your machine and the shim fronts operator-level access to your agent platform. Do not pack it, do
not submit it, do not put `HUD_TOKEN` in anything that gets uploaded.

---

## Open questions

| Question | Resolved by | Risk |
|---|---|---|
| Does the WebView trust the `.ts.net` cert? | §4.1 | **High** — blocks everything |
| What `Origin` does a packed app send? | Phase D logs | Medium — CORS misconfig |
| Whisper round-trip latency on a phone tether | Phase E | Medium — decides if voice is usable |
| Exact messaging tool name + args | §4.7 | Low — one lookup |
| Battery cost of held-mic capture | Phase E | Low — bursts, not continuous |
