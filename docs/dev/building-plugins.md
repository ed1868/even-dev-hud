# Building plugins

A plugin is one unit of app behaviour. An Even Hub app in this repo is a **page layout plus a
list of plugins** — that split is what makes the second and third app cheap.

Read [`../architecture.md`](../architecture.md) first if you haven't. The call-ordering rules
there are not style preferences; several bridge calls silently fail if you get them wrong.

## The contract

```ts
export interface EvenPlugin {
  readonly name: string;
  setup(ctx: EvenAppContext): void | Promise<void>;
  teardown?(): void | Promise<void>;
}
```

`setup` receives a context where **everything is already connected** — the bridge is ready, the
user and device are fetched, the event router is live. A plugin never handles bridge readiness.

```ts
interface EvenAppContext {
  bridge: EvenAppBridge;          // raw SDK, for anything not wrapped yet
  events: EvenEventRouter;        // typed channels: list, text, sys, audio, menu, imu, longPress, exit, raw
  launchSource: 'appMenu' | 'glassesMenu' | null;
  user: UserInfo;
  device: DeviceInfo | null;
  onDispose(fn: () => void): () => void;
  store<T>(namespace: string, defaults: T): Store<T>;
}
```

## The one rule: register teardown, don't remember it

Every subscription, timer, and hardware toggle goes through `ctx.onDispose` at the moment you
create it.

```ts
// ✅ teardown registered next to the thing it tears down
const id = setInterval(tick, 1000);
ctx.onDispose(() => clearInterval(id));

// ❌ a timer you intend to clean up "later"
this.timer = setInterval(tick, 1000);
```

This matters more here than in a normal web app. The glasses page gets rebuilt, the app gets
relaunched from the glasses menu, and the WebView is *not* reloaded in between. Leaked
listeners survive and you get each handler firing two or three times — which on a device with
no debugger attached presents as "the glasses are glitching", not as a bug in your code.

`app.dispose()` unwinds everything in reverse registration order, and `EvenApp` calls it
automatically on the host's exit events.

## Anatomy of a real plugin

A plugin that touches hardware is the interesting case, because it has state to undo. Compare
[`apps/hello-hud/src/plugins/head-tilt.ts`](../../apps/hello-hud/src/plugins/head-tilt.ts):

```ts
export function headTiltPlugin(screen: Screen, containerName: string): EvenPlugin {
  let timer: ReturnType<typeof setInterval> | undefined;
  let latest: { x: number; y: number; z: number } | null = null;
  let bridge: EvenAppBridge | null = null;

  return {
    name: 'head-tilt',
    async setup(ctx) {
      const enabled = await ctx.bridge.imuControl(true, ImuReportPace.P500);
      if (!enabled) return;            // fail soft — don't throw and kill sibling plugins
      bridge = ctx.bridge;             // only hold it once the IMU is actually on

      ctx.onDispose(ctx.events.on('imu', (d) => { latest = { x: d.x ?? 0, ... }; }));

      // Sensor rate and display rate are different problems. Buffer, then paint.
      timer = setInterval(() => { if (latest) void screen.setText(containerName, fmt(latest)); }, 500);
      ctx.onDispose(() => clearInterval(timer));
    },
    async teardown() {
      clearInterval(timer);
      if (bridge) { await bridge.imuControl(false); bridge = null; }
    },
  };
}
```

Four things worth copying:

1. **Factory function, not a class.** `headTiltPlugin(screen, 'tilt')` closes over its
   dependencies, so the plugin has no globals and you can mount two of them.
2. **Fail soft.** A plugin that throws in `setup` is logged and skipped; the rest of the app
   still runs. Don't throw for "the hardware said no".
3. **Decouple sensor rate from paint rate.** The IMU reports far faster than you should redraw.
   Buffer the latest sample, paint on a timer.
4. **`teardown` undoes hardware, `onDispose` undoes subscriptions.** Turning the IMU off is not
   a listener removal — it's a device state change, and it belongs in `teardown`.

## Where plugins live

| Stage | Location |
|---|---|
| Only this app needs it | `apps/<app>/src/plugins/` |
| A second app wants it | move to `packages/` — unchanged, it's just an export |

Don't pre-emptively promote. The second consumer is what tells you the interface is right.

## Talking to the display

Plugins should take a `Screen` and a container **name**, never a numeric container id. The
`PageBuilder` allocates ids, and hardcoding them breaks the moment the layout changes.

```ts
await screen.setText('status', 'Ready');           // cheap, in-place
await screen.setImage('thumb', grayscaleBytes);    // image containers need this after creation
await screen.rebuild(newPageBuilder);              // replaces the whole layout
```

Prefer `setText` over `rebuild`. A rebuild replaces every container and clears the custom menu
unless you re-declare it.

## Persisting state

```ts
const store = ctx.store('head-tilt', { enabled: true, threshold: 12 });
const { enabled } = await store.all();
await store.set('threshold', 15);
```

Keys are namespaced per plugin and JSON-encoded. The raw host API is string-only and returns
`''` — not `null` — for a missing key, which is exactly the shape that silently becomes
`undefined` in your logic.

## Checklist before you call one done

- [ ] Every subscription and timer registered via `ctx.onDispose`.
- [ ] Hardware toggled on in `setup` is toggled off in `teardown`.
- [ ] Container addressed by name, not id.
- [ ] Sensor streams throttled before they hit the display.
- [ ] `setup` returns rather than throws when a capability is unavailable.
- [ ] Mounted twice in one app without conflicting (no module-level mutable state).
- [ ] `npm run typecheck` clean.

## Testing

There is no local device emulator for the SDK path. `isEvenAppWebView()` is false in a desktop
browser, so the page loads and does nothing. The loop is:

```bash
npm run dev                        # vite on 0.0.0.0:5173
npm run qr -w @even/hello-hud      # scan from the Even app
```

Logs land in the phone-side panel (`apps/hello-hud/src/log.ts`) because you cannot read the
glasses. Log the *transitions* — capability enabled, event received, teardown ran — not every
sample.
