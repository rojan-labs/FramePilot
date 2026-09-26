# 00 — Current state (verified 2026-09-26 on `origin/main` @ `98ea829a`)

Everything here was read in the tree or reproduced, not recalled. Line numbers are at `98ea829a`.

---

## 1. The Stock surface, layer by layer

### 1.1 Renderer (web-editor)

| Where                                                         | What it does today                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web-editor/src/components/Editor.tsx:134-142`           | `LEFT_TAB_IDS` includes `'stock'` (last of seven)                                                                                                                                                                                                                                        |
| `Editor.tsx:161-169`                                          | `LEFT_TABS`: `{ id: 'stock', label: 'Stock', icon: ImagePlus }`                                                                                                                                                                                                                          |
| `Editor.tsx:172`                                              | `DESKTOP_ONLY_TABS = {'sounds','stock'}` — absent in the browser build, by design                                                                                                                                                                                                        |
| `Editor.tsx:206`                                              | `coerceLeftTab` — a stored tab this build does not render falls back to the default                                                                                                                                                                                                      |
| `Editor.tsx:292`                                              | `useViewPreference<LeftTab>('leftTab', 'media', …)` — the rail tab is persisted in `localStorage` under `framepilot.view.leftTab`                                                                                                                                                        |
| `Editor.tsx:659-698`                                          | `stockEl`: mounts `StockPanel`, computes `stockPlacementBlockedReason` per tile from the live playhead, applies `addStockClipPatch` at click time, opens Settings → AI                                                                                                                   |
| `Editor.tsx:908`                                              | `{leftTab === 'stock' && stockEl}`                                                                                                                                                                                                                                                       |
| `apps/web-editor/src/components/StockPanel.tsx` (1,025 lines) | Search box + **kind select** (Video/Photos) + Pexels credit in one row; quota strip; masonry grid; hover-scrub preview (`useScrubPreview`); per-tile Add/Retry/Cancel/progress; "In this project"; keyboard roving focus; load-more button (never infinite scroll, requests are metered) |
| `StockPanel.test.tsx` (1,052 lines, 42 tests)                 | CONTRACTS §5 UI matrix, hover-scrub, keyboard                                                                                                                                                                                                                                            |
| `apps/web-editor/src/editor/download-registry.ts:134`         | `stockDownloads` — download state survives a tab switch                                                                                                                                                                                                                                  |
| `apps/web-editor/src/editor/bridge-base.ts:474+`              | `stockSearch/Thumbnail/Preview/Download/DownloadCancel/Quota` bridge helpers; desktop-only answer in the browser                                                                                                                                                                         |
| `apps/web-editor/src/components/SettingsDialog.tsx:1316-1427` | `StockMediaSettings`, titled **"Stock media"**, inside the **AI** section (`:1744`): write-only Pexels key, quota readout                                                                                                                                                                |
| `apps/web-editor/src/components/ai/toolMeta.ts:114-115`       | Agent tool labels "Search stock media" / "Add a stock shot"                                                                                                                                                                                                                              |
| `apps/web-editor/src/components/CreditsSection.tsx`           | Required vs Suggested credits from `Asset.source`; Pexels items are Suggested                                                                                                                                                                                                            |
| `apps/web-editor/src/components/OverlaysPanel.tsx:48-53`      | The **Text** tab's type picker scaffolds `shape` and `image` as **disabled** types ("until the engine supports them")                                                                                                                                                                    |
| `apps/web-editor/src/styles.css`                              | `.stock-*` classes (panel, grid, tile, quota strip, progress)                                                                                                                                                                                                                            |

### 1.2 Desktop main

| Where                                                                | What it does                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/electron/media/stock-service.ts` (1,181 lines)         | Search cache (5 min, 50 entries), thumbnail/preview byte caches (40 MB / 120 MB), streaming download with size cap, stall timeout, temp→atomic rename, `sources.json` ledger dedupe, derive via sidecar, provenance |
| `apps/desktop/electron/media/stock-quota.ts`                         | Observed-not-counted quota store (ADR 0141)                                                                                                                                                                         |
| `apps/desktop/electron/media/sourced-asset-id.ts`                    | `sourcedAssetId('stock' \| 'music', provider, remoteId)` — the one id formula; `stock_pexels_<id>` is **persisted** in projects and the brain                                                                       |
| `apps/desktop/electron/ai/stock-host.ts`                             | `add_stock` host: download in main, return the asset, **edit nothing**; the orchestrator builds the patch                                                                                                           |
| `apps/desktop/electron/ipc/contract.ts:88-95`, `preload.cts:194-201` | Channels `framepilot:stock:{search,thumbnail,preview,download,download-cancel,download-progress,quota,quota-changed}`                                                                                               |
| `apps/desktop/electron/main.ts:914-935, 1483-1546, 2637, 2824-2839`  | Wiring of the quota store, service, IPC handlers and the agent host                                                                                                                                                 |
| `apps/desktop/electron/security/media-protocol.ts:186-192`           | CSP: `img-src 'self' fp-media: blob: data:`; `connect-src` has **no** provider origin (the renderer never reaches Pexels)                                                                                           |

### 1.3 Shared packages

| Where                                                                                   | What it does                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared-types/src/ipc.ts:1895+`                                                | `Stock*Wire` types; `PreviewTextRasterRequest` (`:793`)                                                                  |
| `packages/ai-sdk/src/providers/stock-types.ts`, `pexels-stock.ts`                       | Provider contract and the Pexels adapter (Zod at the boundary, https-only URLs)                                          |
| `packages/ai-sdk/src/domain-tools/media.ts:127-160, 320-355`                            | `search_stock` / `add_stock` (`hostUiOnly: true`)                                                                        |
| `packages/ai-sdk/src/tool-domains.ts:78, 225, 332`                                      | `sourcing` domain: "find and place stock footage and music"; the regex that routes "stock/b-roll/cutaway" requests to it |
| `packages/ai-sdk/src/stock-placement.ts`, `packages/editor-core/src/stock-placement.ts` | One placement builder shared by the panel and `add_stock` (cutaway, lifted in front per ADR 0169)                        |
| `packages/editor-core/src/picture-occupancy.ts:341, 489`                                | `coverageVerdict`, `picturePlacementConflict`                                                                            |
| `packages/ai-sdk/src/domain-tools/picture-layers.ts`                                    | Agent refusal of scaled / positioned / faded / blended picture placements over picture (ADR 0169/0170)                   |
| `packages/ai-sdk/skills/broll-and-layering.md`                                          | The only skill that explains `search_stock` / `add_stock`                                                                |

### 1.4 Engine, docs, website, tests

| Where                                                                                                            | What                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `engine/python/framepilot_engine/ai_tools/registry.py:494-537, 945, 1790`                                        | Refusals that name `search_stock` / `add_stock` for `stock://` URIs                                      |
| `docs/guides/stock-sourcing.md`                                                                                  | User guide "Stock photos and video"                                                                      |
| `docs/guides/settings.md:62-68`, `configuration.md:125`, `architecture/system-map.md:47`, `api/mcp-server.md:31` | Mentions of Stock media / the Pexels key / the stock IPC                                                 |
| `docs/adr/0138`–`0141`, `0143`, `0147`–`0150`, `0169`, `0170`, `0180`                                            | Provenance, main-process fetch, cutaway placement, quota, sourcing behaviour, coverage rules, compositor |
| `apps/website/src/app/legal/privacy/page.tsx:56-58`                                                              | "Stock photos & video" privacy paragraph                                                                 |
| `tests/e2e/specs/stock-sourcing.spec.ts`                                                                         | Browser build: the Stock tab is **absent**; no provider host appears in the page                         |

---

## 2. Systems Elements reuses (all present on `98ea829a`)

| Need                                                    | Existing primitive                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlays that preview truthfully                        | Layer compositor is the default in **every** build (`compositor-flag.ts`, ADR 0180 amendment 2026-09-25); PX4 oracle **72/72**                                                                                                                                         |
| A clip with no media file, drawn by the engine          | `add_text_overlay` → `assetId: '__text__'` + a `text` effect (`editor-core/src/operations.ts:815, 2152`; Python mirror `timeline/operations.py:1222`)                                                                                                                  |
| Engine-drawn raster shown on the desktop monitor        | `POST /preview/text-raster` (`service.py:1211, 6771`) + `preview/engine/engine-text-rasters.ts` (cache by pixels-affecting params); since the 2026-09-25 caption amendment it also takes a `frame_time` and answers `animated: true` for rasters that change over time |
| Placement, position, scale, rotation, opacity keyframes | `add_keyframes`, `PreviewTransform.tsx` (drag / corner scale / rotate, one patch per gesture)                                                                                                                                                                          |
| In/Out animation of a layer                             | `add_layer_transition` (`operations.ts:382`) + the 60+-entry transition catalogue                                                                                                                                                                                      |
| Follow a subject                                        | `editor-core/src/track-follow.ts` (plans keyframes from a measured track; no new op)                                                                                                                                                                                   |
| Lanes that never collide                                | `createLaneAllocator` (`editor-core/src/lane-placement.ts:135`)                                                                                                                                                                                                        |
| Bin folder in the same patch                            | `create_folder` (`editor-core/src/project-operations.ts:47`)                                                                                                                                                                                                           |
| Provenance and credits                                  | `Asset.source` (schema v20), `CreditsSection` Required/Suggested                                                                                                                                                                                                       |
| Big virtualised grid                                    | `@tanstack/react-virtual` (already a web-editor dependency)                                                                                                                                                                                                            |
| Icons                                                   | `lucide-react@0.577.0` has `Shapes`, `Sticker`, `SmilePlus`, `LayoutGrid`                                                                                                                                                                                              |
| Catalogue shared by TS and Python                       | Caption templates (`timeline-schema/schema/caption-templates.json` ↔ `render/caption_templates.json`, drift-tested)                                                                                                                                                    |
| Default overlay duration                                | `settings.defaultOverlaySeconds` (used by `OverlaysPanel.tsx:133`)                                                                                                                                                                                                     |
| Timeline drop of non-asset payloads                     | `TEXT_OVERLAY_DND_TYPE` handled at `TimelineView.tsx:2936-2960`                                                                                                                                                                                                        |

---

## 3. Gaps found

### G1 — Stills and text ignore opacity and transitions (reproduced)

`compiler.py:444-450` `_compile_image_clip` applies only the colour grade and the placement.
`compiler.py:453-473` `_compile_text_clip` applies only the placement. Neither calls `_attach_mask`
(opacity × transition alpha), `_apply_catalog_transition`, masks, or edge styles. Both frame plans
describe the export faithfully, so they omit the same things (`frame_plan.py:21-23`: "a still image
ignores its crop and opacity keyframes"; `frame-plan.ts:914`: "The export places a still without
its crop, mask, opacity or transition"; `_text_layer` sets no opacity). Preview and export
therefore **agree** — the PX4 oracle passes — and the capability is simply missing.

Reproduced 2026-09-26 with `grab_frame(lossless=True)` on a 640×360 project: white still
background, a 200×200 RGBA sticker (red square) on an overlay lane:

| Case                                                  | Centre pixel                      | If honoured       |
| ----------------------------------------------------- | --------------------------------- | ----------------- |
| sticker, no keyframes                                 | (255, 0, 0)                       | (255, 0, 0)       |
| sticker, `opacity` keyframe 0.25                      | **(255, 0, 0)**                   | ≈ (255, 191, 191) |
| sticker, `transition` fade-in 1.5 s, sampled at 0.3 s | **(255, 0, 0)**                   | pink              |
| text "HELLO", `opacity` 0.25                          | red-pixel count unchanged (1,856) | red → 0           |

Consequences today: the Inspector's opacity control on a **photo** or a **title** does nothing in
preview or export; a fade transition on a photo does nothing. For Elements it blocks every In/Out/
Loop animation of a sticker or shape. **Fixed in EL2a, first.**

### G2 — No shape exists anywhere

No clip kind, op, raster or UI. The Text tab shows a disabled "Shape" type (`OverlaysPanel.tsx:51`).

### G3 — The agent's cutaway placer, and the trap it sets for stickers

`picture-layers.ts` refuses a scaled, positioned, cropped, masked, faded or blended picture
placement over picture, because "the preview paints ONE picture layer at a time" — false in every
build since the ADR 0180 amendment, which left relaxing it to the AI layer. Its reach is narrower than
it looks: `createPicturePlacer` is called only from `add_clip`, `add_clips`, `move_clip`
(`domain-tools/timeline.ts:1395, 1515, 1560`) and the `add_stock` path
(`ai-sdk/src/stock-placement.ts:201`), and it only counts `video` lanes (`carriesPicture`,
`picture-layers.ts:128`). A sticker placed on an overlay lane by its own builder never meets it.

The trap is the other direction: `add_clip` of a sticker asset onto a video lane is treated as a
footage cutaway — in a portrait project `autoReframeCrop` gives it a cover crop and the placer lifts
it as full-frame. **EL6a** routes element assets in `add_clip` / `add_clips` / `move_clip` to the
sticker builder, and `add_sticker` never uses the stock placement path.

### G4 — Synthetic asset ids and clip kind are decided in 17 modules

Clip kind is derived by `frame_plan.py:87` `clip_kind`, `frame-plan.ts:447` `clipKindOf`,
`ai-sdk/src/project-index.ts:88` `clipKindOf`, `editor-core/src/stock-placement.ts` `clipKindOf`,
`patch-builders-base.ts` (`assetKind` / `layerTypeForKind`, `:1583`) and `selectors-base.ts`; and
**17** non-test modules compare against `__text__` / `__caption__` directly or through their
constants: `selectors-base.ts`; `frame_plan.py`, `preview_text.py`, `text_overlay.py`,
`timeline/operations.py` (`has_time_based_source`, `:647`); ai-sdk `context-builder.ts`,
`critic.ts` (its own `SYNTHETIC_ASSET_IDS`, `:189`), `domain-tools/graphics.ts`,
`domain-tools/motion.ts`, `eval/mission-rubric.ts` (another `SYNTHETIC_ASSET_IDS`, `:230`),
`project-index.ts`, `verify.ts`; editor-core `frame-plan.ts`, `mask-operations.ts`, `operations.ts`
(`hasTimeBasedSource`, `:833`), `stock-placement.ts`; `timeline-schema/src/index.ts`.

Adding `__shape__` without consolidating would make both frame plans call a shape a **video**, and
the critic and the mission rubric report every shape as a missing asset. **EL3** gives each runtime
one helper module and a guard test first.

### G5 — Stock placement is cutaway-only, for people too

ADR 0140's refusal is enforced in the panel (`stockPlacementBlockedReason`), for manual placement as
well as the agent. Its premise was the flat monitor. **EL9** (MD-E5).

### G6 — A title's In/Out control does nothing on desktop

The Inspector writes `inAnimation` / `outAnimation` / `animDurationSeconds` into a title's `text`
params. The export ignores them (`text_overlay.py` docstring). So does the default monitor: the layer
engine draws a title from a static raster (`layer-preview-engine.ts:864-894`), and the DOM overlay
above it is a transparent hit target; only the legacy engine and the selected title's DOM editor box
animate. The control is as dead as G1's opacity. **EL2a** renders the four presets (fade, slide up,
slide down, pop) in both frame plans and the compiler, ported from `editor/textOverlay.ts`.

### G7 — The Stock panel mixes two libraries behind a dropdown

One grid, a Video/Photos `<select>` (`StockPanel.tsx:537-553`). CapCut separates them. **EL1.**

### G8 — A user's own PNG cannot be used as a sticker

Imported images are placed fit-to-frame as a cutaway by `placeAssetPatch`. **EL11** adds "Add as
sticker".

### G9 — Materialised elements would be treated as footage

Acquired assets are enrolled for footage understanding and appear in `list_assets` like footage
(ADR 0175 enrolment on commit). A sticker is not footage: indexing it wastes analysis calls and
pollutes the agent's footage map. **EL6a** excludes element assets from enrolment and labels them in
the agent's asset views.

### G10 — Credits would list one row per sticker

`CreditsSection` renders a row per asset with a source. Twenty stickers from one library would be
twenty identical rows. **EL6a** groups identical credit lines.

### G11 — A still's crop is recorded, believed, and not drawn (found by the scope review)

In a portrait project `add_clip` gives a landscape still a cover crop (`autoReframeCrop`,
`domain-tools/timeline.ts:451`) so it fills the frame. `visibleRect` (`picture-occupancy.ts:184`)
counts that crop, so the coverage check believes the still covers the footage behind it. But the
export's `_compile_image_clip` and both frame plans (`honour_crop=False`) ignore a still's crop:
monitor and export agree with each other, and both show the photo letterboxed with the A-roll
visible through the bars — the "no black bars" brief the reframe exists for, quietly failed.
**EL2a** makes stills honour crop.

---

## 4. Old blockers that no longer apply

| Old blocker                                                       | Status now              | Evidence                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SUC-P1 "single-picture-layer preview" (why stock is cutaway-only) | **Gone** in every build | ADR 0180 amendment 2026-09-25; `compositor-flag.ts` returns `layers` unset; PX4 72/72                                                                                                                                      |
| "Production still runs the legacy monitor"                        | **Gone**                | same                                                                                                                                                                                                                       |
| Animated WebP needs a new decoder                                 | **Not needed**          | the engine's Pillow 12.3 (libwebp 1.6.0) decodes Noto's 512 px animated WebP: RGBA, 48 frames, loop 0, **variable** frame durations (90 ms then 30 ms; 2.1 s loop) readable after `seek()` + `load()` (checked 2026-09-26) |
| Stickers need a new image library                                 | **Not needed**          | MoviePy `ImageClip(path)` keeps PNG/WebP alpha; the layer engine loads images with `createImageBitmap` straight alpha (`layer-preview-engine.ts:558-570`)                                                                  |

**Last updated:** 2026-09-26
