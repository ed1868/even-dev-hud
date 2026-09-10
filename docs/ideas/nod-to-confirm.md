# Nod to confirm

**Status:** explored
**Shape:** plugin

## What it does

Any yes/no prompt on the glasses can be answered by nodding or shaking your head. Reusable
across every app — a confirmation primitive, not a feature.

## Capabilities it needs

- [ ] Glasses mic
- [x] IMU / head motion (`imuControl`)
- [ ] Location
- [ ] Camera / album
- [ ] Network
- [x] Persisted state — per-user gesture threshold

## Display sketch

```
┌────────────────────────────────────────┐
│ Delete this note?                      │  prompt (text)
│                                        │
│ nod = yes    shake = no                │  hint   (text)
└────────────────────────────────────────┘
```

## Feasibility

Nothing blocks it. The work is signal processing, not platform:

- `ImuReportPace` goes from `P100` to `P1000`. Gesture detection wants the fast end; a nod is
  roughly a 300–600ms event and you cannot distinguish it from noise at 1 Hz.
- The SDK gives `{x, y, z}` per sample with no documented units or axis convention. Step one is
  logging real samples during a deliberate nod and a deliberate shake and looking at them —
  do not write the classifier first.
- **Head motion while walking will false-positive.** A usable version needs a magnitude
  threshold plus a rejection window, and probably only arms itself while a prompt is on screen.

The IMU stays on while armed, which is a battery cost. Enable it per-prompt, not for the app's
lifetime — this is exactly what `teardown` is for.

## Smallest version worth building

A `tools/` page that streams IMU at `P100` and plots x/y/z while you nod, shake, walk, and look
around. Ship nothing until you have looked at that data. The classifier is twenty lines once
you know what the axes do.

## Notes

If it works, this belongs in `packages/ui` as a `confirm(screen, prompt)` helper returning
`Promise<boolean>`, with a menu-item fallback for when the IMU is unavailable.
