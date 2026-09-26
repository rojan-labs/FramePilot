# ADR 0192 — Loops are keyframes, and a moving exit plays its entrance backwards

- **Status:** Accepted.
- **Date:** 2026-09-26
- **Relates to:** ADR 0191 (an element is an overlay), ADR 0189 (a still is a picture layer),
  ADR 0190 (shapes are drawn by the engine), ADR 0183 (cutaway edges), plan
  [`plan/elements/`](../../plan/elements/README.md) (EL7, 05 §5).

## Context

Stickers, shapes and titles need what every editor gives them: a way in, a way out, and a loop
while they are on screen (CapCut's In · Out · Loop). The product already had the pieces for the
first two, layer transitions (`add_layer_transition`, the transition catalogue and its passes in
both renderers), and a transform pipeline that renders keyframed size, position, rotation and
opacity for every layer kind. Two gaps stood between those pieces and graphic animation.

- **Exits vanished.** On an exit, both renderers kept only the kind's reveal mask and faded the
  layer by it. For a dissolve or a wipe that is the exit; for a slide, a zoom or a spin the mask
  is the whole frame from the first instant, so the layer disappeared at once. The op therefore
  refused every exit but a dissolve or a wipe, and only on video layers.
- **Loops had no home.** A loop is motion that repeats over the clip. Stored as a new effect, it
  would need an evaluator in the compiler and in the monitor, pinned to each other, and a schema
  change.

## Decision

**In and Out are layer transitions; an exit that moves plays its entrance backwards.**

- A layer transition treats graphics layers as well as video layers.
- The transition catalogue lists the kinds that close as a mask on an exit
  (`TRANSITION_EXIT_BY_MASK`, generated into the engine's copy of the catalogue): exactly the set
  exits were limited to before, so no existing exit renders differently.
- Every other kind, as a layer's own exit (a `transition_out` with no partner clip), plays its
  entrance backwards in time: at exit progress `p` the renderers draw the entrance at
  `ease(1 − p)`. A slide leaves the way it came, and an entrance that eases to rest leaves by
  easing away. The frame plan marks such an exit `reversed`, with `eased` already computed
  backwards, and the compiler and the monitor both honour it (`test_layer_exit_reversed.py`
  pins exit(p) = entrance(1 − p)).
- The outgoing half of a cut is untouched: the next shot animates over it.
- The curated In/Out set is named by the way the element travels, so "Slide left" leaves
  travelling left: that exit is the slide that enters from the left, reversed.

**Loops are keyframes, written by one builder.** `loop-motion.ts` writes pulse, float, wiggle,
bounce, spin and blink as ordinary keyframes over the clip's span, the way `track-follow.ts` plans
follow keyframes. There is no new effect type, no evaluator in two runtimes and no schema bump.
Each loop keyframe's id records its preset, period and amount, so the loop can be read back,
replaced or cleared. The builder will not loop over a property the user has already animated.

**One builder for both hands.** `element-animation.ts` turns an In/Out/Loop request into one
reversible set of operations. The Inspector's Animation section and the agent's
`set_element_animation` both call it. A title's old In/Out params are read, and cleared when its
In or Out is set: they are no longer written.

## Consequences

- Graphic animation renders with the same parity guarantees as every other layer: four oracle
  rows (a sticker popping in, a shape sliding out, a sticker pulsing, a shape wiggling) hold the
  monitor to the export.
- **Trade-off:** loop keyframes cover the clip as it was when the loop was set. Lengthening the
  clip leaves the loop stopping early until it is applied again. The Inspector says so and offers
  **Re-apply**, `clipLoop` reports `coversClip`, and the skill tells the agent to set the loop
  again after lengthening a clip. Revisit if it bites: the fix would be a loop effect evaluated at
  render time, the cost this decision avoided.
- b-roll exits stay a dissolve or a wipe, now as an explicit editorial rule in the cutaway
  planner rather than a refusal: a full-frame shot sliding back off the speaker reads as a
  rewind.
- Rejected: a `loop` effect with its own evaluator (two runtimes, one more parity surface, a
  schema change); refusing moving exits (the most-asked graphic exits); a separate animation op
  (layer transitions and keyframes already undo, validate and render).
