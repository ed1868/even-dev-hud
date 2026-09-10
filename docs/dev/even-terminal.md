# Even Terminal — the other way to use the glasses

`@evenrealities/even-terminal` (v0.8.1) is **not** part of the Even Hub SDK path this repo is
built on. It is a separate first-party tool that mirrors a CLI coding agent running on your
laptop onto the G2. Nothing you build with it is an app, and nothing here is submittable.

Both tracks are worth having. They answer different questions.

| | Even Hub SDK (this repo) | Even Terminal |
|---|---|---|
| What runs | Your web page, in the Even app's WebView | Claude Code / Codex, on your laptop |
| Glasses role | Your app's UI | A remote display for a terminal |
| Input | Touch, list scroll, contextual menu, long press | **R1 ring gestures** → keyboard events |
| Transport | Phone ↔ glasses over BLE | Laptop → Wi-Fi → phone → BLE → glasses |
| Ship path | `.ehpk` → Even Hub site | None; it's a dev tool |
| Needs the ring | No | Yes, for input |

## How it actually works

`even-terminal` runs an HTTP + WebSocket server on your laptop (`:3456` by default), spawns
`claude` or `codex` as a child process, captures the streaming output, renders it onto the G2's
576×288 canvas, and translates R1 ring gestures back into keystrokes for the agent.

```
[ claude / codex ] ── even-terminal :3456 ──┐
                                            │  Wi-Fi / Tailscale / tunnel
                                     ┌──────┴──────┐
                                     │  Even app   │
                                     └──┬───────┬──┘
                                  display│       │input
                                     BLE ↓       ↑ BLE
                                    ┌────┴──┐ ┌──┴────┐
                                    │  G2   │ │  R1   │
                                    └───────┘ └───────┘
```

The agent is **your** binary with **your** login. `even-terminal` is a renderer and input
bridge, not a runtime — it does not run anything in the cloud.

## Setup — over Tailscale

Installed: `@evenrealities/even-terminal@0.8.1`.

Use `--tailscale` rather than the default LAN binding. Your phone is already on the tailnet
(`iphone181`), so this works from anywhere — cellular, a café, another network — and it does not
depend on the Mini and the phone sharing a Wi-Fi.

```bash
# From the directory you want the agent working in:
even-terminal --tailscale \
  --cwd ~/orca/workspaces/evenRealities/evenRealitiesWorkspace \
  --token "$(openssl rand -hex 16)" \
  --name mac-mini
```

It prints a URL, a token, and a QR code in the terminal.

Then on the phone: **Even app → Terminal Mode → Scan QR**. Note this is *Terminal Mode*, a
different tab from the Even Hub developer section where `evenhub qr` codes get scanned. Two
separate tracks; easy to confuse.

Pin `--token` to a fixed value once it works, or it rotates every restart and you re-scan each time.

**Prerequisites**, all of which you have except possibly the ring:

- Node 18+ ✅
- `claude` installed and logged in ✅
- Tailscale on the Mini and the phone ✅
- **R1 ring** — required for *input*. Without it the glasses are a read-only mirror: you can watch
  the session but not type into it. Ring gestures are what become keystrokes.

Options worth knowing on day one:

| Flag | Why |
|---|---|
| `--cwd <path>` | Which project the agent works in. Set it; the default is wherever you ran the command. |
| `--token <str>` | Without it the token rotates every restart and you re-scan every time. |
| `--provider codex` | Switch the default agent. The server can drive both concurrently. |
| `--name <str>` | Labels the machine, for when you have more than one. |
| `--tailscale` | Bind to your tailnet instead of the LAN — stable across networks, no public tunnel. **Use this.** |
| `--expose pinggy\|bore\|ngrok` | Temporary public tunnel. See the warning below. |
| `--verbose --log-file ./debug.log` | First thing to reach for when something misbehaves. |

## On "Setup remote access"

That button in the app's setup guide is about reaching your laptop from outside your Wi-Fi.
The options are not equivalent:

- **Tailscale** — a private WireGuard network between your own devices. Nothing is public.
  This is the one to use.
- **`--expose pinggy` / `bore` / `ngrok`** — open a **public URL that fronts a coding agent
  with write access to your filesystem**, protected only by the token. Even Realities' own
  README calls these "temporary sharing, not long-term use". Treat them as a last resort, and
  always pair one with `--token <something long and random>`, never the rotating default.

## Where it fits alongside this repo

Useful for editing this repo hands-free — reviewing a diff on a walk, kicking off a build. It
tells you nothing about how your Even Hub app will look or behave, because it does not use the
SDK, the container model, or the app lifecycle.

Keep the loops separate:

```bash
even-terminal --cwd <repo>          # drive the agent from the glasses
npm run dev && npm run qr -w @even/hello-hud   # test the app on the glasses
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Server unreachable" | Phone and laptop on different transports. Both on the same Wi-Fi, or both on Tailscale. |
| `EADDRINUSE :3456` | `lsof -i :3456`, kill the old one, or `--port <other>`. |
| `command not found: claude` | Agent binary not on `$PATH`. `which claude`. |
| Token changes every restart | Pass `--token`. |
| `--expose pinggy` hangs | Try `bore`, `ngrok`, or Tailscale. |

Shell completion, matching the setup in `~/.zfunc`:

```bash
even-terminal complete zsh > ~/.zfunc/_even-terminal
```
