---
name: travel-montage
description: Craft reference for travel, destination and trip-recap montages — orienting the viewer, varying shot scale, completing camera moves, earning the hero shot, landing music peaks — and how to realise a brief that already gives its own shot list and treatments.
tools: [map_footage, describe_footage, search_visual, get_frame, detect_beats, map_time, get_timeline, add_clips, trim_clip, reorder_clips, set_clip_speed, set_clip_speed_ramp, reframe_pan, discover_transitions, add_transitions]
---

# Travel montage

**Reference, not a template.** When the request carries its own structure — acts, a
shot-by-shot list, per-shot durations, named treatments (masks, ramps, stamps, stickers, SFX),
a typography system, a grade — that structure IS the edit. Build it row by row, in its order,
at its durations, and use this skill to fill only what it leaves open (which take, which moment
inside a clip, how a camera move completes) and to flag a spec that will not work. The shape
described below is the default for a travel edit nobody has specified.

## Purpose

Build a sense of arrival, movement, discovery, and resolution — not a shuffled destination highlight reel.

## When to use

Travel films, destination reels, event/location montages, and cinematic recaps — to shape one
from scratch, or to judge the open details of one the editor has already planned.

## When not to use

When narration or chronology must dominate, or visual evidence cannot establish location/action.
Never to swap the editor's own structure for this skill's default one.

## Required inputs

The request's own structure when it has one (shot list, acts, durations, treatments); grounded
location/action spans; hero moments; music evidence; target duration.

## Expected outputs

Either the requested list realised shot for shot, each deviation named with its reason — or,
when nothing was specified, a geographic progression with varied scale, completed camera
motion, human detail, rhythmic contrast, and a resolved final image.

## Core philosophy

Orient, immerse, reveal. Rhythm supports the journey; it does not replace it. When the editor
wrote the journey, your craft goes into executing it well, not into re-deciding it.

## Professional heuristics

- **Realising a given shot list:** resolve every row to a real asset and source moment first
  (look with `get_frame { sources: [{ assetId }, …] }` — up to 12 clips as shot on one sheet —
  where the map has not reached them), then
  place the list with `add_clips` at its durations, then work through each row's treatments.
  "Snap cuts to the beat" moves each planned boundary to the nearest onset — it never changes
  the shot count, the order, or the act proportions. A row you cannot do as written (asset
  missing, treatment unsupported) keeps its slot and gets the nearest honest version, named.
- When the order is yours: establish geography before rapid details, unless the opening is a
  deliberate hero or detail hook.
- Vary scale and subject between neighbours — place/wide, activity, texture/detail,
  person/reaction, vista. A vocabulary to draw from, not a rotation to repeat.
- Let pans, passes, arrivals, and gestures complete; cut on the end of a move or into a
  matching one.
- Save the strongest vista or emotional face for a peak unless it is the hook.
- Match cuts (direction, shape, colour) and gentle speed changes before showy transitions. A
  transition the editor named for a particular cut goes on that cut: `add_transitions` with
  `cuts`, each carrying its `kind` (ids from `discover_transitions`).
- Aerials in a vertical frame: a slow `reframe_pan` along the strongest line (coastline, ridge,
  road curve) beats a static centre crop — see `vertical-reframe`.
- Floating aerials at 0.7–0.8× and a `set_clip_speed_ramp` slow-down on an arrival read well;
  check frame-rate limits in `speed-ramping`.

## Decision framework

A shot list was given → resolve each row to asset + moment → place the list → align boundaries
to the music → apply each row's treatments → preview → report every deviation.
Nothing was given → map locations → choose journey beats → rank heroes and details → assemble a
readable progression → align chosen moments to the music → preview.

## Common mistakes

Replacing the editor's plan with a generic montage; a fixed cut interval nobody asked for
("every two beats"); every wide shot first; random chronology; cutting camera moves early;
identical shot lengths; excessive speed ramps.

## Verification checklist

- When a list was given: every row is on the timeline, in order, near its duration, with its
  treatments — or named as changed, with the reason.
- Viewer can infer place and progression.
- Shot scale/direction varies coherently.
- Hero moment is earned.
- Opening and ending have breathing room.

## Recovery advice

Insert one clear establishing or human-orientation shot where geography breaks; do not explain
confusion with more effects. If the build drifted from the editor's list, rebuild the drifted
section against the list rather than restarting the reel.

## Related skills

`beat-synced-editing`, `cinematic-storytelling`, `vertical-reframe`, `speed-ramping`, `footage-intelligence`, `color-grading`.
