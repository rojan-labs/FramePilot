# 10 — Professional masking

> **Scope decision (maintainer, 2026-09-16):** "on this same work we need to build a professional
> editor level masking functionality as well; AI should be able to do masking as well; everything
> should be precise, accurate, professional and production ready." Recorded here per CLAUDE.md §5 so
> later agents do not shrink it back to the background-removal slice. The product-scope gate still
> applies **inside** the scope: every phase ends in a usable, tested editor capability, not a schema
> or a backend.

## Reference bar

The target is feature parity with the masking editors professionals already use (Premiere Pro
opacity/effect masks, DaVinci Resolve Power Windows + Magic Mask, After Effects masks + Roto Brush,
Final Cut Pro shape/colour masks), for everything listed below. Anything a professional expects that
is **not** listed is named in [`08`](./08-DEFERRED-AND-RISKS.md), so the gap is visible.

## Current state (audited 2026-09-16 at `8889d605`)

| Area      | Today                                                                                                                                               | Gap                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Shapes    | `mask` effect: rectangle, ellipse, polygon (`render/masks.py`)                                                                                      | No bezier paths, no rounded rectangle, no rotation, no freehand                               |
| Placement | `addMaskPatch` hardcodes `bounds = {0.2, 0.2, 0.6, 0.6}` (`patch-builders-base.ts:1372`)                                                            | No on-canvas drawing or handles, no numeric fields                                            |
| Count     | Compiler and preview take the **first** `mask` effect (`compiler.py:675`, `clipMaskEffect`)                                                         | One mask per clip; no add/subtract/intersect                                                  |
| Edges     | `feather` = Gaussian blur of `feather × min(w,h)`                                                                                                   | No inner/outer feather, no expansion, no per-vertex feather                                   |
| Animation | Effect keyframes: one number per property, **timeline-relative** seconds                                                                            | No path (vertex) animation; `applySplit` does not re-base effect keyframes (latent bug)       |
| Tracking  | Tracking Lite pack; `apply_tracked_mask` steers **bounds** keyframes; Inspector "Measure and follow"                                                | Cannot track a path's shape; no perspective track applied to a mask; no frame-by-frame review |
| Scope     | Masks only cut clip alpha                                                                                                                           | No effect or grade limited to a mask (face blur, sky grade)                                   |
| AI        | `add_mask` (shape only, fixed bounds), `track_object`, `detect_subjects`, `track_subject_automatically`; `generate_mask` registered **unavailable** | See [`11`](./11-AI-MASKING.md)                                                                |
| Preview   | `clip-mask.ts` mirrors the engine for one shape mask                                                                                                | Covered by the [`09`](./09-PREVIEW-EXPORT-PARITY.md) compositor                               |

## Capabilities (all ship; the phase order is in [`07`](./07-TASKS-AND-EVIDENCE.md))

### Mask stack per clip

- Any number of masks per clip, evaluated top to bottom. Each mask has: **name**, **colour** (overlay
  only), **mode** (`add`, `subtract`, `intersect`, `difference`, `lighten`, `darken`), **opacity**,
  **invert**, **expansion** (px, ±), **feather** (inner px, outer px, falloff curve), **enabled**, **locked**.
- **Kinds:** `rectangle` (centre, size, rotation, corner roundness), `ellipse` (centre, radii, rotation),
  `path` (closed cubic Bezier with per-vertex in/out tangents, corner/smooth/broken vertex types and
  optional per-vertex feather), `matte` (a raster AI mask from the pack; see [`02`](./02-WORKER-PACK.md)).
  `key` (a deterministic colour/luma qualifier: hue, saturation and luma ranges each with softness,
  plus despill for green/blue screen; this covers chroma key and secondary-grade qualifiers without a model).
  Freehand drawing produces a `path` by curve fitting (Schneider's algorithm, implemented in-repo;
  potrace is GPL and is not used).
- **Target:** each mask belongs to one target, either **clip alpha** (cut-out, vignette, split screen)
  or **an effect instance** on the clip (blur, colour grade, sharpen, any catalog effect). The effect
  is applied to the frame and mixed with the original by the mask's alpha. This covers face blur,
  secondary colour correction and spot fixes, with no new effect kinds.

### Animation

- All scalar properties (opacity, expansion, feathers, rectangle/ellipse geometry, rotation, roundness)
  animate with the existing keyframe easing set (`linear`, `ease-*`, `hold`, `bezier` + handles, ADR 0089).
- **Path keyframes:** a whole-path snapshot per keyframe (vertices + tangents), interpolated
  vertex-to-vertex with the same easing set. Adding or removing a vertex applies to every keyframe
  (inserted at the same parametric position), so vertex counts always match. The first vertex is
  explicit and can be set, because a wrong correspondence makes a path "swim" between keyframes.
- **Keyframe time is clip SOURCE time.** A mask stays glued to the picture through trim, slip, split,
  ripple, speed changes and speed ramps. This removes the timeline-relative split bug for masks by
  construction. `applySplit` is still fixed for other effect keyframes in MK1.

### Tracking

- Methods: **position**, **position + scale + rotation**, **perspective (planar homography)**, and
  **point-cloud/shape** (tracks the path's own vertices for non-rigid shapes), from the Tracking Lite
  pack (`tracking.point`, `tracking.region`, `tracking.planar`).
- Track **forward, backward, one frame, or to the clip edge**, starting from any frame.
- **Interactive feature points:** before tracking, the editor can see the detected feature points
  inside the mask, add points on texture the tracker should follow, and exclude regions (for example,
  a hand passing in front) with an exclusion mask.
- The track is stored as a digest-pinned **transform track** artifact (one 3×3 per source frame,
  `.framepilot-derived/tracks/<key>/`, project-owned like mattes), not as thousands of inline
  keyframes. It is applied **on top of** the mask's own animation, so the editor can still keyframe
  corrections relative to the tracked motion.
- **Review:** the tracker reports per-frame confidence. Low-confidence ranges go on the same review
  list as mattes. The editor fixes a frame by adjusting the mask there; that frame becomes a
  constraint, and the track re-runs from it in both directions until it meets confidence again.

### Editing tools (monitor + Inspector)

- **Monitor toolbar** (visible when a picture clip is selected and the Mask tab is open):
  Select · Rectangle · Ellipse · Pen · Freehand · Split · Mirror · Gradient · Shapes (presets) · Track matte (pick a clip or track) · Key (eyedropper) · **AI Object** (click to include/exclude) · **AI Brush**
  (paint to add/remove region; segmented, not painted pixels) · **Remove background** (AI preset) ·
  View (Overlay / Mask only / Checkerboard alpha / Off) · Zoom (fit, 100–800%, pixel grid at ≥ 400%).
- **On-canvas editing:** drag vertices and tangents (Alt breaks, Cmd converts corner/smooth), click a
  segment to add a vertex, Delete removes, marquee multi-select, transform box (move/scale/rotate
  about an anchor), dashed outer-feather and inner-feather handles, expansion handle. Arrow keys nudge
  1 px, Shift+arrow 10 px. Snapping to frame edges, centre and other masks' vertices (toggle).
  Sub-pixel positions are kept; nothing is rounded to integer pixels.
- **Inspector → Mask tab:** mask list (drag to reorder; eye, lock, colour chip, mode menu, invert),
  and for the selected mask: target, opacity, expansion, feather inner/outer + falloff, geometry
  fields with typed numeric input in px, per-property keyframe toggles with previous/next keyframe
  navigation, tracking controls with method, direction and progress, and the review list.
- **Effects:** every effect row gets "Add mask", which creates an effect-target mask and opens the
  drawing tool.
- **Timeline:** mask keyframes appear in the clip's keyframe lane, grouped per mask, draggable in time.
- **Clipboard and presets:** copy/paste masks between clips (geometry scaled to the target source by
  normalised coordinates), duplicate a mask, and save/load mask presets per project.
- **Everything is undoable** and every change is a typed operation.
- **Hover highlight for AI Object:** hovering the monitor shows the object that a click would select
  (single-frame segmentation from the cached frame embedding), as in Premiere Pro's Object Mask. Nothing
  is added until the click.
- **Performance budgets** (in `06`): pointer-to-paint ≤ 16 ms while editing a 200-vertex path on 4K
  footage; hover highlight ≤ 100 ms after the frame embedding exists; click-to-mask ≤ 300 ms.

## Schema v22: the mask stack (needs MD-1)

`mask` effects and the planned `matte` effect are **replaced** by one first-class field. There is one
alpha model, not two.

```ts
Clip.masks: MaskLayer[]              // ordered, top first

MaskLayerBase = {
  id, name, color, enabled, locked,
  target: { kind: 'alpha' } | { kind: 'effect', effectId },
  mode: 'add'|'subtract'|'intersect'|'difference'|'lighten'|'darken',
  opacity, invert,
  expansionPx, featherInnerPx, featherOuterPx, falloff: 'linear'|'smooth'|'gaussian',
  featherModel: 'distance' | 'gaussian-legacy',   // legacy only for migrated v21 masks
  keyframes: SourceTimeKeyframe[],                 // scalar properties; time = source seconds
  tracking?: { artifact: { key, sha256 }, method, referenceSourceTime, constraints: SourceTimeRef[], review },
}
MaskLayer =
  | MaskLayerBase & { kind: 'rectangle', cx, cy, width, height, rotation, roundness }
  | MaskLayerBase & { kind: 'ellipse', cx, cy, rx, ry, rotation }
  | MaskLayerBase & { kind: 'path', firstVertex, pathKeyframes: [{ sourceTime, easing, handles?, vertices: [{ x, y, inX, inY, outX, outY, type, featherPx? }] }] }
  | MaskLayerBase & { kind: 'matte', artifact, prompts, review, edgeShiftPx, decontaminate }
  | MaskLayerBase & { kind: 'key', model: 'hsl'|'rgb'|'luma'|'3d', ranges | samples3d, softness, despill: 'none'|'green'|'blue', shadowRetention, finesse }
  | MaskLayerBase & { kind: 'linear', originX, originY, angle, softnessPx }                 // half-plane split (CapCut Split, Resolve linear window)
  | MaskLayerBase & { kind: 'band', originX, originY, angle, widthPx, softnessPx }          // mirror / filmstrip
  | MaskLayerBase & { kind: 'gradient', shape: 'linear'|'radial', startX, startY, endX, endY, curve } // graduated falloff
  | MaskLayerBase & { kind: 'layer', source: { clipId } | { trackId }, channel: 'alpha'|'luma'|'inverted-alpha'|'inverted-luma', finesse } // track matte, text-as-mask

MaskLayerBase gains:
  space: 'source' | 'frame',   // 'source' (default) moves with the picture; 'frame' is fixed to the output frame (adjustment lanes)
  // matte and key kinds also carry finesse: { denoise, morphOpenPx, morphClosePx, shrinkGrowPx, blurPx, inOutRatio, cleanBlack, cleanWhite }
```

`EffectLayer` (schema v13 adjustment lanes) gains `masks: MaskLayer[]` with `space: 'frame'`, so a mask can
limit an adjustment layer exactly as in Premiere Pro and Resolve.

**Shape presets** (heart, star, n-gon, speech bubble, arrow, rounded frame) are path generators in
`editor-core`, not kinds: choosing one inserts an ordinary `path` mask the editor can then edit.

**Edge styles for cut-outs** (stroke/outline, outer glow, drop shadow) are catalog effects that **read**
the clip's alpha-target mask stack and draw outside it, so a subject cut-out gets the CapCut-style
outline with no new mask kind. They ride the existing effect catalog and parity tests.

**Track reuse:** a transform-track artifact can drive other masks, a text clip's transform or an overlay's
transform (`use_track`), so a title can follow the subject the mask tracked.

- **Units:** geometry in **display-corrected source pixels**: the source picture after rotation
  metadata and pixel-aspect-ratio correction, before crop. That is what the editor sees and types.
  Anamorphic and rotated phone footage therefore draws undistorted. Frame-space masks use output-frame
  pixels. Adding a mask requires probed source dimensions
  (`Asset.media.width/height`, optional since v21; the probe also records `pixelAspectRatio` and
  clockwise `rotation`, optional in v22, absent = square and 0; MK1.9). Without them the op refuses with "Measure this
  media first", never guessing a size.
- **Migration safety:** before migrating, the desktop app writes `<project>.v21.backup.fp.json` and
  keeps it until the user deletes it. A project with a newer schema opened in an older app refuses with
  "Update FramePilot to open this project"; it is never downgraded or partially loaded.
- **Storage size:** path keyframes are stored as flat number arrays (`[x, y, inX, inY, outX, outY, …]`)
  with the vertex type as a parallel small-int array, so long roto work stays small. Budget in `06`.
- **Migration v21 → v22** (round-trip and parity tests, `SCHEMA_VERSION` imported by fixtures):
  - The first `mask` effect → one `alpha` mask of the same shape, bounds → pixels, polygon → path
    with zero tangents, effect keyframes → source-time keyframes (through the clip's speed/ramp
    mapping), `featherModel: 'gaussian-legacy'` so **existing projects export byte-identically**
    (render golden asserts it). The migrated mask also keeps the v21 spec verbatim (`legacySpec`,
    MK2.5): pixel centre + size is not one-to-one with v21's fractions, so the export draws from the
    stored spec while it still maps onto the geometry (ADR 0178 MK2.5 amendment).
  - Any further `mask` effects (never rendered today) → migrated as `enabled: false` with a migration
    note, so nothing that was invisible suddenly appears.
  - Tracked masks (`${clipId}__mask`, `apply_tracked_mask` bounds keyframes) → source-time keyframes
    on the migrated mask, preserving motion.
  - The `mask` effect type is removed from the v22 validator.
- **Validator:** mask ids unique per clip; effect targets exist on the clip; path has ≥ 3 vertices and
  equal counts across path keyframes; keyframe times within the clip's source range (with a stated
  handle); tracking and matte artifacts cover the clip's source range; geometry finite. Every message
  carries a remedy and no varying magnitude (the guard-key lesson).

## Operations (`packages/editor-core`), all with `apply` + `invert`

`add_mask`, `remove_mask`, `update_mask` (scalar fields), `set_mask_path` (one path keyframe),
`add_mask_keyframe` / `remove_mask_keyframe` / `move_mask_keyframe`, `insert_mask_vertex` /
`remove_mask_vertex` (applied to all path keyframes), `reorder_masks`, `set_mask_target`,
`apply_mask_tracking` / `clear_mask_tracking`, `use_track` (drive another mask, text or overlay
transform from a track artifact), `set_mask_space`, `add_effect_layer_mask`, `review_mask` (approve ranges and lock frames; mattes
and tracks share review; a matte is added and changed through `add_mask` / `update_mask` like any other kind), `paste_masks`, `add_text_behind_subject`.

The existing `add_mask` / `track_object` / `apply_tracked_mask` operation types are **re-specified on
the new model** (same names where the meaning holds) so the AI layer and UI converge on one set.
`packages/ai-sdk` and `apps/web-editor` stop building raw mask ops and go through these (memory:
`ui-bypasses-editor-command`).

## Rasteriser: one algorithm, two implementations, bit-identical

Parity by tolerance is not enough for mask edges, so both sides run the **same deterministic algorithm**:

1. **Flatten** Bezier paths adaptively to a fixed tolerance (0.02 source px) with the same subdivision
   rule. Rectangles with roundness and ellipses are generated as Beziers first, so there is one path type.
2. **Coverage:** exact area coverage per pixel by signed-area accumulation (the font-rasteriser
   method: no supersampling, no approximation).
3. **Distance field in the feather band:** exact Euclidean distance from pixel centre to the flattened
   segments, with per-vertex feather interpolated along each segment. The distance is signed and
   shifted by expansion. Alpha = falloff(distance / feather) outside the zero-feather case; coverage
   is used at zero feather.
4. **Combine** the mask stack by mode, then quantise once with round-half-even.
5. Apply the tracking transform to vertices **before** flattening (never warp the rasterised image).

**Determinism rules (required for byte equality, found in the production audit):**

- float64 throughout; no float32 anywhere in the pipeline.
- Coverage accumulation in integer fixed point (Q16.16 area units per pixel), converted to float64 once.
- All sums accumulate **left to right, row by row**. No `np.sum`/`np.add.reduce` over an axis
  (pairwise/SIMD summation changes the order), and no reordering by the JS engine (plain indexed loops).
- No fused multiply-add. `sqrt` only (correctly rounded on both). No `exp`/`pow`/`sin` in per-pixel
  paths: falloff curves are polynomials or a 4096-entry table generated once by Python and shipped to both
  sides as data.
- Curve flattening uses the same fixed recursion order and the same float64 split formula.
- The vectors run in CI on macOS arm64, Windows x64 and Linux x64 for both implementations.

- Engine: `render/mask_raster.py` (numpy, band-limited so cost scales with edge length, not frame area).
- Preview: `apps/web-editor/src/preview/masks/mask-raster.ts` runs the same algorithm on the CPU into a
  texture at preview resolution, caching static masks by semantic signature. A WASM build is used only
  if PX5 shows the TS version misses budget, and it must pass the same vectors.
- **Vectors:** `tests/fixtures/mask-raster/*.json` holds paths, parameters and expected quantised
  alpha, generated by Python and asserted **byte-equal** by TS at 3 resolutions. A reference
  64×64-supersampled coverage checks the algorithm itself (≤ 1/255 error).
- `gaussian-legacy` keeps today's blur path for migrated masks only.

## Engine and preview composition

- Engine: `render/masks.py` becomes `render/mask_stack.py` and evaluates the stack at a source pts:
  alpha-target masks feed `_attach_mask`, and effect-target masks mix the effect's output with the
  input by mask alpha inside the effect application. The order is pinned in the frame plan.
- Preview: a `mask-stack` pass in the N-layer compositor ([`09`](./09-PREVIEW-EXPORT-PARITY.md)), with
  effect passes taking an optional mask texture. `clip-mask.ts` is deleted after migration.
- The `key` kind is a shader in the preview and numpy in the engine, with the colour matrix from PX2.7 so both sides key the same RGB values.
- `linear`, `band` and `gradient` kinds are analytic (signed distance to a line or centre) and follow the
  same determinism rules and vectors. `layer` masks read the source clip's composited alpha or luma from
  the frame plan at the same instant; a cycle (A masks B masks A) is a validator error.
- Every mask kind, mode, target, tracking method and the legacy feather model is a row in the `09`
  pixel oracle.
