---
name: vertical-reframe
description: Convert aspect ratios with valid fractional crop rectangles, subject-aware composition, platform-safe placement, and shot-by-shot consistency.
tools: [get_clip, get_project_state, set_clip_crop, track_object, punch_in, render_preview]
---

# Vertical reframe

## Purpose

Preserve the subject and visual intent when changing the delivery frame.

## When to use

16:9→9:16/1:1/4:5 conversion, poor framing repair, or moving-subject follow.

## When not to use

Do not infer subject position without visual evidence or track static subjects unnecessarily.

## Required inputs

Source/target aspect, subject position/motion, shot boundaries, safe areas, and resolution budget.

## Expected outputs

Valid per-shot crop rectangles and reviewed composition.

## Core philosophy

Reframing is composition; crop math only defines the available window.

## Professional heuristics

- For target `T` inside wider source `S` at full height: width=`T/S`, height=1; place x around subject center and clamp.
- Put eyes near the upper third and essentials inside the middle safe region.
- Crop per setup; keep subject size/position consistent across cuts.
- Use tracking only when supported and motion demands it.
- Limit extra punch-in after a severe crop.

## Decision framework

Confirm ratios → retrieve subject evidence → calculate valid rect → compose per shot → preview → refine.

## Common mistakes

Center-cropping blindly, beheading, static crop on moving action, or stacking excessive zoom.

## Verification checklist

- Rect stays within 0..1.
- Face/action remains framed throughout.
- Text/captions do not collide.
- Resolution remains acceptable.

## Recovery advice

Reset crop to null, re-establish the widest viable composition, then adjust one axis at a time.

## Related skills

`footage-intelligence`, `caption-design`, `keyframe-animation`, `short-form-pacing`.
