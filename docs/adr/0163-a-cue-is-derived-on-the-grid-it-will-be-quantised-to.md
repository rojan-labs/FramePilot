# ADR 0163 — A cue is derived on the grid it will be quantised to

**Status:** accepted
**Date:** 2026-08-30
**Schema:** unchanged
**Related:** ADR 0071 (segmentCaptions is the single authority), ADR 0076 (canonical
timeline mapping), ADR 0146 (the project frame grid), run `7d159862`

## Context

Caption cues are derived in seconds, from word timings in seconds, against a timeline in
seconds. Sequence times are then quantised to an integer project frame at the patch
boundary — `normalizeOperationTime`, per ADR 0146 — with nearest rounding applied
independently to each edge of a range.

Independent per-edge rounding is not range-preserving. Any span narrower than half a
frame lands on the same frame at both ends and becomes zero-length, which
`positiveRange` rejects. Because a patch is all-or-nothing, one such cue rejects every
other cue with it.

This is not theoretical and it is not new. It shipped once for `delete_clip`, where an
off-grid clip's own end rounded back inside itself and left a sub-frame husk that no
later delete could remove — 29 of 48 failed delete calls in one mission ledger. That was
fixed for `delete_clip` alone, by flooring the start and ceiling the end at the tool, and
the general hazard was left in place.

It then shipped again. In run `7d159862` a user asked for a captioned talking-head edit.
One 0.02s ASR artifact — the word "build", timed 18.06→18.08 — put a cue's start and end
both on frame 542 at 30fps. `caption_the_edit` was called four times, with three
different argument sets; every preset collapsed the same cue, so no parameter change
could escape it. 584 operations were rejected, roughly ten of the run's eighteen model
calls were spent on it, and the user's timeline finished with one clip, three empty
tracks, and no captions.

Two things made that outcome possible, and both are design errors rather than accidents:

1. **Segmentation did not know the grid.** `deriveCaptionCues` had no `fps`, so it could
   not tell a legal cue from one that would not survive validation.
2. **Segmentation produced cues far too short to be captions at all.**
   `enforceReadingSpeed` split any cue over the reading-speed ceiling, on a premise
   written into its own doc comment: that `enforceTiming` would then hold each half for
   `minCueSeconds`. That premise is false by construction. Two halves of a split abut, so
   the left half's ceiling *is* the right half's first word, and where the words are
   dense enough to trip the limit that ceiling is milliseconds away. The recursion ran
   until every fragment was a single word. On this transcript, 25 of 63 cues came out
   under the 0.5s minimum and one read "We" for **10 milliseconds**.

The rejection was the visible symptom. The unreadable captions were the real defect, and
they would have shipped silently had the patch validated.

## Decision

**A stage that derives times which will become operations knows the grid those operations
will be quantised to.**

Concretely:

- `deriveCaptionCues` and `segmentCaptions` take the project `fps`. Every caller that
  builds a patch passes it — the agent's `caption_the_edit` and the Captions panel's
  `generateCaptionsPatch`, which had the identical latent bug. It stays optional for the
  panel's throwaway preview, which builds no operations.
- Cues that would begin on the same frame are **merged**, before layout and timing.
- A reading-speed split is taken only at a break whose first half can actually be held
  for `minCueSeconds`. Where no such break exists the dense cue is kept whole.

### Why merge rather than promote to one frame

Promoting a collapsed cue to a single frame trades a zero-length rejection for an
overlap: the cue that starts on that very frame is the reason the first one had nowhere
to go. Two cues the grid cannot tell apart in time *are* one cue, and their words belong
on screen together. Merging preserves every spoken word, which promotion and dropping do
not.

### Why the split guard bounds the left half only

The left half's display time is decided at the split and cannot be recovered:
`enforceTiming` may not cross into the right half. The right half inherits the original
cue's ceiling and stays extensible, so it needs no bound. Scoring only holdable breaks —
rather than picking on linguistics and then vetoing — keeps a good-but-unholdable seam
from suppressing a viable one further along.

### What this gives up

Density is now a soft target. A cue may sit above `maxCharsPerSecond` when no split would
leave a readable first half. That is the right trade: text slightly over the ceiling is
read at a glance; the same text torn into sub-frame fragments is not read at all.
Legibility is not negotiable, and reading speed was only ever a proxy for it.

## Consequences

- Measured on run `7d159862`'s real 149-word transcript: zero-length operations 1 → 0 for
  every preset at 24/25/29.97/30/50/60 fps, with no duplicate clip ids and no overlaps
  introduced. Cues under the minimum fell from 25/63 to 7/48; sub-frame cues from 2 to 0.
  The worst cue went from 10ms to 100ms.
- Three existing tests asserted the old "split at any cost" contract and were rewritten.
  In each case not splitting is measurably better — `"never again."` held whole for 0.8s
  reads at 15 cps, under the 17 cps ceiling the split was trying to satisfy.
- The remaining short cues are bounded by speech itself: consecutive words with no gap
  between them cannot be held longer without desynchronising the caption from the voice.
  This is the honest floor, not a residual bug.
- `minCueSeconds` below one frame would still permit a collapse. No caller sets it — only
  the three presets (0.5 / 0.8 / 0.25) are reachable, all far above one frame at 60fps —
  so this is left as a documented bound rather than coupling config clamping to `fps`.
- The class remains open for other range operations. `trim_clip`, `delete_range`,
  `ripple_delete`, `add_clip`, `add_text_overlay` and the effect-layer ops all still
  round each edge independently. `add_transition` is the one that gets it right and is
  the model for the rest. Widening a *deletion* to a frame is destructive, so the general
  fix is per-operation and is not attempted here.

`packages/ai-sdk/src/domain-tools/caption-the-edit-grid.test.ts` replays the run's four
rejected calls against its real transcript, and was verified to fail against the previous
implementation.
