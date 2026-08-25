---
name: audio-polish
description: Balance dialogue, music, and ambience with the current clip-gain and track controls; diagnose level jumps, design stepped ducks, and verify by listening.
tools: [get_timeline, adjust_audio, split_clip, set_track_flags, analyze_silence, render_preview, search_music, add_music]
---

# Audio polish

## Purpose

Make speech effortless to understand and the mix emotionally supportive, using only the level controls FramePilot actually exposes.

## When to use

Dialogue leveling, music balance, scratch-track muting, fades, ducking, final audio review, or sourcing a music bed when the project has none.

## When not to use

Do not use this for structural silence removal, unsupported multiband repair, or invented loudness measurements.

## Required inputs

Current timeline, the role of each audio source, speech spans, and the intended listening context.

## Expected outputs

Motivated gain changes, intentional track flags, and a preview-based assessment with a short WHY.

## Core philosophy

Dialogue is the reference. Music and ambience earn level only after every word remains clear.

## Professional heuristics

- Level-match adjacent takes before shaping music.
- Start music under speech around -18 dB and adjust from evidence; speech-free passages may rise.
- Because gain is constant per clip, build ducks and fades by splitting into a few stepped sections. Avoid dozens of micro-splits.
- Preserve ambience across cuts when it hides discontinuity. Mute alternates; do not delete them.

## Sourcing a bed the project does not have

When the edit wants music and the bin has none, `search_music` finds one and `add_music` places it. Both reach a third-party catalogue, so treat them as costly: one search, then commit.

- **Search by mood or instrument, not by title.** "calm piano", "driving synth", "warm acoustic". The catalogue is openly-licensed production music; asking for a named song returns nothing useful.
- **Read the duration before you pick.** A 40-second track under a 3-minute edit means a visible restart or a hard stop. Prefer one long enough to cover the section, and pick a shorter one only when you intend it to end.
- **Say what the credit obligation is.** Every result reports `attributionRequired`. When you place a track that needs one, tell the editor in your summary and name where it lives — the credit is saved with the project and appears under Export → Credits. Leaving that to be discovered at publish time is the failure this feature exists to prevent.
- **Duck it in the same breath.** `add_music` takes `duckUnderTrackId`; pass the dialogue track id. A bed laid at full level over narration is not a finished mix, and the whole point of the bed is that speech stays effortless.
- **Do not search for music the project already has.** Check `list_assets` first — an existing audio asset is free, and a downloaded one is already in the bin.
- **Nothing is monetization-unsafe.** Non-commercial tracks are refused before you ever see them, so a result is safe to use in a sponsored video. You do not need to caveat that.
- For beat-aligned cutting against a fetched track, hand its asset id to `detect_beats` and follow `beat-synced-editing`.

## Decision framework

Identify the dominant voice → match dialogue clips → set the bed → create only necessary ducks/fades → preview at normal and low volume.

## Common mistakes

Boosting everything, ducking every breath, abrupt one-frame level steps, deleting scratch sources, claiming clean audio without listening, adding a bed and leaving it unducked over speech, or placing a credit-required track without saying so.

## Verification checklist

- Words stay intelligible under music.
- No level jump distracts at a cut.
- Open and close do not blast.
- Muted/solo states are intentional.
- A rendered preview was listened to; otherwise report “applied, not auditioned.”
- A fetched bed is on a `music`-role track, ducked under dialogue, and its credit obligation was stated if it has one.

## Recovery advice

If a stepped duck sounds obvious, use fewer sections and a smaller delta. If source noise or clipping cannot be fixed with gain, preserve the least-damaged result and report the limitation.

## Related skills

`silence-and-filler-cutting`, `podcast-editing`, `finishing-and-delivery`, `beat-synced-editing`.
