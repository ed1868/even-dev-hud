# Hands-Free Recipe

**Status:** raw
**Shape:** app (shim endpoint + voice navigation)

## What it does

You're cooking and your hands are covered in flour. You say the recipe name, the glasses show
the current step. Nod or say "next" to advance. The recipe stays on-screen until you dismiss
it — no unlocking your phone, no touching a screen.

```
Step 3 of 8
Fold egg whites into batter gently.
Do not overmix.
```

## Capabilities it needs

- [x] Glasses mic (`audioControl`) — voice commands: "next", "back", "repeat", recipe name
- [x] IMU / head motion — optional: nod to advance (see [nod-to-confirm](nod-to-confirm.md))
- [ ] Location
- [ ] Camera / album
- [x] Network — shim endpoint serving recipe steps
- [x] Persisted state — last recipe + current step, so closing/reopening resumes

## Display sketch

576×288, top-left origin. Four containers: header, step text (2 lines), footer.

```
┌──────────────────────────────────────────────────┐
│  Banana Bread · Step 3/8                          │  header (brightness 3)
│                                                   │
│  Fold egg whites into batter gently.              │  step line 1 (brightness 4)
│  Do not overmix.                                  │  step line 2 (brightness 2)
│                                                   │
│  "next" · "back" · "timer 10m"                    │  footer (brightness 1)
└──────────────────────────────────────────────────┘
```

Timer sub-screen (same layout, swapped in when active):

```
┌──────────────────────────────────────────────────┐
│  Banana Bread · Timer                             │  header
│                                                   │
│  07:23                                            │  countdown (brightness 4)
│  oven preheat                                     │  label (brightness 2)
│                                                   │
│  "stop" · "back to step"                          │  footer (brightness 1)
└──────────────────────────────────────────────────┘
```

## Feasibility

- **Does it need the glasses to work without the phone?** No.
- **Does it need to see what the wearer sees?** No.
- **Does it need free-form drawing?** No — text steps are ideal for the display.

The constraint is **voice command reliability in a kitchen**. Running water, the hood fan, a
sizzling pan — background noise is real. Short fixed commands ("next", "back") survive noise
better than open-ended speech. The recipe name at launch is the hard part: consider a list on the
phone to pick the recipe, then voice-only for step navigation.

No push notifications means the timer cannot alert you if the app is closed. The workaround:
the timer lives on the shim and the glasses poll it, so as long as the app is open on-screen the
countdown updates. If you close the app, the timer still fires on the shim and you see it when
you reopen. Not ideal, but acceptable for a personal cooking tool.

## Smallest version worth building

A single hardcoded recipe (JSON: title, steps array). Voice commands limited to "next" and
"back." No timer, no recipe search. Proves the voice-driven step navigation loop on the actual
display.

## Notes

Recipe storage: a `recipes/` folder of JSON files on the shim, each with `{ title, steps[] }`.
No database needed — glob the folder, serve an index. Adding a recipe = dropping a file.

A natural extension is to ask Claude to generate the recipe JSON from a URL or a photo of a
cookbook page (via the phone camera, not the glasses). That's a convenience feature, not part of
the core loop.

Pairs well with [nod-to-confirm](nod-to-confirm.md) for truly hands-free advancement.
