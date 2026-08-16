---
name: color-grading
description: Correct exposure and white balance, match shots, then shape a restrained look with the registered parametric grade and preview evidence.
tools: [get_timeline, detect_scenes, apply_color_grade, render_preview]
---

# Color grading

## Purpose

Create a coherent image sequence: neutral and matched first, expressive second.

## When to use

Exposure or color-cast repair, shot matching, mood changes, and final visual polish.

## When not to use

Do not promise scopes, automatic shot matching, selective skin keys, or pixel judgments without a rendered preview.

## Required inputs

Clip/scene grouping, intended mood, known continuity relationships, and representative rendered frames.

## Expected outputs

Conservative per-clip corrections, a consistent look, and preview-grounded review notes.

## Core philosophy

Correct → match → grade. Skin and neutral references arbitrate; consistency beats an individually beautiful shot.

## Professional heuristics

- Fix exposure before temperature/tint, then shape contrast, shadows, highlights, and saturation.
- Most corrections belong within ±0.3; halve an uncertain look.
- Keep saturation and white-balance moves gentle on faces.
- Reuse corrections within one camera/lighting setup; change them at supported scene boundaries.
- Build “cinematic” with several subtle moves, never one extreme filter.
- A still used as a full-length background still needs representative preview review; do not infer an exposure, white-balance, or saturation problem from its filename or timeline presence.

## Decision framework

Group shots → choose a reference → neutralize it → match its group → preview cuts → apply one restrained look across the sequence.

## Common mistakes

Grading before correction, copying values across different lighting, crushing shadows, oversaturating skin, or judging numeric settings instead of pixels.

## Verification checklist

- Skin remains plausible.
- Whites and neutrals have no accidental cast.
- Adjacent shots do not visibly jump.
- Shadow detail and highlight roll-off survive.
- The rendered preview supports the claimed look.

## Recovery advice

Reset the most aggressive axis toward zero, re-establish the reference shot, then rematch only the affected group. If visual review is unavailable, do not invent a correction. Apply one only from explicit visual evidence already returned by a tool, then report it unreviewed.

## Related skills

`cinematic-storytelling`, `finishing-and-delivery`, `footage-intelligence`.
