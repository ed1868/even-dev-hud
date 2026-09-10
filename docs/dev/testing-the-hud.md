# Testing the HUD without glasses

Three ways to see the data, cheapest first. You do not need the phone or the glasses for any of
the first two — and the first one is the fastest feedback loop for layout work.

## 1. `npm run show` — what the glasses will display

Renders the actual screens at the actual width (40 characters per line, 3 rows), so you can see
whether a line fits and whether the right thing is at the top.

```bash
cd tools/hud-shim
npm run collect    # refresh from all sources
npm run show       # render the screens
```

```
┌──────────────────────────────────────────┐
│ Jobs · 6 · 2 failing                     │
│ ✗ Social Media Metrics Co… auth ×103     │
│ ✗ Social Media Publisher   auth ×584     │
│ · Collector · OpenClaw se… now           │
│                                          │
│ LLM request rejected: You're out of ext… │
└──────────────────────────────────────────┘
```

Read-only — it renders whatever the collector last wrote.

## 2. The HTTP API

```bash
cd tools/hud-shim
npm start                      # loads .env, serves 127.0.0.1:7777
```

Then, from anywhere on the tailnet:

```bash
TOKEN=$(grep '^HUD_TOKEN=' tools/hud-shim/.env | cut -d= -f2)
B=https://ais-mac-mini.tail7ed4e6.ts.net/hud

curl -s $B/v1/health | jq                                  # open, no auth
curl -s -H "Authorization: Bearer $TOKEN" $B/v1/jobs | jq
curl -s -H "Authorization: Bearer $TOKEN" $B/v1/gh/summary | jq
curl -s -H "Authorization: Bearer $TOKEN" $B/v1/attention | jq
```

`/v1/health` is deliberately unauthenticated — liveness only, no data, and it must be probeable
when the token is what's misconfigured. **From your phone**, open
`https://ais-mac-mini.tail7ed4e6.ts.net/hud/v1/health` in Safari; that also re-confirms the
tailnet path any time something looks broken.

Exposed with:

```bash
tailscale serve --bg --set-path /hud http://127.0.0.1:7777
```

## 3. On the glasses

`apps/dev-hud` — not built yet. Everything above is the same data it will render.

---

## When something looks wrong

**Check for a stale process first.** This has now bitten twice — once with `even-terminal`, once
with the shim. A previous instance holds the port, the new one fails to bind, and you end up
talking to an old process with an old token. It presents as a mystifying `401` or a failed probe.

```bash
lsof -i :7777      # shim
lsof -i :3456      # even-terminal
lsof -i :18789     # openclaw gateway
```

If a PID is older than your last start, that's the problem. Kill it and restart.

**Then read the source states**, which say precisely what each source thinks:

```bash
curl -s http://127.0.0.1:7777/v1/health | jq '.sources'
```

| `last_error` | Meaning |
|---|---|
| `null` with a recent `last_ok_at` | Healthy |
| `not configured: set X` | Source isn't set up. Reports `unknown`, not `error` — deliberate. |
| An HTTP status | The upstream refused. Last-good data is still served, marked stale. |
| `rate limited; resets at …` | Only reachable if ETags stopped working; a normal cycle costs 0 requests. |

## Cost of a poll cycle

Measured, not assumed: a full GitHub pass over 3 repos plus the review search costs **0** requests
against the 5,000/hr limit, because conditional requests return `304`. Polling every 30s all day is
genuinely free.

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/rate_limit \
  | jq '.resources.core.remaining'
```
