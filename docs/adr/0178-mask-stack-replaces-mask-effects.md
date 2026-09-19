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
   operation refuses with "Measure this media first" rather than guessing. The probe records the
   pixel aspect ratio and clockwise rotation beside the coded size (`Asset.media.pixelAspectRatio`,
   `rotation`, MK1.9); absent means square and unrotated.
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
   typed export error instead of drawing an approximation. The preview (`clip-mask.ts`, since
   replaced by the MK3 stack pass below) drew the same subset.

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

## Amendment (2026-09-19, MK2.5): migrated masks keep the v21 spec they were drawn from

The MK2 amendment's "recovers the v21 fraction exactly" was only true for the values the vectors
sampled. E2E.5 exported a keyframed ellipse on a clip starting at 4 s and one frame in 30 drew an
edge a pixel off. Off t = 0 the frame instants are not round (`144 / 30 - 4` is
`0.7999999999999998`), so v21 read x = 0.19999999999999996, and the stored centre
`(x + width / 2) * 320` is 144.0 for that x AND for x = 0.2. v21 drew the left edge at
`x * width`: 63.99999999999999 vs 64.0, which Pillow truncates a pixel apart. The centre and size
are not one-to-one with v21's fractions, so no inverse can be exact; the recovery's
shortest-decimal tie-break picked 0.2. Measured on the new timing vectors: 6 of 1,584 rasters
differed before the fix.

The migration now writes `legacySpec` on each mask it converts: the v21 bounds, feather and
polygon points verbatim, plus each animated v21 value at exactly the source instants the mask's
own keyframes use (every rendered frame of a moving curve; runs of equal values collapse to their
ends). It is an optional field, written only by the migration (not by the v21-vocabulary builders,
which have no earlier export to reproduce). `_legacy_spec` (engine) and `legacySpec` (preview)
draw from it whenever its values map, through the migration's own expressions, bit for bit onto
the geometry stored at that instant, which holds for every rendered frame of an unedited mask. So
the migrated mask draws v21's own numbers by construction, not by search. A mask edited since fails
that check and falls back to the ulp recovery, so a stale `legacySpec` never draws. Values are read
without arithmetic (static field, value at a keyframe instant, end values, or a hold between two
equal values), so the engine and the preview read identical numbers.

`test_mask_legacy_render.py` requires every frame of every fixture case, plus 24 mid-timeline
timings (4 moving cases × starts 4 s, 1.37 s, 7.5 s, 3.1 s, 10.05 s and 0.7 s at 30, 30, 24,
29.97, 60 and 23.976 fps, pinned in `legacy-v21.timings.migrated.json`) and the exact E2E.5 clip,
to equal v21 bit for bit at two frame sizes. It also requires the stored spec, not the recovery,
to have drawn every one of those frames. Every existing mask raster vector, mask and matte render
golden, and stack-clips digest is unchanged. `stack-clips.json` gains `legacySpec` in its migrated
clip inputs and the E2E.5 case.

Known limit, unchanged: a ramped clip whose ramp runs past its source range renders its last
source frame for several timeline frames while v21 kept animating the mask. Source-clock keyframes
cannot hold two values at one instant, so that tail is not reproduced. No fixture or real project
is known to have one.

## Amendment (2026-09-17, MK3): the preview draws the stack with the export's algorithm

`clip-mask.ts` (one shape, canvas/SVG primitives) is deleted. The program monitor evaluates the
whole stack in `apps/web-editor/src/preview/masks/`: `mask-raster.ts` is a line-for-line port of
`render/mask_raster.py` (byte-equal to the 36 vector cases at 3 resolutions on Linux, macOS arm64
and Windows x64), `legacy-mask.ts` ports the Pillow 12 drawing and `GaussianBlur` the
`gaussian-legacy` path runs, and `mask-stack.ts` mirrors `render/mask_stack.py` (source clock,
crop mapping, `_legacy_spec` recovery, combine and quantise). `tests/fixtures/mask-raster/`
`legacy.json` and `stack-clips.json` pin those float64 bytes. The layer compositor uploads the
8-bit stack per layer: alpha targets cut the picture, effect targets mix the effect's output
with its input in integers (`mix_by_alpha`). Kinds the export refuses (matte, key, analytic,
layer, tracked, frame-space) are refused on the monitor with a visible "Mask not previewed yet".

Two facts this measured:

- **The engine ignored a static `expansionPx` and a matte's static `edgeShiftPx`.**
  `mask_scalar_at` mapped only the two feathers to model attributes, so any other camelCase
  property read as absent and exported as 0. It now resolves the attribute by field alias; the
  two affected render goldens were regenerated.
- **Pillow's macOS arm64 wheels fuse `a * b + c` in C float code** (clang floating-point
  contraction); Linux and Windows compute two rounded steps. A legacy polygon edge that crosses a
  row at exactly `.5` fills a different pixel on the two, in the export itself. The preview follows
  the host (client hints), and the stored legacy vectors avoid such crossings.

## Amendment (2026-09-17, MK4): editing commands, presets (schema v23), binary path arrays

- **One command layer for hand and agent edits.** `editor-core/mask-commands.ts` compiles an
  intent (draw, reshape at an instant, change properties, toggle a keyframe, paste, presets) into
  the operations above and validates and inverts it. The UI never builds a raw mask operation;
  the agent's `add_mask` compiles `draw_mask`. An animated property is keyed at the playhead's
  source instant; `update_mask.keyframeOffsets` lets "Apply to all keyframes" shift a property on
  every keyframe in one operation (Premiere 26.0 clip edit mode).
- **Presets are project data.** Schema v23 adds optional `Timeline.maskPresets` (masks plus the
  picture size they were drawn on), changed only through `save_mask_preset` /
  `remove_mask_preset` (inverse `restore_mask_presets`), so presets undo and travel with the
  project. The v22 → v23 migration is additive; the bump makes an older app refuse a file whose
  presets it would drop.
- **Long path arrays are stored as exact binary in the file.** Measured against the 250 ms save
  budget with 1,000 path keyframes × 200 vertices, decimal JSON took ~120 ms to format the
  numbers alone and 55 MB pretty-printed. `serializeProject` now writes number arrays of 16 or
  more on one line and path `points`/`featherPx` of 384 or more (64 vertices) as
  `f64le:<base64 of little-endian float64>`: bit-exact, ~3 ms, 13.4 MB. The Zod and Pydantic
  schemas decode the string on parse, so memory, operations, renderers and the agent only ever
  see number arrays. Short paths stay readable decimals and ordinary projects serialise with the
  same layout as before. The recovery snapshot reuses the serialised text of the save it follows.
  Rejected: a new in-memory representation (every reader would change) and rounding coordinates
  (loses the sub-pixel positions the tools promise).

## Amendment (2026-09-18, MK7): tracking, and what `use_track` still cannot drive

A tracked mask carries `tracking: { artifact: { key, sha256 }, method, referenceSourceTime,
constraints, review }`, and the per-frame 3×3 transforms live in a project-owned, digest-pinned
file (`.framepilot-derived/tracks/<key>/track.json`), exactly as a matte's frames do. The
transform is applied to the mask's control points **before** they are flattened, so the edge stays
the exact one the rasteriser draws and the monitor and export agree; both sides are pinned
byte-for-byte by `tests/fixtures/mask-track/transforms.json`.

Only `rectangle`, `ellipse` and `path` masks can be tracked. A track warps control points, and a
`matte`, `key` or `layer` mask follows its own pixels — so a track on one is refused with a
remedy rather than silently ignored, on both sides. A mask using the `gaussian-legacy` feather is
refused for the same reason: its v21 blur path has no control points to move.

**`use_track` still drives masks only, and that is now a decision to take rather than a gap to
fill.** Pointing a track at a text clip's or an overlay's transform needs a place on the clip to
record it — `Clip.transformTrack` — which is a schema change (v23 → v24, purely additive with a
`(raw) => raw` migration step), and it needs an answer to a question the mask side never had to
ask: a clip's transform is position, scale and rotation, not a general homography, so a
`perspective` track cannot be applied to one without being reduced. The honest reduction is the
similarity part — the same constraint `constrainTransform` already applies for the
`position-scale-rotation` method — with the residual reported so a plane the transform cannot
express is visible rather than quietly dropped.

Neither half was built here: CLAUDE.md §5 makes a schema change a maintainer decision, and a
backend-only `transformTrack` field with no renderer behind it is precisely the kind of
"schema exists, capability does not" progress the product-discipline rule forbids. Recorded so a
later agent takes the decision rather than rediscovering the question.

### MK8 amendment (2026-09-18): analytic kinds, track mattes, shape presets

**Split, band and gradient are analytic, not paths.** `linear`, `band` and `gradient` are a
distance to a line or a centre evaluated per pixel centre by twin float64 functions under the
rasteriser's determinism rules. A hard split or band is the EXACT area of the pixel square on the
kept side (a closed-form trapezoid CDF of the square's projection onto the line's unit normal),
not the one-pixel linear edge a shape gets from its distance field: a straight line is the one
edge whose exact coverage has a closed form, and taking it keeps the ≤ 1/255-vs-supersample gate
without a coverage sweep. Softness joins each feather side by half, so the soft edge is the shapes'
own distance feather. A gradient has no edge: expansion and feathers on one are refused (validator,
export, monitor) rather than silently ignored.

**A track matte's source is consumed, not drawn.** A clip or track an enabled `layer` mask reads is
rendered for the matte and never composited itself — Premiere's Track Matte Key and CapCut's text
mask both hide it, and "video inside text" is impossible otherwise. The frame plan marks such
layers `matteOnly` on both sides (the key is written only when true, so plans without a track matte
did not change). The matte is the source composited ALONE on a transparent frame at the same
instant (`CompositeVideoClip(layers, size)` without a background), read at the frame pixel each of
the target's cropped-picture pixel centres lands on through the target's own resize, rotation and
paste (`picture_placement_at`, the integers MoviePy uses), then the key's finesse group, invert and
opacity. Channels: alpha; luma over transparent black (`luma(rgb) · alpha`); inverted after
sampling. A track matte has no drawn edge, so expansion and feathers are refused on it (finesse
grows and softens it). Loops and missing or picture-less sources are refused before rendering.
The CPU mapping is byte-exact TS↔Python (`layer.json`); the monitor's shader is float32 and is
judged by the PX4 oracle at unchanged gates. Adjustment lanes refuse a track matte (their stack is
frame-space and has no clip to read against).

**Shape presets are generators.** Heart, star, n-gon, speech bubble, arrow and rounded frame
produce ordinary `path` masks (`mask-shape-presets.ts`); a rounded frame is an outer path plus a
subtracted inner one, because one path with a hole needs a bridge the feather would show. No kind,
no schema change.

### MK9 amendment (2026-09-18): frame space, adjustment-lane editing, edge styles

**A frame-space clip mask is read through the track matte's mapping.** `space: 'frame'` on a clip
mask is drawn on the output frame in frame pixels by the same rasteriser (invert and opacity
included) and read back onto the clip's raster at the frame pixel each pixel centre lands on
(`picture_placement_at` on export, the compositor step in the monitor). It stays put while the
picture moves under it. Only geometry kinds can be frame-space; a frame-space key, matte, track
matte, tracked or v21-migrated mask is refused. No schema change: the field existed since v22.

**An adjustment lane is edited as a clip-shaped stand-in.** The panel, list, properties and monitor
tools take `effectLayerMaskOwner(layer)` (clock = seconds from `start`, picture = the frame) and
every command carries `owner: 'effect_layer'`; `compileMaskCommand` runs the clip builder on the
stand-in and readdresses its operations to the lane. One builder, so lane and clip edits cannot
drift; commands that need a clip picture are refused on a lane.

**Edge styles are clip effects that read the stack, not mask kinds or lane kinds.** Outline, glow
and shadow are three render kinds in the effect catalog (`edgeStyles` in `effect-catalog.json`),
stored as `Clip.effects[]` of type `edge_style` and set by `set_clip_edge_style` (one per kind).
They trace the alpha-target stack at alpha ≥ ½ with an exact, reach-bounded separable Euclidean
distance (integers until one `sqrt`, so CPU twins are byte-exact and the GPU finds the same
distances) and polynomial falloffs; the picture goes over them. An effect-layer kind was rejected:
the composited frame has no cut-out to trace. A schema field was rejected: the open effect params
already carry them, validated against the catalog vocabulary.

### E2E amendment (2026-09-19): a clip blur, so an effect-target mask can blur

The Decision says a mask may limit any of the clip's effects ("face blur, sky grade"), but a
clip's picture effects were only `color_grade` and `lut`; a blur existed only on an adjustment
lane, whose masks are frame-space and cannot follow a track. E2E.3 ("effect-target blur") and
E2E.4 ("blur the faces") found the gap. A clip `blur` picture effect now exists — Pillow's
Gaussian at `params.amount` × the smaller side of the picture it runs on, applied after the
grade and the LUT and mixed by the effect's mask stack like a grade
(`render/clip_blur.py`, `editor-core/clip-blur.ts`, the compositor's per-layer effect chain; a
frame-plan parity case and the PX4 oracle cover it). No schema change: `Effect.type` is a string
and `apply_color_grade` already attaches clip picture effects. The AI's `blur_to_hide` uses it
(docs/api/ai-masking.md). The same work found that the program monitor never read track artifacts
at all (tracked masks showed "Mask not previewed yet"); the layer preview engine now loads them
before presenting a seek. User guide: [docs/guides/masking.md](../guides/masking.md).

## Consequences

- Keyframe curve math and the speed curve moved into `timeline-schema` (editor-core re-exports
  them): the migration must evaluate keyframes through a ramp and may only depend on this package.
- `Asset.media` carries coded width/height only; PAR and rotation helpers exist
  (`mask-geometry.ts`) but the probe does not record them yet, so anamorphic and rotated media are
  treated as square-pixel, unrotated — the same assumption every render path already makes.
- `use_track` can drive masks only; driving a text or overlay transform needs a place on the clip
  to record the track and a decision about reducing a homography to a clip transform (see the
  MK7 amendment).
- The frame plan (`render/frame_plan.py`, `editor-core/frame-plan.ts`, owned by PX1) still reports
  the retired `mask` effect and must switch to `Clip.masks`.
- `project.schema.json` inlines the mask union at each use site and grew accordingly.

## Alternatives rejected

- **A `matte` effect beside `mask` effects:** two alpha models (see Context).
- **Timeline-relative mask keyframes:** every split, trim and retime would rewrite them, and the
  v21 split bug for effect keyframes shows how that goes wrong.
- **Object-per-vertex paths:** several times larger for long rotoscopes.
