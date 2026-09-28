---
name: keyframe-animation
description: Build technically valid clip-relative scale, position, rotation, opacity (and, on request, stretch) animation with restrained timing and appropriate easing — or the exact values and timings an editor specifies.
tools: [get_clip, get_timeline, add_keyframes, remove_keyframes, punch_in]
---

# Keyframe animation

**Values and timings the request names are used as given** ("106% → 100% over 14 frames,
ease-in-out" is scale 1.06 → 1.0 across 14 ÷ fps seconds). The ranges below are defaults for
moves nobody specified.

## Purpose

Translate a chosen motion idea into valid keyframes that feel intentional and remain inside the clip.

## When to use

Punch-ins, slow zooms, pans, drifts, rotations, settles, or overlay fades.

## When not to use

Do not use motion without a narrative/design purpose or promise unsupported properties.

## Required inputs

Target clip duration, clip-relative event timing, desired property endpoints, and motion intent.

## Expected outputs

Paired keyframes or one `punch_in` call, valid easing, and a concise WHY.

## Core philosophy

Motion directs attention. The smallest move that communicates the intent is usually the most professional.

## Professional heuristics

- Properties: `scale` (1 = fitted), `x`/`y` (pixel offsets from centred), `rotation`
  (degrees), `opacity` (0–1); `scaleX`/`scaleY` stretch one axis — only when a stretch was asked for.
- Times are clip-relative; read the target clip before placement.
- Animate properties in pairs; a lone keyframe snaps.
- Use ease-out for emphasis settles, ease-in-out for camera-like drifts, hold for deliberate steps.
- Talking-head emphasis is usually 1.05–1.15× over 0.3–0.6s; slow image moves may span the clip.
- Prefer `punch_in` for a standard scale emphasis.
- A clip reframed with `reframe_pan` carries its window as x/y/scale keyframes: keyframing
  those with `add_keyframes` fights the pan, but a `punch_in` multiplies the pan's zoom and
  pushes in on top of it. Opacity and rotation are free to animate.

## Decision framework

Name attention goal → choose one property → set start/end inside clip → choose easing from motion character → apply → review at speed.

## Common mistakes

Timeline-relative times, keyframes past clip end, linear robotic moves, excessive zoom, several properties moving without hierarchy, or overwriting a reframe's keyframes.

## Verification checklist

- All times lie inside the clip.
- Start/end values form a deliberate motion.
- Crop/resolution can tolerate the scale.
- Motion lands on the intended word/action.

## Recovery advice

Reduce amplitude before changing timing. If the motion still distracts, remove it (`remove_keyframes`); static is a valid design decision.

## Related skills

`motion-design`, `text-overlays`, `vertical-reframe`, `beat-synced-editing`.
