---
name: beat-synced-editing
description: Build music-driven edits from detected onset evidence, scored visual opportunities, variable rhythm, motion continuity, and preview-based refinement rather than a fixed grid.
tools: [detect_beats, map_footage, describe_footage, search_visual, read_edit_signals, get_timeline, get_clips, map_time, list_assets, add_clip, add_clips, split_clip, trim_clip, set_clip_speed, add_transition, render_preview, verify_transitions]
---

# Beat-synced editing

## Purpose

Make picture, music, motion, emotion, and story reinforce each other. Beats are opportunities, never obligations.

## When to use

Montages, trailers, sports, travel, performance, fashion, music-led reels, or explicit synchronization requests.

## When not to use

Do not subordinate dialogue, causality, action completion, or emotional holds to a grid. Do not infer bars, downbeats, drops, lyrics, instruments, or song sections from onset times alone.

## Required inputs

Editorial goal, target duration/style, music asset and placement, detected onsets, grounded footage evidence, protected dialogue/action, and current sequence mapping.

## Expected outputs

A compact rhythm plan, several evidence-backed shot candidates, a globally selected sequence with varied duration, motivated transitions/retiming, and preview findings.

## Core philosophy

Choose the strongest visual moment near the most meaningful supported musical event. A cut must have a reason stronger than “a beat exists.”

## Professional heuristics

- `detect_beats` supplies onset times and estimated BPM—not musical semantics. Label inferred regions neutrally by density/spacing/strength change.
- Nothing snaps or refuses a cut for you. When the editor asked for cuts *on the beat*, put each boundary on a returned onset time exactly (converted with `map_time` once the bed is placed); when the picture leads, a cut a few frames off an onset is an ordinary editorial choice. Say which you did.
- Map source events into sequence time with tools; never calculate offsets in prose.
- Build footage candidates at action starts, peaks, completions, reveals, reactions, scene boundaries, and strong compositions—not only asset heads.
- Compare pairings by story/payoff, action quality, event importance, motion/eye-flow continuity, novelty, and retiming cost. A strong onset cannot rescue a bad visual cut.
- Select the sequence globally. Use contrast: hold → burst → hold; wide → detail → reaction; tension → release.
- Let impact frames meet accents, not automatically shot heads. One or two frames may suit a hard impact; emotion and motion may land perceptually better nearby.
- Preserve screen direction, action payoff, lyric/dialogue intelligibility, and time to read a new composition.
- Straight cuts dominate. Transitions and speed changes follow locked shot rhythm and express a relationship; they never compensate for weak selection.

## Decision framework

1. Establish story, duration, style, and protected material.
2. Detect music events once; retry sensitivity only when evidence shows an implausible result.
3. Map and inspect footage; produce multiple candidate moments with cited reasons.
4. Score pairings and choose a whole-sequence arc, not one beat at a time.
5. Plan section energy and shot-duration ranges; reject mechanical repetition.
6. Build structural cuts with `add_clips` — a montage is a sequence, and placing it one
   `add_clip` at a time spends the run's turns on bookkeeping instead of on the edit. Then
   restrained retiming/transitions.
7. Re-read the current timeline and preview representative sections plus the ending.

## Common mistakes

Cutting every beat, repeating one interval, spending the hero shot before the peak, cutting before action completes, reversing direction accidentally, claiming music semantics the detector did not return, or stacking zooms/transitions/ramps.

## Verification checklist

- Every cut has a story, motion, composition, emotion, or supported musical reason.
- Strong images align with the strongest known events; low-value beats are allowed to pass.
- Durations vary with an intentional energy arc.
- No action, speech, or visual comprehension is truncated.
- Transition effects sit on real boundaries and pass `verify_transitions`.
- A rendered preview supports the claimed rhythm; otherwise report it unapplied or unreviewed as appropriate.
- The ending resolves instead of continuing to cut after the emotional endpoint.

## Recovery advice

Fix the smallest weak region. Replace a forced pairing with the next-ranked visual candidate, relax exact sync when motion reads better, or restore a hold. Never globally quantize the timeline to repair one seam.

## Related skills

`travel-montage`, `speed-ramping`, `cut-and-transition-grammar`, `footage-intelligence`, `cinematic-storytelling`.
