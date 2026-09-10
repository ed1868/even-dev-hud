# <Idea name>

**Status:** raw
**Shape:** plugin | app | needs raw BLE

## What it does

One or two sentences, from the wearer's point of view. If you cannot describe the moment
someone uses this without mentioning an API, the idea is not formed yet.

## Capabilities it needs

Tick against `docs/architecture.md` → Device capabilities.

- [ ] Glasses mic (`audioControl`)
- [ ] IMU / head motion (`imuControl`)
- [ ] Location (phone GPS)
- [ ] Camera / album (phone)
- [ ] Network (declare the domain in `app.json`)
- [ ] Persisted state (`Store`)

## Display sketch

576×288, top-left origin, max 12 containers, max 8 text.

```
┌────────────────────────────────────────┐
│                                        │
└────────────────────────────────────────┘
```

## Feasibility

The three that kill most ideas:

- Does it need the glasses to work without the phone? → **dead**, the phone is always in the loop.
- Does it need to see what the wearer sees? → **dead**, there is no glasses camera API.
- Does it need free-form drawing? → **hard**, you get containers, not a canvas. Image
  containers take raw grayscale bytes if you must.

Anything else that could block it:

## Smallest version worth building

The one thing that proves the idea works. Not the full product.

## Notes
