# 09 — Phases

Each phase is one coherent, reviewable goal (one PR, or a short stack of PRs), ends in something
usable or provably correct, and is checked off only when its Definition of Done holds (AGENTS.md
§9). **A category ships complete — UI, engine, undo, export, its agent tool and one evaluation
case — or it does not ship**: no placeholder sub-tabs, no disabled tiles, no backend-only phase
marked done.

Shaped by the 2026-09-26 product-scope review (README §7, verdict **SHRINK**): small first slices,
the agent path proven inside each category's slice, no second geometry implementation, no new
effect type for loops, and each maintainer decision asked when its phase needs it.

Conventions for every phase: branch in the main checkout, commit and push per step, stage explicit
paths only, no attribution trailers; run the tests you touched, CI runs the rest (verify on the
PR's head SHA); update `plan/PLAN.md`, this plan's ledger, docs and `CHANGELOG.md` in the same phase.

**Order.** EL1 runs in parallel with everything. The minimum vertical slice is
**EL2a → EL3 → EL4a**. Stickers start at EL6a once EL2a is in.

---

## EL0 — The two decisions and one spike the first slice needs `[ ]`

- [ ] **EL0.1** Maintainer answers **MD-E6** (schema v25) and **MD-E7** (rail order). Every other
      MD is asked in the phase that needs it (README §1 table, "Needed before").
- [x] **EL0.2** Product-scope review of this plan (README §7) — verdict SHRINK, changes adopted.
- [ ] **EL0.3** Spike A — shape raster: prototype `shape_raster.py` for the six EL4a shapes;
      measure at 1080p and 4K (a rough pre-spike already measured 6.9 ms / 26.5 ms, 05 §2.2); time
      the desktop round trip through the existing raster route. Report:
      `plan/elements/spikes/EL0.3-shape-raster.md`.

**DoD:** two answers recorded in README §1; the spike report committed with numbers.

---

## EL1 — Stock becomes Elements (Photos · Videos) `[ ]`

**Ships:** the rename and the panel shell, with no behaviour change to Pexels search, preview,
download, quota or placement. Small, independent; needs MD-E7.

- [ ] **EL1.1** `apps/web-editor/src/components/elements/ElementsPanel.tsx`: sub-tab strip
      (`role="tablist"`), only the sub-tabs this build can serve, remembered sub-tab
      (`useViewPreference('elementsTab')`), first-open rule (02 §2).
- [ ] **EL1.2** `StockPanel.tsx` → `elements/PexelsBrowser.tsx` with a `kind` prop; the
      `<select>` removed; placeholders and labels per 08 §1; every behaviour kept. Tests move with
      it (`PexelsBrowser.test.tsx`); kind-select cases become sub-tab cases.
- [ ] **EL1.3** `Editor.tsx`: id `'elements'`, label, `Shapes` icon (via `icons.tsx`), position
      after Assets, `coerceLeftTab` alias `'stock' → 'elements'`, `DESKTOP_ONLY_TABS`,
      `elementsEl`.
- [ ] **EL1.4** Copy (08 §1): the bridge's desktop-only detail, Settings group title + line,
      `toolMeta` labels, `DOMAIN_LABEL.sourcing`, the browser backstop note.
- [ ] **EL1.5** Docs: new `docs/guides/elements.md` (hub; Photos & Videos section), retitle
      `stock-sourcing.md`, `settings.md`, `configuration.md`, `system-map.md`; website privacy
      heading; `CHANGELOG.md` → Changed.
- [ ] **EL1.6** Tests: `ElementsPanel.test.tsx` (switching, remembered tab, first-open rule,
      browser absence), `Editor.test.tsx` and `view-prefs-persist.spec.ts` (a stored `'stock'`
      opens Elements), `elements.spec.ts` replacing `stock-sourcing.spec.ts`, visual baselines
      refreshed if the rail is in them.

**DoD:** a person who left the rail on Stock reopens on Elements → Photos/Videos with the same
results; every former Stock test passes under its new name; e2e green on the PR head.

---

## EL2a — Stills and titles: opacity, fades, crop, and the title's own In/Out `[ ]`

**Ships:** fixes for four live gaps (00 G1, G6, G11), and the foundation every element animation
needs. No new user surface.

- [ ] **EL2a.1** Failing tests first (pytest + vitest): a still with an `opacity` keyframe; a still
      with a fade/dissolve transition; a still with a crop (the autoReframe case: a landscape photo
      in a portrait project must fill the frame); a title with `opacity`; a title with each of its
      `inAnimation`/`outAnimation` presets (`fade`, `slide-up`, `slide-down`, `pop`).
- [ ] **EL2a.2** Compiler: `_compile_image_clip` honours crop and goes through `_attach_mask`
      (opacity × fade envelope); `_compile_text_clip` goes through `_attach_mask` and applies the
      title's In/Out envelope. `_attach_mask` **multiplies** a layer's own alpha (PNG/WebP
      transparency, glyph coverage) instead of replacing it.
- [ ] **EL2a.3** Frame plans (`frame_plan.py`, `frame-plan.ts`): stills carry crop and opacity;
      titles carry opacity and the In/Out envelope, ported from `editor/textOverlay.ts`
      (`animationProgress` / `animationTransform`) so the math exists once per runtime and
      vectors pin the two together. The "quirks" docstring and `frame-plan.ts:914`'s comment go
      with the quirks.
- [ ] **EL2a.4** Monitor: the image and text branches of the layer engine apply the plan's opacity,
      envelope and crop with the same own-alpha rule.
- [ ] **EL2a.5** Oracle rows: `stills/opacity-keyframes`, `stills/fade-in`, `stills/crop-cover`,
      `stills/alpha-times-opacity`, `text/opacity`, `text/in-fade`, `text/in-slide-up`,
      `text/out-pop`.
- [ ] **EL2a.6** Goldens regenerated where a fixture had such a still or title; ADR "A still is a
      picture layer like any other"; `CHANGELOG.md` → Fixed (photos fade and crop, titles animate
      in and out in the export).

**DoD:** each case in EL2a.1 gives the expected pixels in the export **and** the monitor; new
oracle rows pass; vectors equal; no existing row regresses; CI green.

## EL2b — Stills and titles: masks, edge styles, geometry transitions `[ ]`

Lands **with its first consumer**, not before: edge styles and masks with EL6b (sticker outline,
shadow, masking), geometry transitions (zoom, slide, wipe passes) with EL7 (In/Out).

- [ ] **EL2b.1** Masks and edge styles for stills and titles; edge styles read the layer's own
      alpha when it has no mask stack (`render/edge_styles.py` + the preview's edge passes).
- [ ] **EL2b.2** Catalogue and geometry transitions for stills and titles in the compiler, both
      frame plans and the monitor.
- [ ] **EL2b.3** Oracle rows: `stills/mask-ellipse`, `stills/edge-outline`, `stills/zoom-in`,
      `text/slide-in`.

---

## EL3 — One definition of synthetic assets and clip kind per runtime `[ ]`

**Ships:** a behaviour-neutral refactor. Adding `__shape__` must be a change to one module per
runtime, not to 17 (00 G4).

- [ ] **EL3.1** `packages/editor-core/src/synthetic-assets.ts`: `SYNTHETIC_ASSET_IDS`,
      `isSyntheticAssetId`, `hasTimeBasedSource`, `ClipRenderKind`, `clipRenderKind`,
      `laneTypeForKind`; unit tests. Python twin `timeline/synthetic_assets.py` (the render side
      imports it; `frame_plan.clip_kind` and `operations.py`'s `has_time_based_source` delegate).
- [ ] **EL3.2** Replace every comparison in the 17 modules (00 G4 list), including
      `critic.ts:189` and `mission-rubric.ts:230`'s private `SYNTHETIC_ASSET_IDS` sets.
- [ ] **EL3.3** A guard test per runtime that fails if `'__text__'`, `'__caption__'` or a
      `=== TEXT_OVERLAY_ASSET_ID`-style comparison appears outside the helper module.
- [ ] **EL3.4** `tests/fixtures/clip-kind.json`, read by a vitest and a pytest.

**DoD:** no output change (all tests green, oracle unchanged); the guard tests pass.

---

## EL4a — Shapes: the minimum vertical slice, complete `[ ]`

**Ships (desktop):** six shapes — **highlight box, filled box, ellipse, marker, arrow, underline** —
added at the playhead, styled in the Inspector, moved and resized on the canvas (box handles for
the four boxes, endpoint handles for the arrow and underline), previewed with the engine's own
pixels, exported, undone in one step; the agent can do the same. Depends on EL2a, EL3, MD-E6.

A PR stack, each PR green on its own:

1. **Model** — schema v25 (`ShapeParamsSchema` Zod + Pydantic twin, `SHAPE_ASSET_ID` in the EL3
   helper, passthrough migration + round trip, `pnpm schema:generate` + drift, engine fixtures
   import `SCHEMA_VERSION`); `shape-catalog.json` with the six (timeline-schema + engine mirror +
   drift test); `add_shape` op in TS and Python (apply/invert, `operation-contract`, frame-grid
   arm), validator rules (04 §2.4), cross-runtime behaviour test; ADR "Shapes are drawn by the
   engine".
2. **Engine** — `render/shape_geometry.py` + `render/shape_raster.py` (the only rasteriser),
   `_compile_shape_clip`, frame-plan kind `shape` with bounds computed from params (both runtimes,
   pinned by frame-plan vectors), the raster route's `kind: 'shape'`, monitor drawing and cache,
   render-validation checks (05 §6).
3. **Editor** — `addShapePatch` / `setShapeParamsPatch` / `moveShapeEndpointsPatch` in
   `editor-core/src/element-placement.ts`; a Shapes sub-tab of six tiles (SVG drawn from a
   UI-only TS path helper), click-to-add, keyboard; Inspector **Shape** section (fill, stroke,
   width, corners); box and endpoint handles, one patch per gesture; the Text tab's disabled
   scaffolds replaced by the Elements link; Settings "New elements" hint.
4. **Agent** — `add_shape` and `set_shape_style` (shape ids as a `z.enum` of the catalogue) in a
   new `elements` domain (summary, label, request words + routing test); `toolMeta`; the shapes
   half of `stickers-and-callouts.md`; regenerated descriptions, skills, parity fixture, Python
   mirrors, goldens — each diff reviewed as a token delta; MCP descriptors include both tools.

Evidence (all required for `[x]`):

- [ ] Oracle rows: `shapes/highlight-box`, `shapes/marker-over-video`, `shapes/ellipse-rotated`,
      `shapes/arrow-segment`.
- [ ] One evaluation case: on a screen-recording fixture with known button coordinates, "Put a box
      around the Export button when I say 'export'" — the model finds the button by reading
      `get_frame` (the only grounding this slice has; 11 §2 defers automatic grounding); report the
      **measured hit rate** over repeated runs, not a single pass.
- [ ] One desktop run on a real 5–15 minute screen recording: five callouts placed by hand and by
      the agent, exported, reopened, undone (10 §4 run A, shapes only).
- [ ] e2e (desktop harness or the browser build with the engine stubbed): add a highlight box,
      resize it on the canvas, recolour it, undo. `docs/guides/elements.md` Shapes;
      `CHANGELOG.md` → Added.

**DoD:** the six shapes work end to end by hand and via `add_shape`; oracle rows pass; a v24
project opens unchanged and a v25 project with shapes is refused by a v24 build with
`NEWER_SCHEMA_MESSAGE`; the eval hit rate and the desktop run are reported.

---

## EL5 — Shapes: the whole catalogue `[ ]`

- [ ] **EL5.1** The remaining ~99 shapes and every preset (03 §1.2 → ~200 tiles); generators for
      polygons, stars, rings, bubbles, corners, curved arrows, path shapes; an export-rendered
      contact sheet of every shape and preset reviewed before merge.
- [ ] **EL5.2** The browse surface for a large catalogue: category chips, search, colour row,
      drag to the timeline (`ELEMENT_DND_TYPE` beside `TEXT_OVERLAY_DND_TYPE` in
      `TimelineView.tsx`), the timeline clip glyph + `--clip-graphic` token, `swapShapePatch`.
- [ ] **EL5.3** Stroke styles and caps complete (dashed, dotted, arrow/dot/bar caps on every
      segment shape).
- [ ] **EL5.4** Numbered badges: `label` param drawn by the title rasteriser inside the shape,
      validator (≤ 8 chars), Inspector field, `add_shape` `label`, oracle row.
- [ ] **EL5.5** Icons: `scripts/elements/build_icons.mjs` → Lucide paths in the catalogue's
      `icons` section; Lucide licence file beside it + licence test; Icons chip; oracle row.
- [ ] **EL5.6** Agent: `search_elements` (shapes) — needed once the catalogue is too big to list
      in a tool description.

**DoD:** ~105 shapes, ~200 presets and ~1,600 icons browsable, placeable and exportable; oracle rows
green; contact sheet committed.

---

## EL6a — Stickers: the minimum vertical slice, complete `[ ]`

**Ships:** a curated set of ~200 stickers (≈ 4 MB, committed), placeable by hand and by the agent.
Depends on EL2a, MD-E4.

- [ ] **EL6a.1** `scripts/elements/build_library.py` + `fluent.lock.json` + `collections.json`;
      the curated set's padded full files and thumbnails for **all** 1,595 (≈ 3 MB) committed;
      the generated catalogue (curated items marked `bundled`); `LICENSE-fluent-emoji.txt`;
      catalogue-vs-files test. (Library build dry run — the former spike C — is this task's first
      step.)
- [ ] **EL6a.2** `packages/ai-sdk/src/providers/elements/`: typed catalogue loader + search, shared
      by panel, main and agent; tests.
- [ ] **EL6a.3** Main `ElementsLibrary` + `framepilot:elements:materialize` IPC + preload + bridge;
      tests: unknown id, dedupe, integrity mismatch, missing file, ENOSPC, concurrent same id,
      traversal-shaped ids refused.
- [ ] **EL6a.4** `isElementAsset`, `sourcedAssetId('element', …)`, `addStickerPatch` (folder,
      asset, overlay lane, clip, t = 0 transform) + property tests.
- [ ] **EL6a.5** Stickers sub-tab: grid, search, click-to-add, keyboard; Inspector **Sticker**
      section with Replace.
- [ ] **EL6a.6** Element assets skip enrolment and footage tools; `list_assets` labels them (G9);
      Credits groups identical lines (G10).
- [ ] **EL6a.7** Agent: `add_sticker` host (`ai/sticker-host.ts`) + orchestrator arm that calls
      `addStickerPatch` directly (**never** the stock placement path, which runs the cutaway placer —
      07 §3); `add_clip` / `add_clips` / `move_clip` of an element asset delegate to the same
      builder instead of becoming a cover-cropped cutaway (07 §4); stickers half of the skill;
      regenerated goldens and fixtures.
- [ ] **EL6a.8** Oracle rows `stickers/rest`, `stickers/scaled-rotated`, `stickers/fading`; one
      evaluation case ("add a fire emoji when I say 'this is fire'" — within ±0.3 s, off the face,
      clear of the caption band); `security-reviewer` pass on 06 §5; docs; `CHANGELOG.md` → Added.

**DoD:** the curated stickers work end to end by hand and via `add_sticker`, including undo and
export; the eval case is reported.

## EL6b — Stickers: the whole library `[ ]`

Depends on EL6a, MD-E1, EL2b.1.

- [ ] **EL6b.1** All 1,595 full files fetched from the pinned commit **when packaging the desktop
      app** (an electron-builder `extraResources` step, cached by the lock hash), not in
      `web-editor#build`; `elementsRoot()` prefers the packaged set and falls back to the curated
      set (06 §4); CI size budget.
- [ ] **EL6b.2** Virtualised grid, collection chips, glyph search, favourites star; perf test for
      02 §9.
- [ ] **EL6b.3** Inspector Outline and Shadow (edge styles on the sticker's own alpha, from EL2b);
      the "Enlarged beyond its sharp size" hint; oracle rows `stickers/outline-shadow`,
      `stickers/masked`.

**DoD:** every catalogued sticker is placeable in a packaged build (CI check); budgets met.

---

## EL7 — Animation: In · Out · Loop `[ ]`

Depends on EL2b.2 (geometry transitions), and EL4a or EL6a.

- [ ] **EL7.1** Inspector **Animation** section for stickers, shapes and titles. **In / Out** are
      layer transitions (`add_layer_transition`, the existing op and catalogue — a curated graphics
      subset: fade, pop, slide ×4, wipe, blur-in); the title's control writes them too from now
      on, while the legacy `inAnimation`/`outAnimation` params (honoured since EL2a) stay readable
      and are no longer written. No new schema.
- [ ] **EL7.2** **Loop** as keyframes from an `editor-core` builder (`loop-motion.ts`, the
      `track-follow.ts` pattern): pulse, float, wiggle, bounce, spin, blink — one patch, one undo,
      rendered by the transform pipeline that already exists. Trade-off recorded in the ADR:
      extending a looped clip does not extend its loop until the Inspector's "Re-apply" (or the
      agent) regenerates it; the critic notes a loop that stops before its clip ends.
- [ ] **EL7.3** Agent: `set_element_animation`; skill section on restraint; one evaluation case.
- [ ] **EL7.4** Oracle rows `loop/pulse`, `loop/wiggle`, `stickers/in-pop`, `shapes/out-slide`.

**DoD:** each animation previews exactly as it exports, undoes in one step, and is reachable by the
agent.

---

## EL8 — Agent quality and MCP `[ ]`

- [ ] **EL8.1** Critic/verification checks (07 §4 table) with tests.
- [ ] **EL8.2** Context digest names element clips compactly (07 §5); token delta measured.
- [ ] **EL8.3** `editing-skills-expert` craft pass on `stickers-and-callouts.md`; description under
      the 300-character cap (test).
- [ ] **EL8.4** The remaining evaluation cases (07 §8) in the golden set, with expected timeline
      outcomes; results read from recorded reports.
- [ ] **EL8.5** MCP: verify the element tools end to end; optional MCP sticker materialiser with
      `FRAMEPILOT_ELEMENTS_ROOT` (`.env.example` + `turbo.json` `globalEnv` in the same commit);
      `docs/api/mcp-server.md`.

---

## EL9 — Photos and Videos grow up `[ ]`

- [ ] **EL9.1** Category chips as curated queries (cached; each chip is one request, stated in the
      quota strip).
- [ ] **EL9.2** Orientation filter (default: the project's orientation).
- [ ] **EL9.3** Drag a photo/video tile to the timeline (download, then place at the drop).
- [ ] **EL9.4** **Add as overlay** for manual placement (MD-E5): a front lane, scaled to 40%,
      centred; ADR superseding ADR 0140's gating role for manual placement; the agent's rule is
      unchanged until measured.
- [ ] **EL9.5** Tests (a panel-matrix row for each), docs.

---

## EL10 — Animated stickers (optional pack) `[ ]` — gated on MD-E3

- [ ] **EL10.0** Spike B (moved here): decode Noto `1f600` with Pillow and with Chromium's
      `ImageDecoder`; compare frames, durations and loop; memory at display size.
- [ ] **EL10.1** Mirror or pin the 881 Noto animated WebPs with SHA-256 pins; host allowlist.
- [ ] **EL10.2** On-demand download in `ElementsLibrary` (progress, cancel, size cap, pin check,
      per-user cache, copy into the project); download registry.
- [ ] **EL10.3** Schema v26 `AssetMedia.animation`; engine `AnimatedImageClip`; monitor
      `ImageDecoder`; timing vectors; oracle rows.
- [ ] **EL10.4** Credits: `attributionRequired: true` → Required group; tile badge.
- [ ] **EL10.5** Agent: `search_elements` returns `animated`; `add_sticker` downloads when needed.

**DoD:** an animated sticker previews frame-exact with the export across loop boundaries; the credit
appears in Credits; already-downloaded stickers work offline.

---

## EL11 — Polish `[ ]`

- [ ] **EL11.1** Favourites and Recents (user settings store).
- [ ] **EL11.2** Skin tones (bundle vs tone pack decided with the measured 30 MB).
- [ ] **EL11.3** "Add as sticker" for the user's own images (bin context menu → sticker placement).
- [ ] **EL11.4** Drop onto the program monitor at a position.
- [ ] **EL11.5** Follow subject for stickers (`track-follow.ts`, Inspector + `follow_subject`).
- [ ] **EL11.6** Browser build: Shapes with a `Path2D` fallback raster labelled "Preview
      approximate", and the curated stickers through `importMedia` — or both stay absent, decided
      with a test (06 §6).
- [ ] **EL11.7** `accessibility-responsive-auditor` and `ui-ux-critic` passes; fixes.

---

## EL12 — Close-out `[ ]`

- [ ] **EL12.1** `docs/guides/elements.md` complete; `docs/api` (schema v25–v26, raster route,
      IPC); `mcp-server.md`; ADR index.
- [ ] **EL12.2** `CHANGELOG.md` and the website changelog (`changelog-maintainer`).
- [ ] **EL12.3** The remaining desktop evidence runs (10 §4) with committed reports.
- [ ] **EL12.4** `plan/PLAN.md` and this plan's ledger reconciled; deferred items listed.

**Last updated:** 2026-09-26
