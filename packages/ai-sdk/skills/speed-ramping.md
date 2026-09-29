---
name: speed-ramping
description: Design credible speed ramps, constant retimes, freeze frames and reverse playback around action peaks, source frame-rate limits, speech intelligibility, and the timeline room a retime needs.
tools: [get_clip, get_project_state, set_clip_speed_ramp, set_clip_speed, split_clip, punch_in]
---

# Speed ramping

**Speeds the request names are the target** ("200% → 60% as the title lands", "75% on the
aerials", "freeze 12 frames"). Build them — 200% is rate 2, 60% is 0.6 — put the slow part on
the moment the request points at, and flag rather than refuse a rate the source will stutter
at. The judgment below is for retimes nobody specified.

## Purpose

Compress process or emphasize a peak without breaking motion, speech, or track layout.

## When to use

Slow-motion accents, process compression, timelapse sections, or an explicit ramp request.

## When not to use

Do not retime to force every beat, rescue weak footage, or promise smooth slow motion without frame-rate evidence (or optical-flow smoothing, which this renderer does not do).

## Required inputs

Action apex, source frame rate when known, speech status, current clip bounds, and free track space.

## Expected outputs

A ramp on the clip that carries the moment, or split sections with constant per-clip speeds, and an intact surrounding layout.

## Core philosophy

Slow significance; speed process. Retiming must reveal the action, not announce the effect.

## Professional heuristics

- A ramp within one clip is `set_clip_speed_ramp`: rate points in the clip's own source seconds (fast in, slow on the moment, back up). By default it keeps the clip's timeline length, so the cut around it does not move. Reach for `split_clip` + `set_clip_speed` only when whole sections must run at different constant rates and may change length.
- A freeze frame is `set_clip_speed { playback: "freeze" }`: the clip holds its FIRST frame,
  silent, for the length it already has. To hold a moment, `split_clip` at the moment and again
  where the hold should end, then freeze the middle piece. `playback: "reverse"` plays a clip
  backwards.
- Retimes sample source frames; there is no optical flow or frame blending. Slower than the
  source's frame-rate headroom repeats frames: 60 fps holds 0.5× cleanly, while 24–30 fps
  visibly steps below roughly 0.7–0.8×. Check the asset's frame rate before promising smooth
  slow motion.
- Keep ordinary dialogue near 0.9–1.3×.
- Bracket the apex, usually 0.5–1.5s, rather than slowing an entire clip.

## Decision framework

Locate apex → check physics/speech → ramp the clip (or split and set constant speeds) → confirm no gap/overlap → review motion.

## Common mistakes

Ignoring frame rate, slowing the approach instead of payoff, leaving gaps, or using many ramps.

## Verification checklist

- Action completes.
- Speech remains natural.
- No overlap/gap was introduced unintentionally.
- The effect is scarce and motivated.

## Recovery advice

Move speed toward 1× first (`ramp: null` clears a ramp); if the peak still fails, restore normal speed and improve shot timing.

## Related skills

`beat-synced-editing`, `keyframe-animation`, `short-form-pacing`, `travel-montage`.
