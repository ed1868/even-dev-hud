# Even G2 / Even Hub — how the platform actually works

Verified against `@evenrealities/even_hub_sdk@0.0.15` and `@evenrealities/evenhub-cli@0.1.14`
(read from the published packages, not from memory). Re-check when those bump.

## The one thing that shapes everything

**An Even Hub app is a web page, not a native app.** It runs in a WebView *inside the Even
phone app*, and it talks to the glasses through a bridge the host injects at
`window.flutter_inappwebview.callHandler`. Your code never touches Bluetooth.

```
┌─────────────┐   BLE    ┌────────────────────────────┐
│  G2 glasses │◄────────►│  Even app (iOS/Android)    │
│  L + R      │          │  ┌──────────────────────┐  │
└─────────────┘          │  │ WebView              │  │
                         │  │  your page + SDK ────┼──┼──► bridge
                         │  └──────────────────────┘  │
                         └────────────────────────────┘
```

Consequences worth internalising early:

- **No bridge outside the Even app.** Loading the page in Chrome gives you a UI with a dead
  bridge. `@even/core`'s `isEvenAppWebView()` checks for the host so you get an error
  instead of a hang.
- **The phone is always in the loop.** Glasses-only operation is not a thing here.
- **Display is declarative and container-based.** You do not draw pixels. You declare up to
  12 containers (list / text / image) and then update their contents.
- **Network access is declared, not assumed.** `app.json` carries a `permissions` array with
  a per-domain `whitelist` for `network`.

## The two paths, and why the repo has both

| | Even Hub SDK (`packages/`, `apps/`) | Raw BLE (`tools/protocol-lab/`) |
|---|---|---|
| Transport | Host bridge in the WebView | GATT straight to each lens |
| Sanctioned | Yes — the only route to store submission | No; community reverse-engineering |
| Stability | Versioned, documented | Breaks with firmware |
| Reach | What the sandbox exposes | Whatever the hardware accepts |
| Phone app required | Yes | No |

Build on the SDK. Use the lab to learn what the sandbox is holding back, and to decide
whether a given idea is even possible before you invest in it.

## Page lifecycle

The ordering here is not stylistic — several calls simply fail if the page does not exist yet.

1. `waitForEvenAppBridge()` resolves once the host is ready. (`EvenApp.start()` wraps this
   with a timeout and a host check.)
2. `onLaunchSource` fires **exactly once**, shortly after load, with `appMenu` or
   `glassesMenu`. Subscribe before any `await` or you will miss it.
3. `createStartUpPageContainer(...)` builds the glasses page. **Nothing glasses-side works
   before this** — including the glasses microphone.
4. Update in place with `textContainerUpgrade` / `updateImageRawData`; replace the whole
   layout with `rebuildPageContainer`.
5. `shutDownPageContainer(exitMode)` tears it down. `0` closes; `1` lets the foreground
   layer decide.

Exit can also be pushed at you as a `sysEvent`: `FOREGROUND_EXIT_EVENT`,
`ABNORMAL_EXIT_EVENT`, `SYSTEM_EXIT_EVENT`. `EvenApp` disposes itself on these by default.

## Display container rules

All enforced in `@even/ui`'s `PageBuilder`, which fails with a message naming the container
rather than letting the SDK return a bare `false` after the round trip.

- `containerTotalNum` is 1–12, counting list + text + image together.
- At most 8 text containers.
- **Exactly one** container sets `isEventCapture: 1`. With none, the page gets no input at all.
- `zOrderIndex` is all-or-nothing per page: if any container sets it, every container must,
  and values must be unique. Higher renders in front.
- `textColor` is a **brightness level 0–4**, not a colour. Omit it to get the default (4).
- Image containers render nothing until `updateImageRawData` sends bytes for them.
- Contextual menu: max 10 items, non-zero unique `itemID`, names capped at 32 **UTF-8 bytes**.
  Rebuilding without `menuObject` clears the custom menu.
- Coordinate origin is top-left. The display is **576×288** (`CANVAS`) — stated in Even
  Realities' own `@evenrealities/even-terminal` README, not in the SDK. The SDK does not
  promise container coordinates map 1:1 onto display pixels, so verify before laying out to
  the edges.

## Events

Everything arrives on one `onEvenHubEvent` firehose, with the interesting parts nested:

```
EvenHubEvent
├── listEvent    selection + index changes on a list container
├── textEvent    events on a text container
├── sysEvent     click / scroll / double-click / foreground / exit
│   ├── eventType = IMU_DATA_REPORT         → imuData {x,y,z}
│   └── eventType = LONG_PRESS_EVENT (9) / LONG_PRESS_RELEASE_EVENT (10)
│                                            → eventSource: GLASSES_L | GLASSES_R | RING
├── audioEvent   PCM frames, source, direction, speakerRole
└── menuItemClickEvent
```

`@even/core`'s `EvenEventRouter` flattens this into named channels (`list`, `text`, `sys`,
`audio`, `menu`, `imu`, `longPress`, `exit`, `raw`) so features subscribe to what they mean.

## Device capabilities

| Capability | Call | Notes |
|---|---|---|
| Glasses / phone mic | `audioControl(true, AudioInputSource.Glasses)` | Needs the startup page first. PCM arrives via `audioEvent`. |
| IMU | `imuControl(true, ImuReportPace.P500)` | Pacing codes `P100`–`P1000`. Samples via `sysEvent`. |
| Location | `getAppLocation()` / `startAppLocationUpdates()` | Phone GPS, not glasses. Needs the `location` permission. |
| Camera / album | `captureImageFromCamera()` / `pickImageFromAlbum()` | Phone camera. Returns base64. Album is single-select. |
| Storage | `get/setLocalStorage(key, value)` | Strings only; a missing key returns `''`, not null. `@even/core`'s `Store` adds JSON + typing. |
| User / device | `getUserInfo()` / `getDeviceInfo()` | |

There is no glasses camera API and no direct glasses filesystem. `speakerRole` on audio is the
Even app's own algorithm output, not a firmware identity claim.

## Background and networking — two hard limits

Verified against the Even Hub docs; both rule out whole categories of idea, so check them
before designing anything.

**No push, no background execution while closed.** On iOS the WebView "keeps running, in-memory
JS state survives" when backgrounded. On Android it "may be suspended under memory pressure" —
JS state lost, WebSockets dropped, audio/location streams stopped. Only `localStorage` and disk
state survive. The docs say to treat Android suspend as *"the app starts cold."*

Consequence: **nothing can page you.** Apps are glance-on-demand. The affordance that makes
that workable is launching from the glasses menu (`launchSource === 'glassesMenu'`), so
"I wonder" → "I know" never involves the phone. Persist to `localStorage` so a cold start
repaints instead of spinning.

**The network whitelist is strict and is not a CORS bypass.** `app.json` takes full origins
(`https://api.example.com`); "bare hostnames and wildcards aren't supported." The Even app
"enforces it before the request ever leaves the WebView — anything not in the whitelist is
blocked, no traffic generated at all." Plain `http://` is dev-only. Adding a domain does **not**
override CORS; for third-party APIs you cannot re-header, proxy through a server you control.

Consequence: you cannot reach a bare LAN IP from a packed app, and your laptop's IP changes
anyway. A stable HTTPS origin via Tailscale Serve (`https://<machine>.<tailnet>.ts.net`) is the
clean answer — see [`ideas/hud-bridge.md`](ideas/hud-bridge.md).

## Ship path

```
vite build  →  evenhub pack app.json ./dist  →  .ehpk  →  upload on the Even Hub site
```

An `.ehpk` cannot be run locally. To test one on hardware you upload it and open it from the
Even app. For day-to-day iteration you skip packing entirely: `evenhub qr` points the Even
app at your dev server over the LAN.

`pack` stamps `min_app_version` from the SDK's npm metadata, raising (never lowering) whatever
`app.json` declares. `--sdk-ver <version>` pins it if you built against an older SDK.

## Raw BLE, in one paragraph

Each temple is its **own** BLE peripheral, advertised as `Even G2_XX_L_YYYYYY` /
`Even G2_XX_R_YYYYYY`, so a full session means two connections. Service base UUID is
`00002760-08c2-11e1-9073-0e8ac72eXXXX`: `5401` write-without-response for commands, `5402`
notify for responses, `6402` write for 204-byte display packets. Frames are
`AA 21 <seq> <len> 01 01 <svc_hi> <svc_lo> <payload…> <crc_lo> <crc_hi>` with CRC-16/CCITT
(init `0xFFFF`, poly `0x1021`) over the payload only, little-endian. Source:
[i-soxi/even-g2-protocol](https://github.com/i-soxi/even-g2-protocol) — community
reverse-engineering, unverified against a device here.
