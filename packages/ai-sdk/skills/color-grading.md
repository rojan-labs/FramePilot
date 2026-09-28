---
name: color-grading
description: Color reference — measuring shots, correcting exposure and white balance, matching shots, shaping a look or a requested per-scene look (e.g. cool morning to warm dusk), and finishing texture such as grain, bloom, light leaks and vignette.
tools: [get_timeline, detect_scenes, measure_color, match_color, normalize_exposure, apply_look, apply_color_grade, get_frame, discover_effects, apply_effect]
---

# Color grading

**A look the request describes is the target** — its palette, its time-of-day progression, its
named workflow, its "no teal-orange". This skill supplies the order of operations and the
restraint (how far to push, what to protect), not the look itself.

## Purpose

Create a coherent image sequence: neutral and matched first, expressive second.

## When to use

Exposure or color-cast repair, shot matching, mood changes, a time-of-day arc, finishing texture, and final visual polish.

## When not to use

Do not promise scopes, a grade limited to part of the picture beyond what the masking tools build (see `masking-and-compositing`), or pixel judgments you have not looked at.

## Required inputs

Clip/scene grouping, intended mood (the request's words first), known continuity relationships, and representative frames.

## Expected outputs

Conservative per-clip corrections, a consistent look, and preview-grounded review notes.

## Core philosophy

Correct → match → grade. Skin and neutral references arbitrate; consistency beats an individually beautiful shot.

## The tools, in the order the work uses them

- `measure_color` reads what is on screen now — the numbers every decision below is made
  against. Nothing here is judged from a filename or a hunch.
- `normalize_exposure` evens a track out; `match_color` matches shots to a reference shot;
  `apply_look` pushes shots toward warmer, cooler, punchier, flatter, brighter, darker,
  cinematic or clean at subtle/medium/strong. Each solves the grade from measured facts and
  reports how it was derived — review it rather than quoting its accuracy.
- `apply_color_grade` is the manual parametric grade, for a value the editor named.
- Texture is not a grade: film grain, bloom/halation, light leaks and vignette are catalog
  effects (`discover_effects` for ids and ranges, then `apply_effect`). An effect is a layer
  over a time range and touches every visible clip beneath it.

## Professional heuristics

- Fix exposure before temperature/tint, then shape contrast, shadows, highlights, and saturation.
- Most corrections belong within ±0.3; halve an uncertain look.
- Keep saturation and white-balance moves gentle on faces.
- Reuse corrections within one camera/lighting setup; change them at supported scene boundaries.
- A time-of-day arc is a look per section: `apply_look` cooler on the early group, warmer on the late one, stepping at section changes rather than shot by shot.
- Build “cinematic” with several subtle moves, never one extreme filter.
- Grain and leaks read as texture only when faint: low intensity, and one consistent grain over the whole piece rather than per shot.
- A still used as a full-length background still needs representative preview review; do not infer an exposure, white-balance, or saturation problem from its filename or timeline presence.

## Decision framework

Group shots → choose a reference → neutralize it → match its group → preview cuts → apply the
look (the request's, or one restrained look) → add texture last. A workflow the request names
("normalize → match → look → per-scene shift") is the order to follow.

## Common mistakes

Grading before correction, copying values across different lighting, crushing shadows, oversaturating skin, heavy grain, or judging numeric settings instead of pixels.

## Verification checklist

- Skin remains plausible.
- Whites and neutrals have no accidental cast.
- Adjacent shots do not visibly jump.
- Shadow detail and highlight roll-off survive.
- The look matches the request's description on `get_frame` from each section.

## Recovery advice

Reset the most aggressive axis toward zero, re-establish the reference shot, then rematch only the affected group. If visual review is unavailable, do not invent a correction. Apply one only from explicit visual evidence already returned by a tool, then report it unreviewed.

## Related skills

`cinematic-storytelling`, `finishing-and-delivery`, `footage-intelligence`, `masking-and-compositing`.
