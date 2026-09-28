---
name: vertical-reframe
description: Convert aspect ratios (16:9 to 9:16, 1:1, 4:5) shot by shot — look at each source as shot, place a subject-aware crop, or pan the window across a wide shot; platform-safe placement and consistency.
tools: [get_frame, get_clip, set_clip_crop, reframe_pan]
---

# Vertical reframe

**Framing targets the request gives per shot** ("face in the upper third", "bias toward the
speaker", "horizon at 40%", "pan along the coastline") replace the defaults below. Your job is to find
where that is in each source and hold it.

## Purpose

Preserve the subject and visual intent when changing the delivery frame.

## When to use

16:9→9:16/1:1/4:5 conversion, poor framing repair, or a slow move across a wide shot.

## When not to use

Do not infer subject position without visual evidence, and do not move a frame that has a
settled, centred subject.

## Required inputs

Source/target aspect, where the subject is in each source, shot boundaries, safe areas, and
resolution budget.

## Expected outputs

A deliberate reframe on every shot — a crop aimed at its subject, or a pan — reviewed on the
delivered frame.

## Core philosophy

Reframing is composition; crop math only defines the available window. A shot added to a
differently shaped sequence arrives with a CENTRED crop, which is a guess, not a reframe.

## How to see the subject

- `get_frame { assetId, sourceSeconds }` shows a source file as shot: the whole uncropped
  frame. Look there FIRST — the timeline only shows a placed clip through its crop, so the
  part of the frame the crop hides is exactly where a subject you are missing is.
- After reframing, `get_frame { timeSeconds }` shows the delivered frame; check the subject
  is in the window and clear of the platform UI zones.

## Two ways to reframe

- **A fixed window:** `set_clip_crop` with a rect in source fractions. For a 9:16 window in a
  16:9 source at full height, width = (9/16)/(16/9) ≈ 0.316 and height = 1; set x so the
  subject sits where it should, clamped to 0…(1 − width).
- **A moving window:** `reframe_pan { from, to }` — the window centre as source fractions
  (x: 0 left … 1 right), eased from one to the other over the clip. Use it for aerials and
  wide shots (a slow drift of 5–10% of the frame width per 2s adds life) and to keep up with
  a subject you watched move across the source. It replaces the clip's crop and its x/y/scale
  keyframes, and its scale keyframes ARE the zoom that fills the frame — so do not punch_in
  on a panned clip (a punch-in writes scale and would undo the reframe).
- A subject that moves unpredictably cannot be followed automatically yet: pan between the
  positions you saw at the start and end, and say that the framing is a pan, not a track.
- A blurred-fill background (the whole frame over a blurred, scaled copy of itself) is not
  something the placement tools build: a scaled picture layer over other picture is refused
  when placed. The honest fallbacks are a tighter crop, a pan, or `set_clip_crop` with
  `allowLetterbox: true` to keep the whole frame with bars — say which you used.

## Professional heuristics

- Put eyes near the upper third and essentials inside the middle safe region.
- Aim the window per shot; keep subject size/position consistent across cuts.
- Lead a moving subject: leave space in the direction of travel.
- Limit extra punch-in after a severe crop — a 9:16 window cut from a 1920×1080 source is
  607 px wide shown at 1080, already a 1.8× upscale.

## Decision framework

Confirm ratios → look at each source → choose fixed or moving → place → check the delivered
frame → refine.

## Common mistakes

Centre-cropping blindly, reframing from the timeline's cropped view, beheading, a static crop
on moving action, or stacking excessive zoom.

## Verification checklist

- Rect stays within 0..1.
- Face/action remains framed throughout, checked on the delivered frame.
- Text/captions do not collide.
- Resolution remains acceptable.

## Recovery advice

Reset crop to null, re-establish the widest viable composition, then adjust one axis at a time.

## Related skills

`footage-intelligence`, `caption-design`, `keyframe-animation`, `short-form-pacing`.
