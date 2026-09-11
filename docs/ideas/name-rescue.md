# Name Rescue

**Status:** raw
**Shape:** app (glasses mic + shim endpoint)

## What it does

You're at a party and someone walks up — you've met before but the name is gone. Long-press to
start listening. The glasses pick up ten seconds of conversation, transcribe it, and search your
private sources (Slack DMs, calendar events, email senders, OpenClaw contact history) for a
matching name and context. If a match is found, the glasses show:

```
Alex Chen · eng standup · last Tue
```

If nothing matches, it says so instead of guessing.

## Capabilities it needs

- [x] Glasses mic (`audioControl`) — captures the other person's voice
- [ ] IMU / head motion
- [ ] Location
- [ ] Camera / album
- [x] Network — hud-shim origin for search endpoint
- [x] Persisted state — recent lookups, so repeated encounters surface faster

Plus, off-glasses: a shim endpoint that indexes contacts from Slack, calendar, and OpenClaw
channels, and a Whisper call for transcription.

## Display sketch

576×288, top-left origin. Five containers: header, name, context line, confidence, footer.

```
┌──────────────────────────────────────────────────┐
│  🎤  Listening…                                    │  header (brightness 2, swaps to result)
│                                                   │
│  Alex Chen                                        │  name (brightness 4)
│  eng standup · Slack #team-core · last Tue        │  context (brightness 2)
│                                                   │
│  2 matches · long-press to retry                  │  footer (brightness 1)
└──────────────────────────────────────────────────┘
```

## Feasibility

- **Does it need the glasses to work without the phone?** No — phone relays audio to the shim.
- **Does it need to see what the wearer sees?** No — it works on audio only.
- **Does it need free-form drawing?** No — text containers are enough.

The real blocker is **contact corpus quality**. If your Slack workspace has 2,000 people and the
audio clip is "hey, how's the project going?", there's nothing to match on. This only works when
the conversation contains identifying details: a project name, a team, a specific event. The
audio needs to carry signal, not just a greeting.

Speaker separation (`speakerRole`) helps: you only search for the *other* person's words, not
your own "oh hey, good to see you."

Whisper latency: \~2s for 10s of audio via local Whisper. Acceptable for a glance.

## Smallest version worth building

Long-press → capture 10s → transcribe → keyword search across Slack display names and calendar
attendees → show top match or "no match." No NLP, no embedding search, just `LIKE '%keyword%'`
on a contact table pre-populated from Slack's `users.list` and calendar attendee fields.

Proves whether the audio path + private search is worth refining.

## Notes

This shares the same audio pipeline as the [conversation check](conversation-check.md) — mic
capture, PCM buffering, Whisper STT. Building one builds half of the other.

The temptation is to match on face recognition via the phone camera. The G2 has no camera API,
and `captureImageFromCamera` is the phone camera — you'd have to hold your phone up, which
defeats the point. Audio-only is the constraint; lean into it.
