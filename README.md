# evenRealities workspace

Monorepo for Even Realities G2 work. One shared core, many small apps.

```
├── docs/
│   ├── architecture.md              how the platform works (read this first)
│   ├── even-realities-resources.md  links: official docs, community repos
│   ├── dev/
│   │   ├── repo-structure.md        folder architecture + conventions (read before adding folders)
│   │   ├── building-plugins.md      how to write a plugin
│   │   ├── setup-even-terminal.md   RUNBOOK: Claude sessions on the glasses
│   │   ├── testing-on-hardware.md   RUNBOOK: get a plugin onto the glasses
│   │   ├── testing-the-hud.md       see HUD data without glasses
│   │   └── even-terminal.md         why the two tracks exist
│   ├── ideas/                       one file per idea, feasibility-checked
│   └── plans/                       full build plans for committed work
├── packages/
│   ├── core/   @even/core   bridge lifecycle, typed event router, plugin model, storage
│   └── ui/     @even/ui     PageBuilder + Screen — glasses display primitives
├── apps/
│   ├── dev-hud/    @even/dev-hud    jobs + GitHub + OpenClaw on the glasses
│   └── hello-hud/  @even/hello-hud  reference app, two example plugins
└── tools/
    └── protocol-lab/  @even/protocol-lab  raw BLE sandbox (Web Bluetooth, unsupported)
```

npm workspaces. Packages export TypeScript source directly (`"main": "./src/index.ts"`), so
there is no build step between them — Vite compiles them with the app, and `tsc -b` typechecks
everything at once.

## Setup

```bash
nvm use          # Node 24; the SDK needs ^20 || >=22
npm install
npm run typecheck
```

## Day-to-day loop

The Even app loads your page over the LAN, so you never pack during development.

```bash
npm run dev                        # vite on 0.0.0.0:5173
npm run qr -w @even/hello-hud      # QR pointing at your LAN IP — scan from the Even app
```

`npm run qr` reads your IP from `en0` (Wi-Fi). On Ethernet or a second interface, run
`npx evenhub qr` and enter it when prompted.

## Ship

```bash
npm run pack -w @even/hello-hud    # build + evenhub pack → hello-hud.ehpk at the repo root
```

`.ehpk` files cannot be run locally — upload on the Even Hub site, then open from the Even app.
Change `package_id` in `apps/hello-hud/app.json` from `com.example.*` before you do; it is the
identity the store keys on. `npx evenhub pack app.json ./dist --check` tests availability.

## Adding an app

1. `cp -r apps/hello-hud apps/<name>` and update `name` in `package.json`, plus
   `package_id` / `name` in `app.json`.
2. `npm install` to link the workspace.
3. Add `{ "path": "./apps/<name>" }` to the root `tsconfig.json` references.

Shared behaviour belongs in `packages/`, not copied between apps.

## The plugin model

An app is a page layout plus a list of plugins. This is what makes the second and third app
cheap — a feature that works moves into `packages/` unchanged.

```ts
import { EvenApp, type EvenPlugin } from '@even/core';
import { PageBuilder, Screen } from '@even/ui';

function clockPlugin(screen: Screen, container: string): EvenPlugin {
  return {
    name: 'clock',
    setup(ctx) {
      const id = setInterval(
        () => void screen.setText(container, new Date().toLocaleTimeString()),
        1000,
      );
      ctx.onDispose(() => clearInterval(id));   // teardown is registered, not remembered
    },
  };
}

const app = await EvenApp.start();
const screen = await Screen.mount(
  app.bridge,
  new PageBuilder().text({ name: 'time', x: 20, y: 20, width: 380, height: 40, focus: true }),
);
await app.use(clockPlugin(screen, 'time'));
```

`ctx.onDispose` is the whole discipline: every subscription and timer registers its teardown,
and `app.dispose()` unwinds them in reverse. Without it, listeners survive page rebuilds and
you get duplicate handlers that are miserable to debug on a device.

`apps/hello-hud/src/plugins/` has two worked examples — `battery` (device status → text) and
`head-tilt` (IMU stream, throttled). Full guide: [`docs/dev/building-plugins.md`](docs/dev/building-plugins.md).

## Protocol lab

```bash
npm run lab      # http://127.0.0.1:5174 — Chrome only
```

Talks BLE GATT straight to each lens, bypassing the Even app entirely. Localhost-only because
Web Bluetooth needs a secure context. The UUIDs and framing are community reverse-engineering
from [i-soxi/even-g2-protocol](https://github.com/i-soxi/even-g2-protocol), **not verified
against hardware here** — expect firmware drift. Nothing built on it is submittable.

Each temple is a separate peripheral, so connect twice (left and right).

## Version pins

| | |
|---|---|
| `@evenrealities/even_hub_sdk` | 0.0.15 — requires Even app ≥ 2.2.10 |
| `@evenrealities/evenhub-cli` | 0.1.14 |
| Node | ^20 \|\| >=22 |
| G2 display canvas | 576×288, top-left origin |

The SDK types its payloads as classes with a `toJson()` method, so the plain object literals
shown in its README do not satisfy strict TypeScript. `@even/ui` constructs the real classes
(`new TextContainerProperty({...})`); do the same in any code that calls the bridge directly.
