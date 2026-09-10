# Ship Status

**Status:** raw
**Shape:** a source for [hud-bridge](hud-bridge.md), not its own app

## What it does

Glance to see whether the thing you just pushed is green. CI state, deploy state, and open PR
review requests for the repos you actually work in — without unlocking anything.

## Capabilities it needs

- [x] Network — via `hud-bridge`; GitHub is never called from the glasses directly
- [x] Persisted state — last-known state paints instantly on cold start
- [ ] everything else

## Display sketch

```
┌──────────────────────────────────────────────────┐
│  ✗ evenRealities   typecheck failed · 2m         │
│  ✓ orca-api        deployed · 14m                │
│  ● dashboards      building… 3/7                 │
│                                                   │
│  2 PRs waiting on you                            │
└──────────────────────────────────────────────────┘
```

## Feasibility

Nothing novel — it's [hud-bridge](hud-bridge.md)'s constraints and no others. Worth stating why
it must be a bridge source rather than an app that calls GitHub itself:

- The whitelist is **not a CORS bypass**. Calling the GitHub API straight from the WebView means
  living with GitHub's CORS headers and putting a token in a page you can't secure.
- Polling GitHub every two seconds from a phone burns rate limit and battery for nothing.

The bridge holds the token, subscribes to webhooks (or polls sanely once), and the glasses read
a cached summary. Same reasoning applies to every third-party source you add later.

The interesting question is not *can you* but *how little* you can show. Three repos and a PR
count is probably the whole product. A feed you have to scroll on a 576×288 display is a worse
version of your phone.

## Smallest version worth building

One repo, one line: is `main` green. Add repos only when you miss them.

## Notes

Deliberately second. Build [agent-inbox](agent-inbox.md) first with a hardcoded card shape, then
add this as source #2 — the second source is what tells you whether the `Card` abstraction is
right. Designing the generic format before you have two real users of it is how you get a
format that fits neither.
