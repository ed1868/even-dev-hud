# Agent Inbox

**Status:** explored
**Shape:** app + Claude Code hook + [hud-bridge](hud-bridge.md)

The flagship for the "control your own systems" territory.

## What it does

You run several Claude Code sessions in parallel across worktrees. You walk away. One of them
hits a permission prompt and just… sits there, burning the twenty minutes you were away.

Glance at your glasses: **which agents are working, which are blocked, which are done.** If one
is blocked, approve or deny it from the glasses and it keeps going.

The value is not the display. It's that the blocked agent unblocks in five seconds instead of
twenty minutes.

## Capabilities it needs

- [ ] Glasses mic
- [ ] IMU / head motion
- [ ] Location
- [ ] Camera / album
- [x] Network — your `hud-bridge` origin, whitelisted in `app.json`
- [x] Persisted state — last-known status, so an Android cold start paints instantly

Plus, off-glasses: a `PreToolUse` hook in Claude Code and the bridge server.

## Display sketch

576×288, top-left origin. Under the 12-container / 8-text limits with room to spare.

```
┌──────────────────────────────────────────────────┐
│  ⏸ evenRealities   Bash: npm publish              │  blocked  (text, brightness 4)
│                                                   │
│  ▸ orca-api        editing routes/auth.ts         │  working  (text, brightness 2)
│  ▸ dashboards      running tests                  │  working  (text, brightness 2)
│  ✓ scratch         done · 3m ago                  │  done     (text, brightness 1)
│                                                   │
│  [ Approve ]  [ Deny ]  [ Refresh ]               │  contextual menu
└──────────────────────────────────────────────────┘
```

Brightness (`textColor`, 0–4) is the only visual channel you get — no colour. Use it as urgency:
blocked at 4, working at 2, done at 1. That makes "is anything blocked?" answerable from
peripheral vision, before you've read a word.

## Feasibility

**Verified buildable.** The mechanism that makes it work is the one I expected to be the
blocker, and it holds up.

A Claude Code `PreToolUse` hook can **block the tool call while it decides** and return a
decision that overrides the permission prompt:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "approved from glasses"
} }
```

So the hook POSTs the pending call to `hud-bridge`, long-polls for a decision, and returns it.
Command hooks default to a **600-second timeout**, which is a generous window to notice and act.

The failure mode is the right one. Per the docs: *"A timed-out command hook doesn't block the
tool call. The call continues through the normal permission flow, so don't count on a stalled
hook to act as a gate."* If your glasses are off, the bridge is down, or you're asleep, the
agent falls back to asking you on the laptop exactly as it does today. **Nothing gets
auto-approved and nothing gets permanently wedged.** That's what makes this safe to leave
running.

Real constraints:

- **You can't be paged** (see [hud-bridge](hud-bridge.md)). This is glance-driven — you look
  when you surface from something, not when the block happens. It shortens a twenty-minute
  stall to a two-minute one, not to zero.
- **Approving blind is a genuinely bad idea.** A 576×288 display cannot show you a full diff or
  a long shell command. See below.
- Session→worktree naming has to come from somewhere legible. Worth checking what the hook's
  payload actually carries versus what you'd have to infer from `cwd`.

## The safety question, which is the actual design problem

Approving a tool call you can only half-read is worse than walking back to your desk. The
resolution is that **not every prompt should be approvable from the glasses.**

Classify on the bridge, not on the glasses:

| Class | Example | On glasses |
|---|---|---|
| Safe & short | `npm test`, read a file | Approve / Deny |
| Reviewable | edit to a file you can name | Approve / Deny, showing path + line count |
| Never | `git push`, `rm -rf`, anything touching prod, anything over N chars | **Show "needs laptop" and offer Deny only** |

Deny is always safe to offer; approve is the one that needs a gate. Start with an allowlist of
patterns that are approvable and default everything else to laptop-only. Loosen it as you learn
what you actually hit.

## Smallest version worth building

Cut the actions entirely. **Read-only status board**: N agents, each `working` / `blocked` /
`done`, launched from the glasses menu.

That alone solves most of the pain — knowing *that* something is blocked is 80% of the value,
and walking back to a specific blocked session beats discovering it by accident. It also proves
the whole chain (hook → bridge → Tailscale → whitelist → glasses) with no approve/deny risk
surface at all.

Add Deny next (always safe). Add Approve last, behind the allowlist.

## Notes

Overlaps with `even-terminal`, which already puts a coding agent on the glasses — but the shape
is different and complementary. `even-terminal` mirrors **one** terminal in full detail and
needs the R1 ring to drive it. This is a **glanceable index across all** your sessions, needing
only the contextual menu. Use even-terminal when you want to actually work; use this when you
want to know whether you need to.

If it works, the bridge's card format generalises and [ship-status](ship-status.md) becomes a
second source rather than a second app.
