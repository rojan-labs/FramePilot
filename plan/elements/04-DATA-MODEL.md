# 04 — Data model, operations and validation

Rule zero (AGENTS.md invariants 2, 3, 5): every element enters the project through a typed,
validated, reversible operation. Nothing here mutates `project.fp.json` directly, and nothing adds a
parallel store.

---

## 1. Stickers: an ordinary `image` asset

No new asset kind for static stickers.

| Field      | Value                                                                                                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | `element_<library>_<itemId>`, e.g. `element_fluent3d_grinning_face` — deterministic, so adding the same sticker twice reuses one asset (two clips). Minted in **one** place (`sourcedAssetId` gains an `'element'` kind; renderer copies are pinned to it by tests, the existing arrangement) |
| `path`     | `<project media dir>/elements/<library>/<itemId>.webp` (inside the existing sandbox; nothing broadened)                                                                                                                                                                                       |
| `kind`     | `'image'`                                                                                                                                                                                                                                                                                     |
| `media`    | `{ width, height }` from the catalogue (the file is ours; no probe is needed to know its shape). No proxy, no peaks, no thumbnails — the image is its own thumbnail                                                                                                                           |
| `folderId` | `folder_elements` — the **Elements** bin folder, created in the same patch when absent (`create_folder`)                                                                                                                                                                                      |
| `source`   | `{ provider: 'fluent-emoji', remoteId: <itemId>, license: 'mit', licenseUrl, attributionRequired: false, attribution: 'Fluent Emoji by Microsoft (MIT)', creator: 'Microsoft', sourceUrl, fetchedAt }` (schema v20, unchanged)                                                                |

**"Is this an element?"** is derived, never stored: `isElementAsset(asset)` in `editor-core` is
true when `asset.source?.provider` is one of the element libraries. Placement of an element asset
always goes through `addStickerPatch` — from the panel, from `add_sticker`, **and** from `add_clip` /
`add_clips` / `move_clip` when the model hands them an element asset — so a sticker can never become
a cover-cropped, full-frame footage cutaway (00 G3). It is the only definition, used
by the Inspector (show the Sticker section), the agent's asset views (label it an element; keep it
out of footage tools), enrolment (skip footage indexing — G9) and the Credits view (group it).

**The clip.** On an overlay lane, `assetId` = the asset id, `sourceStart: 0`, `sourceEnd` = the clip
length (the still convention already used for photos). Initial geometry is **one `add_keyframes`
op at t = 0 with `replace: true`** — `scale` computed so the sticker's height is 30% of the frame
height after the renderer's fit, `x`/`y` = 0 — the exact op the on-canvas transform commits, so a
placed sticker and a hand-positioned one are the same data.

**The patch** (`addStickerPatch` in `editor-core/src/element-placement.ts`, shared by the panel and
the agent, the `stock-placement.ts` arrangement):

```
[create_folder folder_elements]?            only if absent
[add_asset element_fluent3d_…]?             only if absent
[add_layer overlay_N at index 0]?           only if no graphics lane has room
add_clip { trackId, assetId, start, end, clipId }
add_keyframes { clipId, keyframes: [scale, x, y @ t=0], replace: true }
```

One patch, one undo. The file copy that precedes it is a host side effect, exactly like a stock
download; the patch refers to a file that already exists.

---

## 2. Shapes: a synthetic clip with one typed effect

### 2.1 The clip

```ts
// editor-core/src/operations.ts, beside TEXT_OVERLAY_ASSET_ID and CAPTION_ASSET_ID
export const SHAPE_ASSET_ID = '__shape__';
```

A shape clip has `assetId: '__shape__'`, `sourceStart: 0`, `sourceEnd: end - start`, and exactly one
effect `{ id: '<clipId>__shape', type: 'shape', params: ShapeParams }`. `hasTimeBasedSource()` is
false for it (it can be extended and moved freely, as a title can).

### 2.2 `ShapeParams` — flat, numeric where it can be

Flat on purpose: `set_effect_params` shallow-merges (`operations.ts:2289-2309`), the Inspector edits
one key at a time, and a flat numeric param could later be animated through effect keyframes (a
stroke draw-on, deferred) with no new machinery.

| Key                    | Type                              | Applies to         | Notes                                                                                                   |
| ---------------------- | --------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `shape`                | catalogue id                      | all                | must exist in `shape-catalog.json`                                                                      |
| `x`, `y`               | 0–100                             | box                | centre, % of each axis                                                                                  |
| `width`, `height`      | 0.1–400                           | box                | % of **frame height** (03 §1.4)                                                                         |
| `x1`, `y1`, `x2`, `y2` | −50–150                           | segment            | endpoints, % of each axis (may start off-frame)                                                         |
| `fill`                 | `#rrggbb` / `#rrggbbaa` / `null`  | all                |                                                                                                         |
| `stroke`               | colour / `null`                   | all                |                                                                                                         |
| `strokeWidth`          | 0.05–10                           | all                | % of frame height                                                                                       |
| `strokeStyle`          | `solid` / `dashed` / `dotted`     | all                |                                                                                                         |
| `startCap`, `endCap`   | `none` / `arrow` / `dot` / `bar`  | segment            |                                                                                                         |
| catalogue knobs        | number, bounded by the descriptor | per shape          | e.g. `cornerRadius`, `points`, `innerRadius`, `headSize`, `curvature`, `tailX`, `tailSide`, `thickness` |
| `label`, `labelColor`  | ≤ 8 chars, colour                 | badge shapes (EL5) | drawn by the title rasteriser                                                                           |
| `drawOn`               | 0–1                               | deferred (11 §2)   | stroke write-on fraction; not in v25                                                                    |

`ShapeParamsSchema` lives in `packages/timeline-schema/src/shape-params.ts` (Zod), is exported and
generated into `project.schema.json`, and has a Pydantic twin in `engine/python/framepilot_engine/timeline/models.py`
with a parity test (`test_schema_parity.py`).

### 2.3 Operations

| Op                                                                           | Apply                                                                                             | Invert                                                                                   | Where                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **`add_shape`** `{ trackId, start, end, params, clipId? }`                   | insert the clip with the `shape` effect; deterministic id `deriveClipId('shape', trackId, start)` | `restore_clips` snapshot of the track (as `add_text_overlay` does, `operations.ts:3417`) | new — TS `editor-core/src/operations.ts`, Python `timeline/operations.py` |
| `set_effect_params` (shape)                                                  | existing; the **merged** params are re-validated as `ShapeParams`                                 | existing                                                                                 | —                                                                         |
| move / trim / split / delete / keyframes / layer transitions / blend / masks | existing, unchanged                                                                               | existing                                                                                 | —                                                                         |

Builders (web-editor and agent share them, in `editor-core/src/element-placement.ts`):
`addShapePatch(timeline, preset, at, overrides)`, `swapShapePatch(clip, newShapeId)` (keeps style
and box, resets knobs to the new shape's defaults, drops knobs it does not declare),
`resizeShapePatch`, `moveShapeEndpointsPatch` — each one validated patch.

### 2.4 Validator rules (new)

| Rule                                                            | Message (remedy included, no varying magnitudes — the repeated-failure guard keys on text)                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `params` parse as `ShapeParams` (strict — unknown keys refused) | "Shape parameter '{key}' is not one this shape has. Its parameters are: …"                                                  |
| `shape` exists in the catalogue                                 | "There is no shape called '{shape}'. Pick one with search_elements (kind: shape) or from the Shapes tab."                   |
| frame keys match the shape's frame (`box` vs `segment`)         | "'{shape}' is placed by its two ends (x1, y1, x2, y2), not a box."                                                          |
| knobs within the descriptor's range                             | "cornerRadius must be between 0 and 50."                                                                                    |
| **fill or stroke present**                                      | "A shape needs a fill or a stroke — with both off it draws nothing." (ADR 0144: an edit that renders as nothing is refused) |
| a shape clip carries exactly one `shape` effect                 | "A shape clip has exactly one shape effect."                                                                                |
| `__shape__` never names a real asset                            | refused on `add_asset` / `relink`                                                                                           |

### 2.5 Clip kind

`shape` joins `video | image | audio | text | caption` as a render kind. That is a small change
**only after EL3**: today 17 modules decide synthetic ids and clip kind on their own (00 G4), and
without EL3 both frame plans would call `__shape__` a video while the critic and the mission rubric
reported it as a missing asset. After EL3 it is one entry in one helper module per runtime, plus the
switch arms that need new behaviour (frame plan, compiler, monitor).

---

## 3. Schema versions (MD-E6)

**Why bump at all** when `Effect.params` is already an open record: an older FramePilot would open a
project containing `__shape__` clips, treat `__shape__` as a missing media file, and render without
the shapes — a silent loss. The loader already refuses newer formats with a clear message
(`migrations.ts:401-417`, `NEWER_SCHEMA_MESSAGE` "Update FramePilot to open this project."). A bump
turns silent loss into that message.

| Version | Lands with | Change                                                                                               | Migration                                                        |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **v25** | EL4a       | `ShapeParams` defined and exported; `__shape__` recognised; the `shape` effect type validated        | passthrough (no v24 project contains a shape) + round-trip tests |
| v26     | EL10       | `AssetMedia.animation: { frameCount, loopSeconds, frameDurationsMs? } \| null` for animated stickers | passthrough; nullable, as every `AssetMedia` field is            |

No bump for animation (EL7): In/Out are layer transitions (existing effect types every build
understands) and loops are ordinary keyframes generated by a builder (the scope review's change 6).
No bump for EL2a either: honouring a still's crop and a title's In/Out params changes rendering, not
the file format.

Phases that land in the same release share one bump. Obligations per bump (the CT7 checklist):
`SCHEMA_VERSION`, migration + tests, Pydantic twin, `pnpm schema:generate` + drift tests, engine
fixtures importing the constant (the engine loader requires an exact envelope version), ADR,
`docs/api` schema notes.

---

## 4. Synthetic assets and clip kind in one place (EL3, structural)

Today the same two questions — "is this asset id synthetic?" and "what kind of clip is this?" — are
answered in 17 modules (00 G4). Adding `__shape__` to 17 copies is how they drift.

- **TS:** `packages/editor-core/src/synthetic-assets.ts` exports `SYNTHETIC_ASSET_IDS`,
  `isSyntheticAssetId`, `hasTimeBasedSource`, `ClipRenderKind`, `clipRenderKind(clip,
assetKindOf)` and `laneTypeForKind` (`shape` / element `image` / `text` → `overlay`). Every TS
  site in the G4 list imports from it — including the private `SYNTHETIC_ASSET_IDS` sets in
  `critic.ts:189` and `eval/mission-rubric.ts:230`.
- **Python:** `engine/python/framepilot_engine/timeline/synthetic_assets.py` is the one definition;
  `frame_plan.clip_kind`, `operations.py`'s `has_time_based_source`, `text_overlay.py` and
  `preview_text.py` import it.
- **Guarded:** one test per runtime fails if a literal `'__text__'` / `'__caption__'` / `'__shape__'`
  or an `=== TEXT_OVERLAY_ASSET_ID`-style comparison appears outside the helper module.
- **Pinned:** `tests/fixtures/clip-kind.json` — (asset id, asset kind) → kind, read by a vitest and a
  pytest, so the runtimes cannot disagree.
- Behaviour-neutral: no output changes; every existing test passes unchanged.

---

## 5. Other model decisions

| Decision                                                                                                                   | Why                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Favourites, recents, the shapes colour row and the chosen skin tone live in the **user settings store**, never the project | View state (AGENTS.md invariant 5; `useViewPreference` doc): nothing there can change a frame of the output                                                                                                               |
| No `Clip.graphic` generalisation of text + shape                                                                           | Text already works through `__text__` + `text` effect; a unifying field would be a migration of every title for no user outcome today. Recorded as a considered alternative in the EL4a ADR                               |
| Stickers keep the renderer's fit + transform scale rather than a new sticker box                                           | Zero new placement pipeline; `PreviewTransform` already edits it. Trade-off: a sticker keeps its pixel size, not its frame-relative size, when the project orientation changes — covered by a test and noted in the guide |
| Line/arrow shapes are placed by endpoints, not box + rotation                                                              | The user's intent is "point at that"; endpoints are the natural handles and the natural agent arguments                                                                                                                   |
| `drawOn`, `label` are optional keys, absent until their phase                                                              | A v25 project never contains them; the validator accepts them only once their phase ships                                                                                                                                 |

---

## 6. Reversibility and cross-runtime tests

- `add_shape`: apply + invert round trip, id determinism, same-track overlap refused with the
  existing message, `operation-algebra.property.test.ts` includes it.
- `set_effect_params` on a shape: invalid merges refused before apply; apply + invert.
- `addStickerPatch` / `addShapePatch`: property tests over random timelines — never overlaps a lane,
  always one patch, undo restores the exact prior project (deep-equal), second add of the same
  sticker creates no second asset.
- Python mirror: `timeline/operations.py` `AddShape` + `_apply_add_shape`;
  `cross-runtime-operation-behavior.test.ts` gains the op so both runtimes produce byte-identical
  timelines.

**Last updated:** 2026-09-26
