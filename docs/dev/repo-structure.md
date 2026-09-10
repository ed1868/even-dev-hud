# Repo structure

How this repo is laid out, why, and where new work goes. Read this before adding a folder.

## The layout

```
evenRealitiesWorkspace/
├── apps/           things that run ON the glasses (Even Hub apps)
│   ├── hello-hud/      reference app — two example plugins
│   └── dev-hud/        the real one (Phase E)
├── packages/       shared libraries, consumed by apps
│   ├── core/           @even/core — bridge, event router, plugin model, storage
│   └── ui/             @even/ui   — PageBuilder, Screen, display constraints
├── tools/          things that run on YOUR MACHINE, never on the glasses
│   ├── hud-shim/       the read-only aggregation service
│   ├── protocol-lab/   raw BLE sandbox (unsupported track)
│   └── cert-probe/     one-off device tests
├── infra/          containers and datastores (Postgres archive)
├── docs/
│   ├── architecture.md     how the Even platform works — read first
│   ├── ideas/              one file per idea, feasibility-checked
│   ├── plans/              full build plans for committed work
│   └── dev/                how to work in this repo
└── tsconfig.json   project references — every package listed here
```

## The one distinction that matters

**`apps/` runs in the Even app's WebView. `tools/` runs on your machine.**

They are different worlds with different rules, and conflating them is how credentials leak.

| | `apps/` | `tools/` |
|---|---|---|
| Runtime | WebView, inside the Even phone app | Node on your Mac |
| Can hold a secret | **Never** — it's a web page, and `.ehpk` files get uploaded | Yes; this is where they live |
| Network | Whitelisted origins only, CORS enforced | Anything |
| Debugger | None on device | Full |
| Dependencies | Bundled by Vite | Anything Node runs |

The rule that follows: **anything requiring a credential belongs in `tools/`**, and the app talks to it over an authenticated endpoint. That's the whole reason `hud-shim` exists.

## Naming

- Workspace packages are `@even/<name>` — `@even/core`, `@even/hud-shim`.
- Folder name matches the package name minus the scope.
- Directories are kebab-case. Files are kebab-case. TypeScript symbols are the usual `camelCase` / `PascalCase`.

## Packages export source, not builds

`packages/*` set `"main": "./src/index.ts"`. There is **no build step between packages** — Vite compiles them with the app, and `tsc -b` typechecks the whole graph at once.

This is deliberate. A build step between packages means a stale-`dist` class of bug where you edit a file, nothing changes, and you lose twenty minutes. The cost is that packages are consumable only by TypeScript-aware bundlers, which is fine because the only consumers are in this repo.

`tools/hud-shim` goes further and runs `.ts` directly — Node 24 strips types natively, so there's no build and no watcher.

## Dependencies are a decision, not a reflex

`hud-shim` holds every credential in the system: the GitHub token, the OpenClaw gateway token, the database password. Its runtime dependency count is **zero** — `node:http`, `node:sqlite`, `node:crypto`.

That's not minimalism for its own sake. Every dependency in that process is code with access to those secrets, and eight read-only GET routes do not justify a transitive tree to audit.

Apps may use dependencies freely; they hold nothing worth stealing.

## Adding things

**A new app**

1. `cp -r apps/hello-hud apps/<name>`
2. Update `name` in `package.json`; update `package_id` and `name` in `app.json`
3. Add `{ "path": "./apps/<name>" }` to the root `tsconfig.json` references
4. `npm install`

**A new package**

Same, but `"main": "./src/index.ts"` and no `app.json`. Only promote code here when a **second** consumer wants it — the second consumer is what tells you the interface is right. Designing the shared abstraction first reliably produces one that fits nobody.

**A new tool**

Anything with a credential, a database, or a long-running process. No `app.json`, no Vite unless it serves a page.

**A new data source for the HUD**

Do not add a service. Add a collector: `tools/hud-shim/src/collectors/<source>.ts`, export a `collect*()` that writes to SQLite and calls `markSource()`, then register it in `collectors/registry.ts`. It self-registers in the `jobs` table and gets failure detection for free.

## Document taxonomy

Four kinds, and mixing them is what makes docs rot:

| Folder | Contains | Lifecycle |
|---|---|---|
| `docs/architecture.md` | How the **Even platform** works. Verified facts about the SDK, not our design. | Update when the SDK version bumps |
| `docs/ideas/` | One file per idea, feasibility-checked against the platform. Includes dead ones, with the reason. | Append-only; status changes over time |
| `docs/plans/` | Full build plans for committed work. Server, HUD, test steps, deployment prerequisites. | Marked superseded, never silently rewritten |
| `docs/dev/` | How to work here. This file, plugin guide, tooling. | Living |

Keep dead ideas with the reason written down — it stops you rediscovering the same wall. Mark superseded plans rather than deleting them; the reasoning is often still correct even when the conclusion changed.

## Conventions worth knowing

- **Verify against the shipped package, not from memory.** Every platform claim in `docs/architecture.md` came from reading the published `.d.ts` or the official docs. The SDK's own README examples do not typecheck under `strict`, which is exactly the kind of thing you only find by looking.
- **Comment the *why*.** The code shows what it does. The comment should say why it isn't the obvious thing — e.g. why the cron collector reads files instead of calling the gateway.
- **Secrets come from the environment.** `.env` files are gitignored. Nothing secret is ever committed, packed, or sent to a glasses app.
- **Fail loudly at startup, degrade quietly at runtime.** Missing config throws on boot. A source that's down serves last-known data labelled stale.

## Commands

```bash
npm run typecheck                     # tsc -b across every package
npm run dev                           # hello-hud on 0.0.0.0:5173
npm run qr -w @even/<app>             # QR for the Even app (detects your route interface)
npm run collect -w @even/hud-shim     # one collector pass, prints what the HUD would show
npm start -w @even/hud-shim           # the shim
cd infra && docker compose up -d      # Postgres archive
```
