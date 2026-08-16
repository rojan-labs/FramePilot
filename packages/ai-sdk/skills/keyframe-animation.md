---
name: keyframe-animation
description: Build technically valid clip-relative scale, position, rotation, and opacity animation with restrained timing and appropriate easing.
tools: [get_clip, get_timeline, add_keyframes, punch_in]
---

# Keyframe animation

## Purpose

Translate a chosen motion idea into valid keyframes that feel intentional and remain inside the clip.

## When to use

Punch-ins, slow zooms, pans, drifts, rotations, or overlay fades.

## When not to use

Do not use motion without a narrative/design purpose or promise unsupported properties.

## Required inputs

Target clip duration, clip-relative event timing, desired property endpoints, and motion intent.

## Expected outputs

Paired keyframes or one `punch_in` call, valid easing, and a concise WHY.

## Core philosophy

Motion directs attention. The smallest move that communicates the intent is usually the most professional.

## Professional heuristics

- Times are clip-relative; read the target clip before placement.
- Animate properties in pairs; a lone keyframe snaps.
- Use ease-out for emphasis settles, ease-in-out for camera-like drifts, hold for deliberate steps.
- Talking-head emphasis is usually 1.05–1.15× over 0.3–0.6s; slow image moves may span the clip.
- Prefer `punch_in` for a standard scale emphasis.

## Decision framework

Name attention goal → choose one property → set start/end inside clip → choose easing from motion character → apply → review at speed.

## Common mistakes

Timeline-relative times, keyframes past clip end, linear robotic moves, excessive zoom, or several properties moving without hierarchy.

## Verification checklist

- All times lie inside the clip.
- Start/end values form a deliberate motion.
- Crop/resolution can tolerate the scale.
- Motion lands on the intended word/action.

## Recovery advice

Reduce amplitude before changing timing. If the motion still distracts, remove it; static is a valid design decision.

## Related skills

`motion-design`, `titles-and-text`, `vertical-reframe`, `beat-synced-editing`.
