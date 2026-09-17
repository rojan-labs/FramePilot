# Timeline Schema (Data Model)

The canonical project document is `project.fp.json` (PRD §10.3, §11). It is the single
source of truth for a project and is what both the editor (`packages/editor-core`,
`packages/timeline-schema`) and the Python render engine (`engine/python`) read and
write. The schema is mirrored in **Zod (TypeScript)** and **Pydantic (Python)**, kept in
sync via a shared JSON Schema, so the same document round-trips identically through both.

See [../architecture/timeline-and-patch-engine.md](../architecture/timeline-and-patch-engine.md)
for how the model is used, and [patch-format.md](patch-format.md) for how it is mutated.

---

## Project (PRD §11.1)

```json
{
  "id": "project_001",
  "name": "Demo Video",
  "version": 1,
  "fps": 30,
  "resolution": { "width": 1920, "height": 1080 },
  "assets": [],
  "timeline": {},
  "transcript": [],
  "capabilityPacks": [],
  "aiMemory": {},
  "history": []
}
```

| Field             | Type                | Notes                                                                                     |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `id`              | string              | Stable project identifier.                                                                |
| `name`            | string              | Display name.                                                                             |
| `version`         | number              | User-facing project revision. File migration uses the top-level `schemaVersion` envelope. |
| `fps`             | number              | Project frame rate (timeline time base).                                                  |
| `resolution`      | `{width,height}`    | Canvas resolution.                                                                        |
| `assets`          | Asset[]             | Imported media references (originals live in `assets/`, never modified).                  |
| `timeline`        | Timeline            | Tracks + clips (below).                                                                   |
| `transcript`      | TranscriptWord[]    | Word-level timestamps from transcription.                                                 |
| `capabilityPacks` | CapabilityPackPin[] | Optional immutable logical on-demand pack releases used by this project (schema v19).     |
| `aiMemory`        | object              | Per-project AI memory (style, pacing, accepted/rejected edits — see ai-engine.md).        |
| `history`         | Patch[]             | Applied patches; backs undo/redo and crash recovery.                                      |

### Capability Pack pins (schema v19)

`capabilityPacks` records logical release identities, not local installations. Each pin contains
`id`, semantic `version`, canonical signed-release `releaseDigest`, the consumed `capabilities`, and
whether absence affects `render`, `edit`, or only `analysis`. It never stores a platform artifact,
filesystem path, download URL, or credential, so projects remain portable between macOS and
Windows. See [capability-packs.md](capability-packs.md) and ADR 0114.

### Asset provenance (schema v20)

An `Asset` fetched from a third-party media provider carries an optional `source` recording
where it came from and what crediting it obliges. Assets the user imported themselves have no
`source` — absent means "nothing to credit", never "unknown".

```json
{
  "id": "asset_bed",
  "path": "media/calm_lofi_bed.mp3",
  "kind": "audio",
  "source": {
    "provider": "openverse",
    "remoteId": "ov-12345",
    "license": "cc-by",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "attributionRequired": true,
    "attribution": "\"Calm Lofi Bed\" by Ada Lovelace is licensed under CC BY 4.0.",
    "creator": "Ada Lovelace",
    "creatorUrl": "https://example.test/ada",
    "sourceUrl": "https://openverse.org/audio/ov-12345",
    "fetchedAt": "2026-08-23T12:00:00.000Z"
  }
}
```

| Field                 | Type    | Notes                                                                 |
| --------------------- | ------- | --------------------------------------------------------------------- |
| `provider`            | string  | Provider roster name, e.g. `openverse`.                               |
| `remoteId`            | string  | Provider-local id. Download dedupe, and finding the item again later. |
| `license`             | string  | Licence identifier verbatim from the provider.                        |
| `licenseUrl`          | string? | Canonical licence text, so the user can read the actual terms.        |
| `attributionRequired` | boolean | **Required.** Stored, not derived — see below.                        |
| `attribution`         | string? | The ready-to-paste credit line, carried verbatim from the provider.   |
| `creator`             | string? | Creator name.                                                         |
| `creatorUrl`          | string? | Creator page on the provider.                                         |
| `sourceUrl`           | string? | Landing page for the item.                                            |
| `fetchedAt`           | string  | ISO-8601. What the terms were understood to be, and when.             |

`attributionRequired` is **stored rather than derived** from `license`: licence vocabularies
differ per provider and change over time, and a project written today must still know what it
agreed to then. It is required rather than defaulted, because defaulting it to `false` would
silently downgrade a credit obligation to none.

The engine models this field (`AssetSource` in `timeline/models.py`) but reads nothing from it
— provenance cannot affect a render. It exists on the Python side so an engine round-trip does
not strip the one durable record of an obligation.

The editor reads it back in the export dialog's **Credits** section. See ADR 0138.

---

## Timeline & Track (PRD §11.2)

A timeline is a set of typed tracks; each track holds clips.

```json
{
  "tracks": [
    { "id": "video_1", "type": "video", "clips": [] },
    { "id": "audio_1", "type": "audio", "clips": [] },
    { "id": "caption_1", "type": "caption", "clips": [] },
    { "id": "overlay_1", "type": "overlay", "clips": [] }
  ]
}
```

Track `type` is one of: `video` | `audio` | `caption` | `overlay`. Track order encodes
compositing layer order (important for text-behind-object; validated by the patch
validator).

---

## Clip (PRD §11.3)

```json
{
  "id": "clip_001",
  "assetId": "asset_001",
  "trackId": "video_1",
  "start": 0,
  "end": 12.5,
  "sourceStart": 4.0,
  "sourceEnd": 16.5,
  "effects": [],
  "keyframes": []
}
```

| Field                       | Meaning                                                  |
| --------------------------- | -------------------------------------------------------- |
| `start` / `end`             | Position on the **timeline** (seconds).                  |
| `sourceStart` / `sourceEnd` | The in/out points within the **source media** (seconds). |
| `effects`                   | Effect[] applied to this clip.                           |
| `keyframes`                 | Keyframe[] animating clip-level properties.              |
| `captionStyle`              | Optional persisted caption style (schema v5, below).     |
| `speed`                     | Optional constant playback rate (schema v6, below).      |

**Non-destructive trimming:** trimming changes `sourceStart`/`sourceEnd` (and/or
`start`/`end`), never the underlying file. The original is always fully recoverable.

---

## Caption style (schema v5)

`Clip.captionStyle` is an optional, structured object — meaningful on caption-kind
clips (created by `add_caption_layer`, `assetId === '__caption__'`), but modeled as
a plain clip field rather than nested inside the caption `Effect`'s free-form
`params`. Set/cleared with the `set_caption_style` operation (`packages/editor-core`).

```json
{
  "fontFamily": "Inter",
  "fontScale": 1.25,
  "textColor": "#ffffff",
  "outlineColor": "#000000",
  "outlineWidth": 2,
  "position": "bottom",
  "highlight": { "enabled": true, "color": "#ffe600", "animation": "karaoke-fill" },
  "presetId": "bold-pop"
}
```

| Field                 | Meaning                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| `fontFamily`          | CSS-style font family name.                                                          |
| `fontScale`           | Font size multiplier relative to the caption track's base size (`> 0`).              |
| `textColor`           | Caption text color (any CSS color string).                                           |
| `outlineColor`        | Text outline/stroke color.                                                           |
| `outlineWidth`        | Outline/stroke width (`>= 0`).                                                       |
| `position`            | Vertical anchor: `top` \| `middle` \| `bottom`.                                      |
| `highlight.enabled`   | Whether the active spoken word is highlighted.                                       |
| `highlight.color`     | Highlight color.                                                                     |
| `highlight.animation` | `none` \| `pop` \| `karaoke-fill`.                                                   |
| `presetId`            | Id of a built-in style preset (e.g. a `CAPTION_TEMPLATES` entry) it was seeded from. |

All fields are optional/defaulted so a v4 caption clip (no `captionStyle` at all)
migrates cleanly to an unstyled v5 clip. See ADR 0045 for why this is structured
data on `Clip` rather than a free-form effect param bag.

---

## Speed / time-remap (schema v6)

`Clip.speed` is an optional constant playback rate (`> 0`). Absent (or `1`) is
today's implicit 1x behavior — timeline duration equals source duration. A
`speed != 1` **decouples** them under this invariant, enforced by the patch
validator (`speed_duration_mismatch`):

```
end - start === (sourceEnd - sourceStart) / speed
```

`sourceStart`/`sourceEnd` keep meaning "the asset range this clip consumes";
`end` is derived from the source range and `speed`. E.g. `speed: 2` (2x)
consumes the same footage in half the timeline time; `speed: 0.5` (slow-mo)
stretches it to twice the timeline time.

Set/reset with the `set_clip_speed` operation (`packages/editor-core`):

```ts
{ type: 'set_clip_speed', clipId: 'clip_001', speed: 2 } // or `null` to reset to 1x
```

`1x` is canonicalized as an **absent** `speed` field (not stored as `speed: 1`).
This is a **constant rate**, not a speed curve (multiple rates over one clip) —
see ADR 0046 for why a curve was deferred to a later, additive v6.x step
(reusing `Clip.keyframes` once an integrator exists) rather than shipped now.

---

## Effect (PRD §11.4)

```json
{
  "id": "effect_001",
  "type": "transform",
  "params": { "scale": 1.1, "x": 0, "y": 0, "rotation": 0, "opacity": 1 },
  "keyframes": []
}
```

`type` examples: `transform`, `crop`, `blur`, `color_grade`, `mask`. `params` are
type-specific; `keyframes` animate those params over time.

---

## Keyframe

A keyframe is a `(time, value, easing)` triple attached to a clip or an effect param.

```json
{
  "id": "kf_001",
  "time": 1.5,
  "param": "scale",
  "value": 1.25,
  "easing": "ease-in-out"
}
```

Easing types (PRD §6.3): `linear`, `ease-in`, `ease-out`, `ease-in-out`, `hold`,
`bezier` (bezier carries control-point params).

---

## Mask stack (schema v22, ADR 0178)

`Clip.masks` and `EffectLayer.masks` are ordered stacks (top first) of `MaskLayer`, replacing the
v21 `mask` effect type. Read them through `masksOf(owner)`; the field is optional and absent means
no masks.

| Field | Meaning |
| --- | --- |
| `id`, `name`, `color`, `enabled`, `locked` | Identity, overlay colour (never rendered), bypass, edit lock |
| `target` | `{ kind: 'alpha' }` or `{ kind: 'effect', effectId }` (an effect on the same clip) |
| `mode`, `opacity`, `invert` | `add`/`subtract`/`intersect`/`difference`/`lighten`/`darken` |
| `expansionPx`, `featherInnerPx`, `featherOuterPx`, `falloff` | Edge controls, pixels |
| `featherModel` | `distance`, or `gaussian-legacy` for masks migrated from v21 |
| `space` | `source` (display-corrected source pixels, before crop) or `frame` (output pixels) |
| `units` | Only `'normalized'`, on v21 masks whose media was never measured |
| `keyframes` | `{ id, sourceTime, property, value, easing, handles? }`; `sourceTime` is ASSET source seconds |
| `tracking` | `{ artifact: { key, sha256 }, method, referenceSourceTime, constraints, review }` |

Kinds: `rectangle` (`cx, cy, width, height, rotation, roundness`), `ellipse` (`cx, cy, rx, ry,
rotation`), `path` (`firstVertex`, `pathKeyframes[]` of `{ id, sourceTime, easing, points,
vertexTypes, featherPx? }` — six numbers per vertex, tangents as offsets, types 0 corner / 1
smooth / 2 broken), `matte` (`artifact, prompts, review, edgeShiftPx, decontaminate, edgeMode,
finesse`), `key` (`model, ranges, samples3d, softness, despill, shadowRetention, finesse`),
`linear`, `band`, `gradient`, and `layer` (`source: { kind: 'clip' | 'track' }, channel, finesse`).
`editor-core` `encodeMaskPath`/`decodeMaskPath` convert paths; `maskLayerFromFrameShape` builds a
mask from frame fractions. Operations are listed in `patch-format.md`.

### Display-corrected source pixels (`Asset.media`, schema v22)

Source-space mask pixels are measured against the picture as players show it. `Asset.media`
records the probe's **coded** `width`/`height` (v21) and, since v22, two optional fields:

| Field | Type | Notes |
| --- | --- | --- |
| `pixelAspectRatio` | number > 0? | ffprobe `sample_aspect_ratio` as a float (like `fps`). Absent or `null` ≡ square. Only non-square ratios are recorded. |
| `rotation` | `0 \| 90 \| 180 \| 270`? | Clockwise display rotation: the negated display-matrix `rotation`, else the legacy `rotate` tag. Absent or `null` ≡ 0. A non-quarter-turn matrix is ignored (logged), as ffmpeg's autorotate does. |

Display size = coded width × PAR, then width and height swap for 90/270. An anamorphic HDV clip
(1440×1080, SAR 4:3) measures 1920×1080; a portrait phone clip coded 1920×1080 with a −90°
display matrix measures 1080×1920. `editor-core` `assetDisplaySize` / `assetPictureGeometry`
(with `codedToDisplay` / `displayToCoded`) and the engine's `AssetMedia.display_size()` are the
only readers; every mask caller (preview, Inspector, patch builders, AI tools, tracking, export,
motion evidence) goes through them. The export turns mask pixels into fractions of this size and
draws them over the decoded frame, which is correct because MoviePy decodes a rotated stream
already turned and a horizontal PAR stretch keeps width fractions unchanged.

Validation: the schema rejects any other rotation and a non-positive or infinite PAR, and the
desktop import drops such values from the sidecar at the process boundary. Media probed before v22
has neither field and reads as square and unrotated; re-import it to measure anamorphic or rotated
footage. No version bump: v22 was unreleased when the fields were added.

### How the export draws a stack (MK2)

`render/mask_stack.py` evaluates the enabled masks at the asset source second the clip is playing
(the speed stage's clock: speed, reverse, freeze and ramps) and draws each on the exact
rasteriser `render/mask_raster.py`. The TypeScript preview rasteriser (MK3) must match it byte for
byte against `tests/fixtures/mask-raster`.

| Rule | Behaviour |
| --- | --- |
| Geometry | Source pixels mapped through the clip's crop onto the decoded frame; expansion and feathers scale by the smaller axis scale |
| `rotation` | Degrees, clockwise on screen, about the centre; quarter turns are exact |
| `roundness` | Corner radius `roundness × min(width, height) / 2` |
| Path keyframes | Every number `a + (b − a) × p`, `p` the earlier keyframe's eased progress (ADR 0089, incl. two-sided bezier handles); vertex `i` pairs with vertex `i` |
| Hard edge | Zero expansion and feathers: exact area coverage |
| Feather | `s` = signed distance to the edge (outside positive) − expansion; alpha `falloff((outer − s) / (inner + outer))`; with no feather but an expansion, a one-pixel linear edge |
| `featherPx` | When present, the per-vertex OUTER feather, interpolated along each segment (replaces `featherOuterPx`) |
| `falloff` | `linear` x · `smooth` 3x² − 2x³ · `gaussian` from the shipped 4096-entry table |
| Layer | invert (`1 − a`), then × opacity |
| `mode` | The stack starts at zero: `add` min(1, a + m) · `subtract` max(0, a − m) · `intersect` a × m · `difference` \|a − m\| · `lighten` max · `darken` min |
| Quantisation | Once, after the stack: `round(a × 255)`, ties to even |
| `target: effect` | That effect (today `color_grade`, `lut`) runs on the whole frame and is mixed with the input by the stack's alpha |
| `gaussian-legacy` | The v21 blur, byte-identical for migrated masks; rotation, roundness, curves, expansion, inner or per-vertex feather refuse with "Switch the mask's feather model to Distance" |

Refused before rendering, with "Disable the mask to export now": `key`, `linear`, `band`,
`gradient` and `layer` masks, tracked masks, `space: 'frame'` masks and masks on effect layers.
Hard edges follow the nonzero winding rule exactly, including self-crossing and self-overlapping
paths (those pixels use an exact per-cell slab sweep).
Migrated animated masks carry a keyframe per exported frame, so they export bit-identically to v21
(ADR 0178 amendment).

### Matte masks in the export (BR2)

A `matte` layer is a raster from the Smart Mask pack, stored in the project at
`.framepilot-derived/mattes/<artifact.key>/` (`render/mattes.py` reads it, `render/matte_edges.py`
draws it). **Why each rule:** a matte one frame off its picture is a halo on every moving edge,
and a matte drawn from a changed file silently differs from what the editor reviewed.

**Artifact files.** `matte.mkv` (FFV1, `gray` or `gray16le`), `foreground.mkv` (FFV1 lossless
RGB: `gbrp`, `bgr0`, `rgb24`, `bgra`, `rgba`, `0rgb`; colour only inside the soft band),
`frames.json`:

```json
{ "version": 1, "timeBase": [1, 15360], "originPts": 0, "firstFrame": 12, "pts": [6144, 6656] }
```

`timeBase` is the source stream's; `originPts` is the pts of the source's first decoded frame
(edit lists honoured, so asset second 0); `firstFrame` is the decode-order source frame number of
matte frame 0; `pts[i]` is the source pts of matte frame `i`, strictly increasing. Matte frame
`i` is the `i`-th decoded frame of each `.mkv`.

**Frame identity.** The export reads the matte frame for the SOURCE FRAME NUMBER its picture
decodes (the frame plan's `source.frame`, also on the plan's matte layer as `matte.sourceFrame`),
through speed, reverse, freeze and ramps. A caller with a real pts looks up by pts exactly. A frame
the artifact does not hold is an error, never the nearest frame. Before rendering, every source
frame the clip will read is checked against `frames.json`.

**Per layer, in order** (source pixels of the artifact, then the clip's frame):

| Step | Rule |
| --- | --- |
| Decontaminate | When `decontaminate`, before any effect or alpha: inside the band (`0 < alpha < max`) the picture's colour becomes `foreground.mkv`'s. Band weight and band-premultiplied colour are cropped and resampled separately: `out = picture + (colour − picture × weight)` |
| Alpha | stored value / format maximum (255 or 65535) |
| `edgeShiftPx` | Positive grows, negative shrinks: grey dilation/erosion of the stored integers by the disc `dx² + dy² ≤ r²` (edge pixels replicate) for `floor(|r|)` and `ceil(|r|)`, mixed `a + (b − a) × frac` |
| `edgeMode` → finesse | `smooth` (default) changes nothing. `sharp` sets clean black 0.25 and clean white 0.75 when `finesse.cleanBlack`/`cleanWhite` are at their defaults (0/1); explicit finesse values win. Levels: `(a − black) / (white − black)` clamped (a threshold at `black` when `white ≤ black`). This compresses the soft band to its middle half around the 50 % edge, keeping the edge where the matte put it (Premiere's Object Mask "Sharp") |
| `expansionPx`, feathers | All zero: the matte's own soft alpha. Otherwise the 50 % contour (`a ≥ 0.5`) is redrawn with the shape feather formula, `s` = (distance to the nearest pixel centre on the other side − ½, negative inside) − expansion |
| To the frame | MoviePy's integer crop of the clip's `crop` fractions, then bilinear resample (pixel centres aligned, edges clamped) to the decoded frame size |
| Layer, mode | invert, opacity, combine mode and the stack's single quantisation, as for every kind |

Other `finesse` controls (denoise, open/close, shrink/grow, blur, in/out ratio) refuse until the
finesse renderer ships (MK6.2); `gaussian-legacy` on a matte refuses.

**Refusals** (before rendering; the export error shows the remedy exactly; codes are stable):

| Code | Clip state | Shown |
| --- | --- | --- |
| `matte_missing` | BROKEN | Background removal data is missing — run Remove background again. |
| `matte_digest_mismatch` | BROKEN | Background removal data was changed outside FramePilot — run Remove background again. |
| `matte_unreadable` | BROKEN | Background removal data is damaged — run Remove background again. |
| `matte_unsupported_pixel_format` | BROKEN | Background removal data uses a format this version cannot read — update FramePilot or run Remove background again. |
| `matte_size_mismatch` | STALE | Media changed since background removal ran — run Remove background again. |
| `matte_out_of_coverage` | STALE | Background removal does not cover the clip's whole range — update the background removal for the new range. |
| `matte_frame_misaligned` | STALE | Background removal frames do not line up with the media — run Remove background again. |
| `matte_variable_frame_rate` | BROKEN | This footage has a variable frame rate, so the export cannot line the background removal up frame by frame — … |
| `matte_unsupported_media` | BROKEN | Background removal on rotated or non-square-pixel footage exports once that footage is supported — disable the mask to export now. |

Digests of `matte.mkv`, `frames.json` and (when decontaminating) `foreground.mkv` must equal the
mask's `artifact.files[].sha256`. Coverage uses the validator's ±½ project frame. Variable frame
rate is refused because the export's decoder resamples such footage to a constant rate, so no
matte frame can be proven to belong to the picture drawn.

## Schema versioning & migration

**v21 → v22** converts `mask` effects into `Clip.masks` (see ADR 0178). The desktop app writes
`<project>.v21.backup.fp.json` beside the project before the first migration and never overwrites
it. A project from a newer FramePilot is refused with "Update FramePilot to open this project."

- `Project.version` is the schema version. It is **bumped only with a migration**.
- **No breaking schema change without a migration** (CI/agent rule; see
  [../runbooks/ci-cd.md](../runbooks/ci-cd.md) and `.codex/AGENTS.md`).
- On load, a project below the current version is run through the migration chain (v→v+1
  steps) before use; loads are validated against the schema.
- Round-trip and golden-schema fixtures guard against accidental schema drift (Phase 1).
- Because the schema is consumed by both TS and Python, migrations must be applied
  consistently on both sides (shared JSON Schema is the contract).
