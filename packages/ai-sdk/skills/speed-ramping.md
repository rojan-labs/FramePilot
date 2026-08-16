---
name: speed-ramping
description: Design credible split-based speed changes around action peaks, source frame-rate limits, speech intelligibility, and resulting timeline gaps.
tools: [get_clip, get_project_state, split_clip, set_clip_speed, punch_in]
---

# Speed ramping

## Purpose

Compress process or emphasize a peak without breaking motion, speech, or track layout.

## When to use

Slow-motion accents, process compression, timelapse sections, or an explicit ramp request.

## When not to use

Do not retime to force every beat, rescue weak footage, or promise smooth slow motion without frame-rate evidence.

## Required inputs

Action apex, source frame rate when known, speech status, current clip bounds, and free track space.

## Expected outputs

Split sections with constant per-clip speeds and repaired surrounding layout.

## Core philosophy

Slow significance; speed process. Retiming must reveal the action, not announce the effect.

## Professional heuristics

- A ramp is split clips with constant speeds.
- 60fps may tolerate 0.5×; unknown/30fps calls for roughly 0.7–0.8×.
- Keep ordinary dialogue near 0.9–1.3×.
- Bracket the apex, usually 0.5–1.5s, rather than slowing an entire clip.

## Decision framework

Locate apex → check physics/speech → split boundaries → set conservative speeds → repair gap/overlap → review motion.

## Common mistakes

Ignoring frame rate, slowing the approach instead of payoff, leaving gaps, or using many ramps.

## Verification checklist

- Action completes.
- Speech remains natural.
- No overlap/gap was introduced unintentionally.
- The effect is scarce and motivated.

## Recovery advice

Move speed toward 1× first; if the peak still fails, restore normal speed and improve shot timing.

## Related skills

`beat-synced-editing`, `keyframe-animation`, `short-form-pacing`, `travel-montage`.
