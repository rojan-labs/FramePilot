# ADR 0135 — A transition reveals the shot it came from

**Status:** accepted
**Date:** 2026-08-22
**Closes:** the black-frame findings a captured agent run (`run.md`) reported at all seven of
its cuts, and the "insufficient transition handles" Tier-E scenario in
`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §5.2.

## Context

FramePilot stamps a transition on **butt-joined** clips: `add_transition` writes a
`transition` effect on the incoming clip (and, for a centre/end alignment, a `transition_out`
effect on the outgoing one). It never overlaps the two clips, and it never borrows handle
material. With the default `start` alignment the whole ramp therefore sits *after* the cut, on
a clip whose neighbour has already ended.

Every surface that composites a frame then drew the reveal over nothing:

- **Render** — `_apply_catalog_transition` multiplies the incoming clip's alpha by the pass's
  `revealed` mask, and `CompositeVideoClip(..., bg_color=(0, 0, 0))` has no other layer at that
  instant. At the first frame of a dissolve `revealed ≈ 0`, so the frame is black.
- **DOM monitor** — every slot except the visible one is painted at `opacity: 0`, and the
  visible slot's opacity is scaled by the same envelope.
- **Canvas monitor** — the engine draws exactly one source per frame onto a cleared canvas.

So a "cross dissolve" dissolved up from black, a whip pan (`travel: 0.85`) whipped in over
black, and a wipe wiped in from black — at every cut in the programme, in preview *and* in the
deliverable.

This is what consumed the captured run. Its perceptual reviewer reported
`Unexpected black frame(s)` at frames 90, 195, 300, 405, 525, 615 and 735 — exactly the seven
cut times (3.0, 6.5, 10.0, 13.5, 17.5, 20.5, 24.5s at 30fps) — steered the agent to fix them
three separate times, and could never be satisfied, because no proposal the agent could make
was the cause. Two of the run's five turns went into that loop.

## Decision

A transition ramp gets an **under-layer**: the picture of the clip on the other side of its
cut, for exactly the length of the ramp, framed and graded as that clip is on the timeline.

- The render builds it from that neighbour's own **handle material** — the outgoing shot
  continuing past its out-point for an `in` ramp, the incoming shot's pre-roll for an `out`
  ramp. `transition_underlay_window` decides whether a ramp needs one (the two clips must
  really be adjacent); `_underlay_layer` builds it and places it *beneath* the ramping clip.
- When the neighbour has **no handle left** — it is cut to the very edge of its asset — its
  edge frame is held for the ramp instead. Under a sub-second ramp a held frame reads as
  continuous; black reads as a flash.
- The DOM monitor paints the slot holding that neighbour underneath the ramp, parked on its
  last frame. Separately, the ramp now only modulates the slot that actually *holds* the
  transitioning clip: while the incoming slot has no decoded frame yet the monitor holds the
  outgoing shot, and fading that down was the same defect from the other side.
- The canvas monitor keeps the last frame it painted before the cut and blits it under the
  ramp, but only when that frame really belongs to the previous segment
  (`preview/held-frame.ts`) — after a seek, a frame from elsewhere in the timeline would
  dissolve out of a shot the editor never cut from, which is a worse lie than the black.

### Why not change the timeline instead

The alternative was to make `add_transition` overlap the two clips for real — extend the
outgoing clip into its handle and let two clips coexist on one track. That is the classic NLE
model and it is probably where this ends up, but it needs the validator's
one-clip-per-time-per-track invariant relaxed, a schema migration, and a rethink of every
operation that reasons about adjacency. This change reproduces the *visible* semantics of that
model with no schema change, no new invariant, and no new operation, which is the smallest
thing that makes the existing feature correct.

### Why the render is not simply "fit, then centre" for crop either

The same run reported the mirror-image defect for `crop`: the engine crops and then scales the
cropped picture to the canvas, so a 9:16 slice of 16:9 footage exports full-bleed, while both
monitors masked the crop in place over a letterboxed frame (`clip-path: inset`, carried as a
documented deferral). The monitor was showing something strictly *worse* than what would ship,
which is the wrong direction for the render-vs-preview rule to fail in: the editor reported
"extremely many black spaces around" the picture, and the agent then wrote compensating scale
keyframes (3.2×, then 1.78×) into the project — which the render applies **on top of** its own
fill scale. A preview artefact became real over-zoom in the deliverable.

`preview/crop-fill.ts` now holds that arithmetic for both monitors, in the same jsdom-testable
split `picture-transform.ts` uses. A crop whose aspect does not match the frame's still
letterboxes, because the engine centres a mismatched crop rather than showing pixels the
export drops.

## Consequences

Transitions and crops look the same in the monitor and in the export. The perceptual reviewer
stops reporting a defect no edit could fix, which frees the steering channel for findings the
agent can actually act on (and see ADR 0136 for the cap that keeps an unfixable finding from
consuming a run in the first place).

**Evidence.** `engine/python/tests/test_render_compiler.py`:

- no sampled frame across the whole ramp of a cross-dissolve, glitch, circular wipe, whip pan
  or pixel dissolve has a black ratio ≥ 0.98 (the reviewer's own threshold);
- the mid-ramp frame of a red→blue dissolve carries measurable red *and* measurable blue —
  stronger than "not black", because it pins that the under-layer is the neighbour's real
  picture rather than filler;
- a neighbour with no handle at all still shows, held, under the ramp;
- a centred transition differs from a start-aligned one before the cut, and neither is black.

Two existing tests encoded the old behaviour and were rewritten: both sides of the cut came
from **one solid-colour asset**, which cannot tell a working transition from a black flash, and
one asserted that a centred ramp is *darker* before the cut — true only because it was fading
to black. 2596 engine tests and 2428 web-editor tests pass.

## Limitations

The monitors hold a frame where the render plays handle material. For the sub-second ramps
short-form editing uses that reads as continuous, and the deterministic render remains the
authority; a monitor that decoded the neighbour's handle concurrently would need a second
decode pipeline in the canvas engine and a second playing element in the DOM one, which is not
justified by anything observed yet.

Legacy (pre-catalog) transition kinds share the same under-layer, since the defect was in the
composite rather than in the pass. `add_transition` still does not overlap clips, so a
transition longer than half the shorter shot is still clamped rather than borrowing more.
