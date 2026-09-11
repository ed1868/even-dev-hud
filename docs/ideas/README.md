# Ideas

Capture space for plugin and app ideas. One file per idea, `kebab-case.md`, copied from
[`_template.md`](_template.md).

The point of the template's **Feasibility** section is to kill bad ideas in five minutes rather
than five hours. Most G2 ideas die on one of three facts:

- **The phone is always in the loop.** No standalone glasses operation.
- **There is no glasses camera API.** `captureImageFromCamera` is the *phone* camera.
- **The display is 12 containers of text/list/image**, not a canvas you draw on.

Check an idea against [`../architecture.md`](../architecture.md) before writing it up.

## Status

**Current focus:** controlling your own systems from the glasses, as a daily driver.

| Idea | Status | Notes |
|---|---|---|
| [OpenClaw voice commands](openclaw-voice.md) | **ready to build** | Backend already exists and is running. Start here. |
| [Agent inbox](agent-inbox.md) | explored | Mechanism verified end to end. Becomes an endpoint on the same shim. |
| [HUD bridge](hud-bridge.md) | superseded | Written before we found OpenClaw. See `tools/hud-shim` in [openclaw-voice](openclaw-voice.md). |
| [Ship status](ship-status.md) | raw | GitHub dashboard. Another endpoint on the shim. |
| [Conversation check](conversation-check.md) | raw | Fact-checker. Not yet written up — see chat notes. |
| [Speech-triggered notes](speech-triggered-notes.md) | parked | Different territory; still viable. |
| [Nod-to-confirm](nod-to-confirm.md) | parked | Different territory; would make the inbox hands-free later. |
| [Name rescue](name-rescue.md) | raw | Audio-based contact lookup against private sources. |
| [Hands-free recipe](hands-free-recipe.md) | raw | Voice-navigated recipe steps on the display. |

Statuses: `raw` → `explored` (feasibility checked) → `building` → `shipped` / `parked` / `dead`.
Keep `dead` ideas with the reason written down; it stops you rediscovering the same wall.

## Two constraints that kill most "systems" ideas

Both verified against the Even Hub docs, both worth knowing before you write anything up:

- **Nothing can page you.** No push notifications, no background execution while closed. Every
  idea here is glance-on-demand, launched from the glasses menu — never alert-driven.
- **No bare LAN IPs.** The `app.json` whitelist wants a full HTTPS origin, enforced before the
  request leaves the WebView. Reaching your own machine means a stable origin — Tailscale Serve.
  You already have one: `https://ais-mac-mini.tail7ed4e6.ts.net`.
- **Never put a credential in the glasses app.** It is a web page; anything in it is readable,
  and `.ehpk` files get uploaded. Backends get a shim holding the real token. See
  [openclaw-voice](openclaw-voice.md).
