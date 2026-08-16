# Phase 2 — Type-Agnostic Layers + Render Order (multi-agent progress tracker)

> **This file is the source of truth for Phase 2 and is designed to be picked up by
> any coding agent.** Before starting a milestone: read this whole file, then
> `git log`/run the listed tests to confirm the current state. After finishing work:
> tick the milestone boxes, append a dated entry to the **Progress Log**, and update
> the **Status** line. Keep every commit green (see Invariants + Verification).

- **Status:** **ALL milestones M1–M7 done** — type-agnostic layers shipped end-to-end
  (foundational ops, derived clip kind, render index-0-front, validator, auto-layering +
  `move_layer`, generic layer UI, AI/MCP surface). All unit suites green
  (editor-core 153, web-editor 393, ai-sdk 108, Python engine 428). Known-unrelated reds
  only (desktop `require()` lint, e2e blocked by HomeScreen WIP).
- **Owner of last edit:** Claude (2026-06-29)
- **Parent plan:** `plan/PLAN.md` §9.5 · **Phase 1 ADR:** `docs/adr/0031-*`
- **Design ADR:** `docs/adr/0032-type-agnostic-layers.md`

---

## Goal (user requirements, verbatim intent)

1. A **single, generic timeline** — layers are **not** typed as audio/video/caption.
2. Adding a clip of a **different kind** creates a **new layer on top**.
3. **Overlapping** same-kind clips is allowed, but the overlapping clip goes onto a
   **new layer on top** (never an overlap on one layer).
4. **Render order is hierarchical: array index 0 is in front**, compositing first→last
   (index 0 on top of index 1 on top of … of the last).

---

## Design decisions (decided — do not relitigate without updating ADR 0032)

- **A layer is a `Track`** (we keep the existing `Track` type name to limit churn; read
  it as "layer"). The `Track.type` field is **retained but downgraded to an advisory
  role** — a default icon/label and the "kind" used by auto-layering. It is **no longer
  a hard constraint**: any clip kind may live on any layer.
- **A clip's renderable kind is derived, not stored.** Source of truth =
  the clip's asset `kind` (`video`/`audio`/`image`) or its synthetic asset id
  (`__text__` → `text`, `__caption__` → `caption`). Add one pure helper
  `clipKind(clip, assetById)` (TS, in `selectors.ts`) and `clip_kind(clip, assets)`
  (Python, in `render/compiler.py`) and route ALL behavior through it. **No `kind`
  field is added to the `Clip` schema** (keeps the change shape-stable).
- **Render order: index 0 = visual front.** The compiler composites so the **last**
  array element is at the back and **index 0 is on top** (the opposite of MoviePy's
  default last-on-top, so the build list is reversed).
- **Auto-layering:** when a clip is added/dropped, choose the target layer; if the clip
  would **overlap** an existing clip on it, **or** its kind differs from the layer's
  current content, **insert a new layer at index 0** and place the clip there.
- **Ops added:** `add_layer`, `remove_layer` (lossless inverse pair), `move_layer`
  (reorder/z-order). No project/schema migration of _shape_ is required (tracks are
  already an ordered list and `type` is retained). **`SCHEMA_VERSION` stays 4** unless a
  later milestone adds a field — the render-order flip is a _behavior_ change handled by
  re-rendering + golden updates, not a data migration.

### Invariants to preserve (every milestone)

- Every edit is **one validated, reversible patch** through `validate → apply → record`
  (AGENTS.md). No direct timeline mutation. New ops MUST have exact inverses + tests.
- TS ↔ Python schema parity (`schema/project.schema.json` is generated; parity test).
- 100% coverage on core deterministic modules; no skipped tests.
- No render change without updating golden tests.
- Keep `track.type` valid against the Zod enum until/unless ADR 0032 is revised.

---

## Milestones

### M1 — Foundational layer ops (`add_layer` / `remove_layer`) · [x] DONE

Self-contained, no behavior change to existing flows.

- [x] `editor-core/operations.ts`: `AddLayerOp { type:'add_layer', layerId, layerType, atIndex, clips? }`
      and `RemoveLayerOp { type:'remove_layer', layerId }`. Added to `Operation` union,
      `applyOperation`, `invertOperation` (add↔remove, **lossless**: remove inverts to an
      add restoring the layer's type/index/clips). Guards duplicate id (`duplicate_layer`) /
      missing layer (`missing_track`). Index clamps to `[0,len]`.
- [x] `editor-core/validator.ts`: both registered in `SUPPORTED_OPERATIONS`; new
      `duplicate_layer` code added to `ValidationCode` + `fromOperationError`.
- [x] `web-editor/editor/patch-builders.ts`: `addLayerPatch(timeline, layerType?, atIndex?)`,
      `removeLayerPatch(timeline, layerId)` (deterministic, non-colliding ids).
- [x] Tests: apply/invert round-trips (empty + seeded/non-empty layer), duplicate/missing
      errors (editor-core 150 ✓).
- [x] UI: an **"Add layer"** tool (Plus) in `TimelineView`'s corner tool group inserts an
      empty layer at index 0; tested in `TimelineView.interactions.test.tsx` (web-editor 382 ✓).
- **Acceptance met:** all suites green; add/remove layer is one reversible patch (undo/redo
  via the standard history path).

### M2 — Derive clip kind; stop branching on `track.type` (preview) · [x] DONE

- [x] Added `clipKind(clip, assetById)` + `isPictureKind`/`isOverlayKind` to `selectors.ts`
      (+ tests).
- [x] `PreviewPlayer.tsx`: picks the **topmost** picture clip (video/image) across all
      non-hidden layers by `clipKind`, and overlays (text/caption) likewise — not `track.type`.
- **Acceptance met:** a video/image/text overlay on arbitrary layers preview correctly;
  web-editor suite green.

### M3 — Render compiler: clip-kind + index-0-front order · [x] DONE

- [x] `render/compiler.py`: added `clip_kind(clip, asset_kinds)`. Drives picture/audio/
      deferred handling and `unsupported_track_types` off clip kind, not `TrackType`. Adds
      `_compile_image_clip` (stills render via `ImageClip`). Composites so **index 0 is on top**
      (collect per-track picture lists, then `reversed(picture_by_track)`).
- [x] `has_video_content`/`has_audio_content` scan clip kinds across all layers (respecting
      `hidden`/`muted`); threaded asset kinds from `project.assets`.
- [x] Updated compiler tests (synthetic `__caption__`/`__text__` ids; `_MEDIA_ASSETS`); pure
      `clip_kind` parametrized test. Single-picture goldens unchanged (reverse is a no-op there).
- **Acceptance met:** `pnpm engine:test` 428 green; mixed-content layers render; z-order is
  index-0-front.

### M4 — Validator: allow any kind on any layer · [x] DONE

- [x] Removed the `add_text_overlay`→'overlay' / `add_caption_layer`→'caption' track-type
      constraints in **both** `validator.ts` (TS) and `patch_validation.py` (Python). Kept
      per-layer overlap + audio-link checks. Removed now-dead `layerOrder`/`_layer_order` helpers.
- [x] Updated `validator.test.ts` + `test_patch_validation.py`.
- **Acceptance met:** placing a text/caption clip on any layer validates; overlap still
  rejected.

### M5 — Auto-layering on add/drop + layer reorder (`move_layer`) · [x] DONE

- [x] `move_layer` op (reorder, **same-shape reversible inverse**) in `editor-core` +
      `moveLayerPatch` builder + tests; registered in `SUPPORTED_OPERATIONS`.
- [x] Auto-layering: `placeAssetPatch(timeline, assetById, asset, atStart)` — reuses a
      frontmost same-kind layer with room, else emits a two-op patch (`add_layer` at index 0 +
      `add_clip`). Helpers `assetKind`/`layerKind` in `selectors.ts`.
- [x] Wired into `TimelineView.onDropAsset` (honours the dropped lane when compatible, else
      auto-layers) and `MediaBin.addToTimeline` (replaced `targetTrackType`). Header chevrons
      reorder z-order via `move_layer`.
- **Acceptance met:** dropping a different-kind/overlapping clip creates a new top layer;
  reorder changes z-order; all undoable.

### M6 — Generic layer UI · [x] DONE

- [x] `TimelineView`: header icon/label/colour derived from layer **content** (`layerMeta`
      via `layerKind`), with advisory fallback when empty; every layer gets hide/mute/lock +
      up/down z-order chevrons. Each clip block is coloured by its **own** `clipKind`; audio
      waveform + clip label are kind-driven. Added `is-image` clip colour + `.layer-order` CSS.
- **Acceptance met:** UI reads as generic stacked layers; a11y hooks preserved; web-editor
  393 green.

### M7 — AI/MCP surface · [x] DONE

- [x] `ai-sdk` `context-builder.ts`: `summarizeTimeline` now describes layers by **z-order**
      (front→back, index 0 on top) and derived content kind (threads `assetKinds`). `critic.ts`:
      caption/overlay detection + `contentDuration` derive by clip kind (synthetic ids), not
      `track.type`. Updated fixtures/tests. `mcp-server` dispatches the registry tools (no
      track-type assumptions to change).
- **Acceptance met:** ai-sdk 108 green; AI edits flow through the same validated patch path.

### Optional / later

- [ ] Fully remove `Track.type` (schema v5 migration mapping type→derived role) — only if
      ADR 0032 decides the advisory field should go. Large; needs its own review.

---

## Verification (run before ticking any box)

- TS: `pnpm typecheck`, `pnpm lint`, `pnpm test` (or `--filter` the touched package).
- Python: `pnpm engine:test`, `pnpm engine:lint`, `pnpm engine:typecheck`.
- Schema: after any Zod change, `pnpm --filter @framepilot/timeline-schema build && \
pnpm --filter @framepilot/timeline-schema schema:generate` then re-run its tests.
- Full gate: `pnpm verify`.
- **Known-unrelated reds (do not "fix" as part of Phase 2):** `apps/desktop` lint
  (`require()`), 9 pre-existing `mypy` errors in Python _test_ files, and the e2e suite
  while the in-progress **HomeScreen** boot flow (`apps/web-editor/src/App.tsx`,
  `HomeScreen.tsx`) gates the editor — e2e expects the editor on load.

---

## Risks & notes

- The render-order flip (M3) changes existing renders → **must** land with golden updates,
  ideally in its own commit/PR.
- Auto-layering (M5) and render order (M3) are semantically linked: until M3 lands,
  "index 0 = top" holds in the editor model but not yet in the render. Land M3 close to M5
  to avoid a visible editor/render z-order mismatch, or feature-gate.
- Keep each milestone a separate, reviewable commit. Do not bundle the schema/render
  changes with UI.

## Progress Log

- **2026-06-29 (Claude):** **Completed M2–M7 end-to-end.** Derived clip kind (`clipKind`,
  `assetKind`, `layerKind`) and routed preview, render compiler (index-0-front,
  `_compile_image_clip`), validator (TS + Python, removed track-type constraints),
  auto-layering (`placeAssetPatch` + `move_layer` reorder, wired into drop + media-bin add),
  generic content-derived layer UI (icons/labels/colours + z-order chevrons + image colour),
  and the AI surface (z-order-aware `summarizeTimeline`, kind-based critic). All unit suites
  green: editor-core 153, web-editor 393, ai-sdk 108, Python engine 428; full typecheck 14/14.
  Pre-existing reds untouched (desktop `require()` lint; e2e blocked by HomeScreen WIP).
- **2026-06-28 (Claude):** Created this tracker + ADR 0032. **Completed M1** —
  `add_layer`/`remove_layer` ops (apply + lossless invert) in `editor-core/operations.ts`,
  validator registration + `duplicate_layer` code, `addLayerPatch`/`removeLayerPatch` in
  `patch-builders.ts`, and an "Add layer" tool in `TimelineView`. Tests: editor-core 150,
  web-editor 382; typecheck 14/14; lint clean. **Next: M2** (derive `clipKind`, move the
  preview off `track.type`).
