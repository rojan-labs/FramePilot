---
name: hook-crafting
description: Opening reference — choosing a truthful high-value first moment, restructuring the timeline around its promise, and making a specified hook (shot, line or title) land on the right frame with restrained text or framing.
tools: [get_mapped_transcript, map_footage, search_visual, get_frame, get_timeline, split_clip, reorder_clips, ripple_delete, discover_text_overlay_styles, add_text_layer, punch_in]
---

# Hook crafting

**When the editor names the hook** — a shot, a line, a title, an opening treatment — build that
hook. This skill then judges how it lands (the exact first frame, the trim, whether text and
motion compete) and flags a hook that will not hold. Choosing a hook yourself is for requests
that leave the opening open.

## Purpose

Earn attention immediately while making a promise the finished video actually pays off.

## When to use

Weak openings, shorts, cold opens, trailers, or “make the first seconds stronger.”

## When not to use

Do not manufacture clickbait, duplicate a payoff with no later resolution, or force short-form urgency into contemplative work.

## Required inputs

Mapped speech/visual evidence, audience, format, payoff, the current opening, and any hook the
request specifies.

## Expected outputs

A selected (or specified) hook span, clean opening restructure, optional complementary text/framing, and a first-five-seconds review.

## Core philosophy

Lead with the highest-value truthful moment, then spend the body earning it.

## Professional heuristics

- Prefer result-first, tension, sharp question, or in-medias-res over greeting/context.
- Start on the meaningful syllable or action; remove throat-clearing.
- Text should add tension or context, not transcribe the spoken line.
- Keep the hook understandable without exhausting the full payoff.
- A specified hook shot still needs its best seconds: look at the source (`get_frame { assetId, sourceSeconds }`) and open on the frame where the motion or reveal is already under way.
- To bring a whole shot forward, `split_clip` around it if needed, then `reorder_clips` with every clip id of the track in the new order — it re-lays the track gaplessly and deletes nothing. `move_clip` cannot reorder.

## Decision framework

Hook specified → locate its best span → place it first → trim its start to the moment → add
its named text/treatment → review the first five seconds. Hook open → generate candidates →
score clarity, novelty, stakes, self-containment, and payoff honesty → isolate the winner →
place it first → compress setup → review continuity.

## Common mistakes

Choosing shock over relevance, opening with a logo, clipping the first word, stacking every emphasis device, or replacing the hook the editor chose with your own.

## Verification checklist

- The first 1–3 seconds communicate a reason to stay.
- The body fulfills the promise.
- The move preserves speech/action continuity.
- Text and framing support rather than compete.

## Recovery advice

If the moved excerpt feels contextless, add the minimum bridge after it or choose the next-best self-contained candidate; do not restore the whole warm-up.

## Related skills

`short-form-pacing`, `story-structure`, `text-overlays`, `footage-intelligence`.
