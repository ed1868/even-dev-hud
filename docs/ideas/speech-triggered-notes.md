# Speech-triggered notes

**Status:** explored
**Shape:** plugin

## What it does

You say "note that" while walking, and whatever you say next is captured and shows on the
glasses so you can see it landed. No phone in hand, no button.

## Capabilities it needs

- [x] Glasses mic (`audioControl(true, AudioInputSource.Glasses)`)
- [ ] IMU
- [ ] Location
- [ ] Camera / album
- [x] Network — transcription happens off-device; whitelist the endpoint in `app.json`
- [x] Persisted state (`Store`)

## Display sketch

```
┌────────────────────────────────────────┐
│ ● listening                            │  status  (text)
│                                        │
│ pick up the thing from the place       │  capture (text)
│                                        │
│ 3 notes today                          │  count   (text)
└────────────────────────────────────────┘
```

## Feasibility

Not blocked, but two real constraints:

- **The mic needs the startup page to exist first.** `audioControl` returns `false` if you
  call it before `createStartUpPageContainer`. Ordering, not permissions.
- **You get raw PCM, not text.** `audioEvent.audioPcm` is a `Uint8Array` of frames. There is no
  on-device speech recognition in the SDK, so the wake phrase and the transcription both have
  to happen somewhere else — which means a network round trip per utterance, and a decision
  about whether continuous audio leaves the device.

`speakerRole` is worth using: the Even app classifies frames as `Self` vs `Other`, so you can
ignore audio from people around you without solving speaker ID yourself. It is the app's
algorithm, not a firmware identity claim, so treat it as a strong hint rather than a guarantee.

Battery is the unknown. Continuous glasses mic + continuous streaming has not been measured
here.

## Smallest version worth building

Skip the wake phrase entirely. Bind capture to a **long press** (`longPress` channel, which
reports whether it came from `GLASSES_L`, `GLASSES_R`, or the `RING`): hold to record, release
to send one clip for transcription, show the result. That proves the mic → network → display
loop without solving always-on listening or battery.

## Notes

If the wake-phrase version is the goal, the open question is whether on-device keyword spotting
in the WebView (small model over the PCM stream) is fast enough, versus streaming everything
up. Measure the simple version first.
