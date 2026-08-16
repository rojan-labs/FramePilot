---
name: audio-polish
description: Balance dialogue, music, and ambience with the current clip-gain and track controls; diagnose level jumps, design stepped ducks, and verify by listening.
tools: [get_timeline, adjust_audio, split_clip, set_track_flags, analyze_silence, render_preview]
---

# Audio polish

## Purpose

Make speech effortless to understand and the mix emotionally supportive, using only the level controls FramePilot actually exposes.

## When to use

Dialogue leveling, music balance, scratch-track muting, fades, ducking, or final audio review.

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

## Decision framework

Identify the dominant voice → match dialogue clips → set the bed → create only necessary ducks/fades → preview at normal and low volume.

## Common mistakes

Boosting everything, ducking every breath, abrupt one-frame level steps, deleting scratch sources, or claiming clean audio without listening.

## Verification checklist

- Words stay intelligible under music.
- No level jump distracts at a cut.
- Open and close do not blast.
- Muted/solo states are intentional.
- A rendered preview was listened to; otherwise report “applied, not auditioned.”

## Recovery advice

If a stepped duck sounds obvious, use fewer sections and a smaller delta. If source noise or clipping cannot be fixed with gain, preserve the least-damaged result and report the limitation.

## Related skills

`silence-and-filler-cutting`, `podcast-editing`, `finishing-and-delivery`.
