# ADR 0178 — The mask stack replaces `mask` effects (schema v22)

- **Status:** Accepted (maintainer decision MD-1, 2026-09-16)
- **Date:** 2026-09-16
- **Plan:** `plan/background-removal-ai/10-PROFESSIONAL-MASKING.md`, task MK1

## Context

Through schema v21 a mask was a `mask` effect: one shape (rectangle, ellipse, polygon) in
fractions of the cropped frame, a Gaussian feather, keyframes in clip-timeline seconds. The export
drew only the first one. That model cannot carry what professional masking needs: several masks
combined by mode, paths with tangents, mattes from a pack, keys, masks limiting an effect rather
than the clip, tracking, and animation that survives trim, split and speed changes. Background
removal would have added a second alpha model (a `matte` effect) beside it, and two alpha models
fight over order and double every validator, renderer and AI path.

## Decision

1. **One alpha model.** `Clip.masks: MaskLayer[]` (top first) and `EffectLayer.masks` (always
   `space: 'frame'`) replace the `mask` effect type. `MaskLayer` is a discriminated union of
   `rectangle`, `ellipse`, `path`, `matte`, `key`, `linear`, `band`, `gradient` and `layer`, sharing
   one base (name, colour, enabled, locked, target, mode, opacity, invert, expansion, inner/outer
   feather, falloff, feather model, space, keyframes, tracking).
2. **Display-corrected source pixels.** Source-space geometry is stored in pixels of the picture
   the editor sees, before crop. Adding a mask needs the media's probed size; without it the
   operation refuses with "Measure this media first" rather than guessing.
3. **Keyframes on the source clock.** Mask keyframe `sourceTime` is asset source seconds, so trim,
   slip, split, ripple and speed changes never rewrite a mask. (Effect-layer masks use seconds from
   the layer start.)
4. **Compact paths.** A path keyframe is a flat `points` array (six numbers per vertex, tangents as
   offsets) plus a parallel small-int `vertexTypes` array, and an optional per-vertex feather array.
5. **Typed operations** in `editor-core/mask-operations.ts` with apply and invert: `add_mask` (now a
   whole `MaskLayer`), `add_effect_layer_mask`, `remove_mask`, `update_mask`, `set_mask_path`,
   `add/remove/move_mask_keyframe`, `insert/remove_mask_vertex` (all path keyframes at once, exact
   de Casteljau split), `reorder_masks`, `set_mask_target`, `apply/clear_mask_tracking`,
   `use_track`, `set_mask_space`, `review_mask`, `paste_masks`, `add_text_behind_subject`, and the
   internal `restore_masks` inverse. An empty stack is an absent key, so undo lands on the exact
   prior document.
6. **Validator** (`mask-validation.ts`): unique ids, targets exist, path shape, finite geometry,
   animatable properties per kind, authored keyframes within the source range plus a 1 s handle,
   measured media, layer-mask cycles, matte size and coverage, and the retired `mask` effect type
   refused. No message carries a varying magnitude (the repeated-failure guard keys on text).
7. **Migration v21 → v22** (`timeline-schema/mask-migration.ts`): the first `mask` effect becomes
   one enabled alpha mask with `featherModel: 'gaussian-legacy'`, bounds through the crop into
   pixels, a polygon into a zero-tangent path, keyframes mapped through speed/reverse/freeze/ramp.
   Later mask effects arrive disabled with a note (they never rendered). Media never measured keeps
   its fractions under `units: 'normalized'` and the validator surfaces "Measure this media first".
   The desktop app writes `<project>.v21.backup.fp.json` before migrating and never overwrites it; a
   newer file is refused with "Update FramePilot to open this project."
8. **Interim render.** Until the stack rasteriser (MK2), `render/masks.py#legacy_mask_for_clip`
   maps a single enabled alpha rectangle/ellipse/polygon-path (hard or `gaussian-legacy`) onto the
   v21 rasteriser, so migrated projects render as before, and refuses every other stack with a
   typed export error instead of drawing an approximation. The preview (`clip-mask.ts`) draws the
   same subset.

## Amendment (2026-09-17, MK2): animated legacy masks are sampled per frame

Decision 7 re-timed v21 keyframes onto the source clock. Measured against the v21 renderer
at every exported frame, that was not byte-identical: through a speed ramp the timeline →
source map is not affine, and even at constant speed the re-timed interpolation lands an ulp
away from v21's timeline-clock value between keyframes, enough to move a Pillow edge (13 of 60
frames on a 2x clip). The migration now writes a linear keyframe at every frame the export
renders at the project frame rate for any moving legacy curve (a freeze still keeps its first
value; runs of equal values collapse to their ends). The engine returns a keyframe's stored
value exactly at its instant and recovers the v21 fraction exactly, so every migrated fixture
exports bit-identically at every frame. Masks authored today through the v21 vocabulary
(`maskLayerFromLegacyMaskEffect`, `add_mask_advanced`) keep re-timed, editable keyframes.

## Consequences

- Keyframe curve math and the speed curve moved into `timeline-schema` (editor-core re-exports
  them): the migration must evaluate keyframes through a ramp and may only depend on this package.
- `Asset.media` carries coded width/height only; PAR and rotation helpers exist
  (`mask-geometry.ts`) but the probe does not record them yet, so anamorphic and rotated media are
  treated as square-pixel, unrotated — the same assumption every render path already makes.
- `use_track` can drive masks only; driving a text or overlay transform needs a place on the clip
  to record the track, which lands with MK7.6.
- The frame plan (`render/frame_plan.py`, `editor-core/frame-plan.ts`, owned by PX1) still reports
  the retired `mask` effect and must switch to `Clip.masks`.
- `project.schema.json` inlines the mask union at each use site and grew accordingly.

## Alternatives rejected

- **A `matte` effect beside `mask` effects:** two alpha models (see Context).
- **Timeline-relative mask keyframes:** every split, trim and retime would rewrite them, and the
  v21 split bug for effect keyframes shows how that goes wrong.
- **Object-per-vertex paths:** several times larger for long rotoscopes.
