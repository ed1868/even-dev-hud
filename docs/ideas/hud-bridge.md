# HUD Bridge

**Status:** explored
**Shape:** app + a server component (new `tools/hud-bridge`)

The spine for the "control your own systems" territory. Not an idea so much as the thing the
other ideas in that territory all turn out to need.

## What it does

One small server on your laptop aggregates state from whatever you care about — running
agents, CI, deploys, queues — and exposes two things: **cards** to glance at, and **actions**
to take. The glasses app is a thin client over that. New sources plug into the server; the
glasses app never changes.

## The two constraints that force this design

Both verified, both non-obvious, and together they rule out the obvious version of every idea
in this territory.

**1. Nothing can page you.** Even Hub apps have no push notifications and no background
execution while closed ([Background Lifecycle](https://hub.evenrealities.com/docs/build/background-lifecycle)).
On iOS the WebView survives backgrounding with JS state intact; on Android it "may be suspended
under memory pressure," and the docs say to treat Android suspend as *"the app starts cold."*

So there is no alert-on-your-face app. The interaction is **you decide to look, and the answer
is already there.** The thing that makes that bearable is launching from the **glasses menu**
(`launchSource === 'glassesMenu'`) — you can go from "I wonder" to "I know" without touching
your phone. Design for a sub-two-second glance, and persist everything to `localStorage` so an
Android cold start repaints instantly instead of showing a spinner.

**2. The app cannot reach a bare LAN IP reliably.** `app.json`'s network whitelist takes a full
origin (`https://api.example.com`); "bare hostnames and wildcards aren't supported," and the
Even app "enforces it before the request ever leaves the WebView — anything not in the whitelist
is blocked, no traffic generated at all." Plain `http://` is dev-only. Your laptop's LAN IP also
changes, and the whitelist is baked in at pack time.

**The fix is Tailscale Serve.** It gives your laptop a *stable HTTPS origin*
(`https://<machine>.<tailnet>.ts.net`) that works from any network, which is exactly the shape
the whitelist wants. Put that origin in `app.json` once and it never changes.

Third gotcha, from the same page: the whitelist **is not a CORS bypass.** Your bridge sets its
own `Access-Control-Allow-Origin`. You control the server, so this is a one-line fix — but it
fails confusingly if you miss it.

## Shape

```
  ┌─── sources (plug-in) ────┐
  │  claude-code hook        │
  │  CI webhooks             │        ┌──────────────┐   Tailscale Serve   ┌──────────┐
  │  deploy events           │───────▶│  hud-bridge  │───── HTTPS ────────▶│  glasses │
  │  whatever's next         │        │  :7777       │◀──── actions ───────│   app    │
  └──────────────────────────┘        └──────────────┘                     └──────────┘
```

Two endpoints is the whole contract:

```ts
GET  /cards              → { cards: Card[], pending: Action[] }   // poll every ~2s while open
POST /actions/:id        → { decision: 'allow' | 'deny' }
```

```ts
type Card = {
  id: string;
  label: string;                       // ≤ ~40 chars; it's a 576×288 display
  value: string;
  state: 'ok' | 'warn' | 'blocked';    // maps to text brightness 0–4
  updatedAt: number;
};
```

Poll rather than hold a WebSocket. A socket buys you nothing when the app is only open for two
seconds at a time, and on Android it drops on suspend anyway.

## Feasibility

Not blocked. The real work is on the laptop side, not the glasses side — which is good news,
because that half is ordinary Node with a real debugger.

Open questions worth resolving early:

- Does Tailscale Serve's cert satisfy the Even app's WebView on both iOS and Android? Should
  be fine (real Let's Encrypt cert), but it's the single point of failure for the whole design.
- Tailnet HTTPS has to be enabled in the Tailscale admin console. One-time.
- Auth: the bridge is reachable by anything on your tailnet. A shared token in a header is
  probably enough; don't ship it unauthenticated even inside the tailnet.

## Smallest version worth building

One card, hardcoded. `GET /cards` returns `[{ label: 'build', value: 'passing', state: 'ok' }]`,
the glasses app renders it, and you launch it from the glasses menu. That proves the entire
chain — Tailscale origin, whitelist, CORS, glasses-menu launch, render — with no real data
source attached. Everything after that is adding sources.

## Notes

Do not build the generic card system first. Build [agent-inbox](agent-inbox.md) with a
hardcoded shape, and let the second source tell you what the abstraction should be.
