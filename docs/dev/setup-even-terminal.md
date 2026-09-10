# Runbook — Claude sessions on the glasses (Even Terminal)

Exactly what we did, in order. Follow this from scratch on any machine.

This is the **Even Terminal** track — your laptop's coding agent mirrored onto the G2. It is
*not* the Even Hub SDK track. Different tab in the app, different tool, different purpose. See
[`even-terminal.md`](even-terminal.md) for why both exist.

**What you end up with:** Claude Code running on the Mac Mini, its output on the glasses, R1 ring
gestures as keystrokes, working from any network via Tailscale.

---

## Prerequisites

| | Check |
|---|---|
| Node 18+ | `node --version` |
| Claude Code installed and logged in | `which claude` |
| G2 paired in the Even app | glasses connect |
| **R1 ring** paired | required for *input* — without it the glasses are read-only |
| Tailscale on the Mac | `tailscale status` lists this machine |
| Tailscale on the **phone** | the phone appears in `tailscale status` |

The phone is the one people miss. It is not optional, and its absence produces a misleading error
— see Troubleshooting.

---

## One-time setup

### 1. Install Even Terminal

```bash
npm install -g @evenrealities/even-terminal
even-terminal --version        # 0.8.1 or later
```

### 2. Put the phone on the tailnet

Install **Tailscale** from the App Store, sign in with **the same account** as the Mac, approve
the VPN profile, toggle it on.

Verify from the Mac — the phone must appear:

```bash
tailscale status
# 100.64.174.34   ais-mac-mini        macOS
# 100.102.249.57  iphone181           iOS    active; direct
```

`direct` rather than `relay` means a peer-to-peer connection: lower latency.

### 3. Sanity check from the phone

Open `https://ais-mac-mini.tail7ed4e6.ts.net` in Safari. You should get a page, not an error.
If this fails, stop and fix it here — everything downstream depends on it.

---

## Every session

### 1. Start the server, and leave the terminal open

Generate a token once and keep it in your shell profile or a password manager —
**never in a file in this repo**:

```bash
# one time
export EVEN_TERMINAL_TOKEN=$(openssl rand -hex 16)

# every session
even-terminal --tailscale \
  --cwd ~/orca/workspaces/evenRealities/evenRealitiesWorkspace \
  --token "$EVEN_TERMINAL_TOKEN" \
  --name mac-mini
```

- `--tailscale` binds to the tailnet instead of the LAN, so it works on cellular and from
  anywhere. Without it you are limited to shared Wi-Fi.
- `--token` **pinned to a fixed value**. Omit it and a new token is generated on every restart,
  which invalidates the saved host on your phone and forces a re-scan every time. Keep the value
  out of this repo — anyone who can read it and reach your tailnet can drive the agent.
- `--cwd` is the directory the agent works in.

### 2. Read the output before touching the phone

```
Tailscale : http://100.64.174.34:3456
Token     : <your token>
```

If you see `EADDRINUSE` instead, an old instance owns the port. Fix it before continuing
(Troubleshooting, below) — this is the single most common failure.

### 3. Connect from the phone

Even app → **Terminal Mode** → **Add host** → scan the QR in your terminal.

Or enter it by hand:

| Field | Value |
|---|---|
| Host name | anything |
| Agent setup | Claude Code |
| Host | `http://100.64.174.34:3456` |
| Auth Token | the value of `$EVEN_TERMINAL_TOKEN` |

Tap **Probe and Save**.

---

## Troubleshooting

### "Probe and Save" fails

**Check for a stale process first.** This is what bit us, and it cost an hour.

```bash
ps -eo pid,lstart,command | grep even-terminal | grep -v grep
```

Two processes, or one started days ago, means the old one owns port 3456. Your new instance
printed a fresh QR and token but never bound. The phone then sends the new token to a server
holding the old one — a guaranteed 401 that looks like a connectivity problem.

```bash
pkill -f even-terminal
lsof -i :3456          # must be empty
```

Then start again, **delete the saved host on the phone**, and re-add it. A saved host holds a
dead token; it will keep failing until you remove it.

Confirm the server answers before touching the phone:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://100.64.174.34:3456/api/info
# 401 = alive but wrong token · 000 = not running
```

### "Server can't be found" in Safari

DNS, not TLS. **The phone is not on the tailnet.** A rejected certificate says *"This Connection
Is Not Private"* instead — different failure, different fix.

Check the Tailscale app is connected and that the phone shows in `tailscale status` on the Mac.

### Glasses show output but typing does nothing

You need the **R1 ring**. Ring gestures are what become keystrokes; the glasses alone are a
read-only mirror.

### The host dies when you close the terminal

Expected — it is a foreground process. Keep the window open, or run it under a process manager.

---

## Quick reference

```bash
even-terminal --tailscale --cwd <dir> --token <fixed> --name <label>

--provider codex             # switch the default agent
--port 8080                  # if 3456 is taken
--verbose --log-file ./x.log # first thing to reach for when debugging
```

`./scripts/devhud status` from the repo root shows every service and its start time — including
even-terminal — which is the fastest way to spot a stale process.
