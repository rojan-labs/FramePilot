# ADR 0180 — The program monitor composites every timeline; preview eligibility is not a gate

- **Status:** Accepted for the layer compositor (`VITE_FRAMEPILOT_PREVIEW_COMPOSITOR=layers`,
  the default in dev and test builds). The production default flips at RD3, which also deletes
  the legacy path.
- **Date:** 2026-09-17
- **Supersedes:** the **gating role** of ADR 0169 (a full-frame cutaway goes in front) and
  ADR 0170 (coverage is a relation between the layers): `canvasPreviewEligible`,
  `webCodecsPreviewEligible` and the DOM `PreviewPlayer` fallback as the way the desktop program
  monitor decides what it can show. Their geometry facts are not superseded.
- **Relates to:** ADR 0048 (multi-layer compositing at export), ADR 0178 (mask stack),
  plan [`09-PREVIEW-EXPORT-PARITY.md`](../../plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md)
  (PX2 compositor, PX3 delete the gates, PX4 oracle), evidence
  [`PX4-BASELINE.md`](../../plan/background-removal-ai/PX4-BASELINE.md).

## Context

The WebCodecs monitor used to draw one picture at a time from a flat edit list. ADRs 0169 and
0170 made that honest: a predicate decided whether a timeline's stack reduced to "the front
clip hides everything behind it", and anything else went to the DOM `PreviewPlayer`, which
drew stacks, masks, blends, keyframes and text with CSS and so disagreed with the export in
ways no test measured. 25 of the 43 original parity cases were routed there.

PX2 replaced the flat edit list with a layer compositor driven by `framePlanAt`, the same
per-frame decision list the export compiles (`render/frame_plan.py`, pinned by the frame-plan
vectors). It reproduces the export's integer arithmetic (swscale, Pillow resize, rotate,
GaussianBlur and alpha composite, the frame-effect and transition passes, the engine's own
Pillow text rasters on the desktop) and the PX4 oracle compares it with `frame_grab` pixel for
pixel in CI. At CI run 35172331641, 43 of 48 cases pass the unchanged gates (PSNR ≥ 40 dB,
≥ 99.5% of pixels within 8/255, sentinel layers exact, presented pts equal to the plan).

## Decision

1. **With the layer compositor, the desktop program monitor composites every timeline.** No
   eligibility predicate is consulted and the DOM `PreviewPlayer` is never mounted as the
   program monitor (`Editor.tsx`: `layerCompositorEnabled()` short-circuits the gate;
   `WebCodecsPreviewPlayer` treats every timeline as eligible).
2. **A row that does not match yet is a listed oracle failure with a reason, never a routing
   decision.** Today: the v22 multi-mask stack (MK3) and the matte pass (BR5). The baseline
   JSON can only shrink.
3. **The browser build shows "Preview unavailable for this timeline in the browser"** when it
   cannot composite (no WebCodecs, no WebGL2, a codec the browser lacks). Browser parity is
   deferred; the desktop is product focus #1. On the desktop the specific error stays, because
   the user can act on it.
4. **Text is approximate only visibly.** Without the engine the canvas rasteriser is used and
   the monitor says "Preview text approximate".
5. **The geometry facts of 0169/0170 stay true** (a fitted source leaves transparent bars; a
   front clip hides the one behind only when its fitted rect contains it). They are now frame
   plan and pixel cases (`tests/fixtures/frame-plan/geometry.json`, `layering.json`), not a gate.

## Why not the alternatives

- **Keep the gates and widen them.** Every widening was a new predicate that had to agree with
  the compiler by inspection; 0170 exists because the first widening was wrong. The oracle
  measures agreement instead of arguing it.
- **Keep the DOM player for "rare" timelines.** Masks, blends, keyframes and text are not rare,
  and a second renderer with different semantics makes the monitor misleading exactly where an
  editor looks hardest.

## Consequences

- `canvasPreviewEligible`, `webCodecsPreviewEligible`, `pictureSegments` and the DOM program
  monitor remain only behind the legacy kill switch and are deleted with it at RD3.
- The agent's picture placement rules from ADR 0169 (front-lane placement, refusing stacked
  placements the old monitor could not show) were justified partly by the preview. That half of
  the justification is gone; whether to relax those refusals is an editing decision for the
  AI layer and is **not** changed here.
- Preview correctness is now a CI measurement (PX4). A compositor change that breaks a passing
  case fails the job; one that fixes a listed case fails it too until the baseline is shrunk.
