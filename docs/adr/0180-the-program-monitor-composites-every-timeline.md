# ADR 0180 — The program monitor composites every timeline; preview eligibility is not a gate

- **Status:** Accepted. Amended 2026-09-25: the layer compositor is now the default in every
  build, production included (see "Amendment" below). RD3 still deletes the legacy path.
  Amended 2026-09-27 (playback never waits on text) and 2026-09-29 (the agent's overlay
  refusal is lifted).
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
   decision.** Today: the matte pass (BR5); the v22 multi-mask stack moved to the exact
   rasteriser in MK3 (ADR 0178 amendment). The baseline JSON can only shrink.
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
  AI layer and is **not** changed here. (The 2026-09-29 amendment below makes it.)
- Preview correctness is now a CI measurement (PX4). A compositor change that breaks a passing
  case fails the job; one that fixes a listed case fails it too until the baseline is shrunk.

## Amendment (2026-09-25): every build composites, and styled captions are in the frame

The maintainer asked for "100% parity on preview/export". Two things stood between the oracle's
result and what a user sees:

1. **Release builds ran the legacy monitor.** The production default was held back "until the
   parity work is complete" (CHANGELOG). Every oracle row passes. A packaged release on the old
   monitor would show the flat edit list and the DOM fallback, which the inventory routes 56 of
   80 matrix rows to and the oracle never measured. Unset, `VITE_FRAMEPILOT_PREVIEW_COMPOSITOR`
   now means `layers` in every build; `legacy` remains an explicit kill switch until RD3 deletes
   it.
2. **Styled captions were drawn as HTML over the canvas**, not in the frame. The oracle reads the
   canvas, so the path nearly every real caption takes (67 of 68 templates are styled) was never
   compared, and two divergences shipped through it (run `fb90e58d`: EQ20 placement, EQ21 wrap
   width). The monitor now composites the engine's own caption layer, sampled at the frame's time
   (`POST /preview/text-raster` with the cue's styles, words and span, built by
   `caption_layer_for`), above the frame effects, in the clip's blend mode, with a frosted chip
   blurred through the same Pillow `GaussianBlur` port. Seven oracle rows cover placed, animated,
   frosted, rotated, blended and overridden captions and a caption over an effect lane. All pass,
   six pixel-identical, and the effect-lane row fails at 26 dB when captions go back under the
   effects.

The browser build keeps the HTML caption layer when no engine is reachable, and says the text is
approximate, as decision 4 already allows for titles.


## Amendment (2026-09-27): playback never waits on text; paused frames are exact

The styled-caption amendment above made every caption an engine raster sampled at the frame's
time. All 68 templates are time-varying (`caption_style_is_animated` is true for each), so that is
a raster per frame. The first implementation asked for them one frame at a time, 12 frames ahead,
behind a first "probe" request per cue, and `compose` returned "not ready" — holding the whole
picture — whenever any text raster was still out. Measured on the engine at the monitor's 720p:
building a cue's layer costs 5 ms (worst 120 ms) and sampling a frame 7 ms (worst 23 ms), and each
answer was about 1 MB of base64 JSON. The monitor froze at nearly every cue, and one sidecar
timeout swapped the styled caption for the unstyled fallback for ten seconds.

**Decision.**

1. The engine samples a cue's frames in windows from one cached build of its caption layer
   (`POST /preview/caption-frames`, binary, each distinct raster once; a cue of 84 frames has a
   median of 12 distinct rasters across the templates). Each frame is byte-identical to the
   single-frame route; a test holds both routes and a fresh build to that.
2. The monitor fetches caption windows 2 s ahead of the playhead, titles and shapes once.
3. **Playback never waits on a text raster.** A title or shape that has not arrived is left out of
   that frame; a styled caption frame that has not arrived is drawn with the nearest held frame of
   the same cue. Both are counted (`debugStats().textSkipped`, `textStale`, logged on pause).
4. **A paused frame is exact.** It waits for its own rasters (at most 1.5 s, then it is shown
   with the text it has — a caption's nearest held frame of its cue, else none — and redrawn when
   the late text lands; the seek resolves only after that redraw, so a parity read waits for it),
   and pausing re-presents the frame that way, at full resolution. The PX4 oracle reads paused
   frames, so what it measures is unchanged.
5. Refusals and outages are told apart: a 422 falls back to the approximate raster at once; an
   unreachable or slow sidecar is asked again after a second and falls back only after three
   failures in a row.

**Why not keep holding the picture.** Point 3 relaxes "a wrong picture is never shown" for text
during playback only, the same way load shedding (PX2.8) already lowers resolution during
playback. A caption one word-state late for a few frames is a smaller error than a frozen monitor,
and it is never what the user stops on. Holding the frame made the monitor unusable exactly where
captions are, which is where users look hardest.

## Amendment (2026-09-29): the agent layers picture over picture

The agent still refused a scaled, positioned, cropped, faded, blended or masked picture layer
over other picture, and its tool descriptions and skills still said why: "the preview can only
show one picture layer at a time". The maintainer's desktop run `88c8b27d` blocked three brief
items on that sentence ("THE ROAD" behind the ridge, a mask-reveal through a car pillar, a 3-up
split screen) and answered "every shot breaks the 115% scale limit" with "the blurred-fill
treatment, which this preview can't composite". Decision 1 above made that false in every build
on 2026-09-25; the refusal outlived its reason. The maintainer asked for the gaps to be closed end
to end, which is the editing decision this ADR's consequences left open.

**Decision.**

1. **Any picture placement over picture is layered in front** (`createPicturePlacer`,
   `ai-sdk/domain-tools/picture-layers.ts`): `add_clip`, `add_clips` and `move_clip` put a
   see-through or scaled layer on a lane in front of what it covers, exactly as they already did
   a full-frame cutaway. The later transform, opacity, blend and mask edits on such a layer were
   never gated.
2. **`add_clip` takes the geometry of a layered look**: `crop`, a rect of the source or `null` for
   the whole picture fitted inside the frame. With it, the placer writes no cover crop over the
   caller's choice, and the same shot at the same moment is not refused as an invisible duplicate
   when its crop differs (a blurred-fill foreground over its cover-cropped copy).
3. **`apply_color_grade` takes `type: "blur"`** (`params.amount`, 0..0.25), the clip blur the
   Inspector already writes, so a blurred-fill background needs no new tool.
4. **What stays refused, and why it is still real:**
   - a FULL-FRAME placement that would swallow a cutaway whole (`hides_a_cutaway`, run
     `137d8fd0`): that clip would never be seen. A window never triggers it, because a split
     panel lands centred and is moved afterwards;
   - the same frames at the same moment through the same crop: invisible work;
   - `add_stock`'s placement (`cutawaysOnly`): it places a full-frame cutaway at a moment and
     takes no geometry, so a stock clip that cannot be shown to hide the footage (an unmeasured
     shape) would leave it showing round its edges. The refusal names the hole it could cut and
     the route that layers it on purpose: the bin, then `add_clip`. The Stock panel's one-click
     **Add** keeps its occupancy rule for the reason `buildAddStockOps` gives: a person clicking
     Add did not ask to stack.
5. **Coverage stays a relation (ADR 0170), and now means "hides".** The Critic's
   `hidden_picture`, `visiblePictureSeconds`, the "hidden behind picture" lane digest and the
   burial check count a clip in front as covering only when it hides what is behind it; a
   covered clip with keyframes can be anywhere, so only a frame-filling layer hides it.
   `reframe_coverage` does not call a fitted clip letterboxed when frame-filling picture sits
   behind it for its whole span. The eval rubric's `stacked-picture-is-previewable` became
   `stacked-picture-is-visible`.

**Evidence.** `layered-picture-recipes.test.ts` builds a blurred fill and a 3-up split with the
agent's real tool calls, validates and applies every patch, undoes the chain and asks the Critic;
`test_layered_picture_render.py` renders the same projects through `grab_frame`. Blurred fill at
360x640: the bars are picture (mean 126) and soft (mean horizontal step 0.16, std 2.4; 8.3 without
the blur), the band is the whole sharp shot (21.9) on rows 219-420, exactly the 202.5-row fit.
The 3-up puts each shot in its own third, edge to edge.
