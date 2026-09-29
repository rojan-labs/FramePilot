---
name: short-form-pacing
description: Pacing reference for short vertical edits — hook clarity, information density, rhythmic contrast, tightening shots, and a clean payoff — without mechanically accelerating everything; a requested duration, structure or rhythm takes precedence.
tools: [get_mapped_transcript, get_timeline, remove_silences, tighten_clips, ripple_delete, reorder_clips, set_clip_speed, punch_in, caption_the_edit]
---

# Short-form pacing

**Reference defaults.** A duration, structure, cut rhythm or hold the request names ("let the
reveal breathe for 3 s", "long holds at the end") overrides the norms below. Use them to judge
what the request leaves open, and to notice when a spec will read as dead air or as a blur.

## Purpose

Hold attention by removing friction and varying information, not by maximizing cut count.

## When to use

Reels, Shorts, TikTok, punchier talking heads, or tight promotional edits.

## When not to use

Do not impose feed pacing on emotional pauses, long-form explanation, or footage whose requested tone is restrained.

## Required inputs

Target duration, mapped speech, hook/payoff, protected moments, platform frame, and any
pacing the request specifies.

## Expected outputs

A clean opening, compressed low-value sections, intentional visual changes, current captions, and no trailing tail.

## Core philosophy

Every second must either deliver value, build anticipation, or provide purposeful contrast.

## Professional heuristics

- To make a section that is already in order cut faster, `tighten_clips` trims every shot in the window to a shot length and closes the gaps in one patch (name the shots to keep); do not delete the section and re-add it.
- Dead air in speech goes in one `remove_silences` call, not a hand-built list of deletions.
- Unless the opening is specified, reach the hook within the first seconds; context follows.
- Cut hesitation before speeding speech. Keep natural dialogue near 1.0–1.3×.
- Vary density; a brief hold makes the next burst feel faster.
- Use punch-ins and captions on meaningful beats, not a fixed interval.
- End on the payoff, not the sign-off.

## Decision framework

A working order for an unspecified edit: lock hook/payoff → remove dead material → assess
duration/information gaps → add only motivated framing/speed changes → caption once the cut is
locked (`caption_the_edit`) → watch opening and ending. A request that sets any of these steps
answers it.

## Common mistakes

Deleting every breath, identical shot lengths, punch-ins every other cut, speeding punchlines, captioning before structure settles, or overriding pacing the editor asked for.

## Verification checklist

- Request duration and core meaning are preserved.
- Hook and payoff remain intelligible.
- No machine-gun section loses comprehension.
- Captions are current and verified by the caption workflow.

## Recovery advice

If the edit feels exhausting, restore contrast by lengthening the most important reaction or payoff; do not globally slow everything.

## Related skills

`hook-crafting`, `silence-and-filler-cutting`, `caption-design`, `beat-synced-editing`.
