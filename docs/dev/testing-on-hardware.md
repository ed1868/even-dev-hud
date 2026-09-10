# Runbook — testing a plugin on the glasses

How to get code you just wrote onto the G2 and see it render. This is the Even Hub SDK track,
**not** Even Terminal — different tab in the app, different tool. See
[`setup-even-terminal.md`](setup-even-terminal.md) for that one.

---

## One-time: enable developer mode

There is **no toggle in the app.** From Even's docs, verbatim:

> "no toggle. Signing in to the web hub flips your account to developer; the next restart of the
> phone app surfaces the developer section."

1. Sign in at **[hub.evenrealities.com/login](https://hub.evenrealities.com/login)** with the same
   account as the phone app.
2. **Force-quit** the Even app — swipe it away in the app switcher. Backgrounding is not enough.
3. Reopen it. A developer section now appears in the **top-right of the Even Hub tab**. That is
   where **Scan QR** lives.

If it still isn't there, the usual cause is the web hub login using a different account than the
phone.

---

## Every time: run and scan

```bash
npm run dev -w @even/dev-hud     # vite on 0.0.0.0:5175
npm run qr  -w @even/dev-hud     # QR pointing at this machine's LAN IP
```

Even app → **Even Hub tab** → developer section (top-right) → **Scan QR** → aim at the terminal.

The glasses render within about a second. **Hot reload works** — edit `src/`, save, and the
glasses redraw without re-scanning.

The `qr` script detects the default-route interface, so it works on Ethernet or Wi-Fi. (The Mini
is on `en1`; a hardcoded `en0` silently produces an empty IP.)

---

## The fast loop: no glasses at all

Most iteration does not need hardware. The shim renders the same screens at the same width:

```bash
cd tools/hud-shim
npm run collect && npm run show
```

```
┌──────────────────────────────────────────┐
│ Jobs · 6 · 2 need you                    │
│ ✗ Social Media Metrics Co… auth ×103     │
│ ✗ Social Media Publisher   auth ×584     │
└──────────────────────────────────────────┘
```

Use this for layout, truncation, and ordering. Save the glasses for interaction — scrolling,
clicking, the contextual menu — which is the only part you genuinely cannot fake.

---

## Reading the code that renders it

| Concern | File |
|---|---|
| Row and screen text | `apps/dev-hud/src/render.ts` |
| Navigation and polling | `apps/dev-hud/src/main.ts` |
| Container layout | `buildPage()` in `main.ts` |
| API shapes | `apps/dev-hud/src/client.ts` |

`render.ts` imports no SDK, so it can be exercised anywhere.

---

## Constraints that bite

From `docs/architecture.md`, the ones you hit while testing:

- **Local testing dies the moment the phone locks.** Keep the screen awake.
- **Exactly one container** sets `isEventCapture: 1`, or the page gets no input at all.
- The mic requires `createStartUpPageContainer` to have succeeded first; otherwise
  `audioControl` just returns `false`.
- `textColor` is **brightness 0–4**, not colour.
- Max 12 containers, max 8 text.
- **No audio output exists** — the SDK's audio is input-only. All feedback is visual.
- You cannot read logs off the glasses. Log transitions to the phone-side panel
  (`src/log.ts`), not every sample.

---

## Troubleshooting

### The page loads but the glasses stay blank

`createStartUpPageContainer` failed. Check the phone-side log panel. Almost always a container
constraint: no focus container, more than 12 containers, or a duplicate `zOrderIndex`.

### Every request fails with a network error

In order of likelihood:

1. **Tailscale off on the phone.** The app shows `no connection` and the footer says to check it.
2. **Shim not running** — `./scripts/devhud status`.
3. **CORS.** The shim only answers origins in `HUD_ALLOWED_ORIGINS`. The dev server origin must be
   listed:
   ```bash
   grep HUD_ALLOWED_ORIGINS tools/hud-shim/.env
   ```
   The shim logs every inbound `Origin` — if a real device sends something unexpected, that log
   line is the answer. Never respond to an unknown origin with a wildcard.

### `auth failed`

`VITE_HUD_TOKEN` in `apps/dev-hud/.env.local` does not match `HUD_TOKEN` in
`tools/hud-shim/.env`. Vite inlines env at **build time**, so restart the dev server after
changing it.

### It worked yesterday and now 401s

A stale process. This has bitten three times in this project:

```bash
./scripts/devhud status
```

Anything whose start time predates your last edit is suspect. `./scripts/devhud restart` for the
shim; `pkill -f even-terminal` for that one.

The shim now refuses to start on an occupied port and names the PID holding it, so this fails
loudly rather than silently.

---

## Packaging

```bash
npm run pack -w @even/dev-hud    # build + evenhub pack -> dev-hud.ehpk
```

`.ehpk` files cannot run locally — you upload them to Even Hub and open from the phone.

**Do not pack or submit the Dev HUD.** It embeds `VITE_HUD_TOKEN` and points at your private
tailnet. It is a personal tool; `hello-hud` is the one to practise packaging with.
