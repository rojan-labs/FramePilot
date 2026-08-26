# ADR 0144 — An edit that renders as nothing is refused, not reported

**Status:** accepted
**Date:** 2026-08-26
**Related:** ADR 0032 (any clip kind on any layer), ADR 0074 (empty-run honesty), ADR 0083
(never report an edit on an unchanged timeline), ADR 0143 (sourcing is not reconnaissance)

## Context

The same captured run (`e30c1fe9`) that could not fetch footage built its Reel out of
fifteen text overlays and then punched in on every one of them, telling the editor that
"each card gets its own scale behaviour so the screen never sits still".

`punch_in` accepted each call. The patch validated. It applied, it survived undo, and it
was reported as an edit. And the render compiler placed text overlays with a bare
`with_position("center")`, dropping every keyframe on the floor — so the fifteen animated
cards rendered as fifteen static ones, in the preview as well as the export.

This is the "never fake success" invariant broken from the far end. The usual failure is a
tool that reports work it did not do; this is a tool that really did record an operation,
against an engine that ignores it. The editor cannot tell the difference until export.

The same run then met the second half of the problem. Its deliverable was thirty seconds
of type over an empty video track, and every deterministic gate passed it:
`duration_target` measures the latest clip end, and a stack of overlays is thirty seconds
long by that measure. The perceptual reviewer, which does read pixels, reported the one
real fact fifteen times — "Unexpected black frame(s)" at fifteen edit boundaries — which
reads as fifteen broken cuts. The run spent its last turn adding transitions to fix cuts
that were not broken.

## Decision

**An operation the engine cannot render is either rendered or refused. Never accepted and
dropped.**

- **Text overlays render their transform.** `_compile_text_clip` goes through the same
  placement as picture, with the frame fit turned off (a text image is rasterized tight to
  its glyphs; fitting that to the frame would blow one word up to full width). `punch_in`
  on a text card now animates.
- **Captions refuse it.** Caption motion belongs to the caption template's per-word
  animation, so a transform keyframe on a caption clip would still render as nothing.
  `punch_in` and `add_keyframes` reject a caption clip and name `set_track_caption_style`.

**The deterministic Critic asks whether there is anything to look at.** A `picture_present`
check excludes overlay and caption clips — they sit _over_ the picture — and fails when
something visual was asked for. `duration_target` says how much of the length is picture or
sound when the two differ, instead of quietly certifying a film that does not exist.

**When every sampled range is black, the review says so once.** The per-range reading was
right and the conclusion drawn from it was wrong. A single black range among clean ones
keeps its exact frame numbers, because that is a real flash at a real cut.

## Consequences

- Motion on a text card is real, which makes typographic short-form — the dominant format
  this product is for — actually achievable through the agent.
- The Critic gains a check that can fail a run, and it fails exactly the shape that used to
  pass in silence. It warns rather than fails when nothing visual was requested, so an
  audio-only or caption-only pass stays legitimate.
- One preview-only path is left and is now stated rather than discovered: a text overlay's
  `inAnimation`/`outAnimation` are drawn by the preview and not by the renderer. The agent
  cannot set them (`add_text_layer` does not expose them), so this can only be reached
  through the Inspector. It is the next thing to close here.
