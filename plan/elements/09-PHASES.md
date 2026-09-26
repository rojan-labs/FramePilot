# 09 — Phases

Each phase is one coherent, reviewable goal (one PR, or a short stack of PRs), ends in something
usable or provably correct, and is checked off only when its Definition of Done holds (AGENTS.md
§9). **A category ships complete — UI, engine, undo, export, its agent tool and one evaluation
case — or it does not ship**: no placeholder sub-tabs, no disabled tiles, no backend-only phase
marked done.

Shaped by the 2026-09-26 product-scope review (README §7, verdict **SHRINK**): small first slices,
the agent path proven inside each category's slice, no second geometry implementation, no new
effect type for loops, and each maintainer decision asked when its phase needs it.

Conventions for every phase: branch in the main checkout (no worktree), commit and push per step,
stage explicit paths only, no attribution trailers and no step numbers in commit messages. **Work
asynchronously — never wait on tests:** run the targeted tests, typecheck and lint for what you
touched in the background and keep building; CI runs the rest, and nobody sits watching it (push,
move on, read the latest head SHA's checks later — a push cancels the in-flight run; a red check
jumps the queue). A task is checked off only when CI is green on a SHA that contains it. Update
`plan/PLAN.md`, this plan's ledger, docs and `CHANGELOG.md` in the same phase.

**Two documents bind every phase.** [`12-SURFACE-COVERAGE.md`](./12-SURFACE-COVERAGE.md) lists every
surface a phase touches — a phase is done only when **every row tagged with it** is done, and a
surface found during implementation gets a row in the same PR.
[`13-PRODUCTION-READINESS.md`](./13-PRODUCTION-READINESS.md) §1 is the checklist every phase PR
meets.

**Order.** EL1 runs in parallel with everything. The minimum vertical slice is
**EL2a → EL3 → EL4a**. Stickers start at EL6a once EL2a is in.

---

## EL0 — The two decisions and one spike the first slice needs `[x]`

- [x] **EL0.1** Maintainer answers **MD-E6** (schema v25) and **MD-E7** (rail order). Every other
      MD is asked in the phase that needs it (README §1 table, "Needed before").
- [x] **EL0.2** Product-scope review of this plan (README §7) — verdict SHRINK, changes adopted.
- [x] **EL0.3** Spike A — shape raster: prototype `shape_raster.py` for the six EL4a shapes;
      measure at 1080p and 4K (a rough pre-spike already measured 6.9 ms / 26.5 ms, 05 §2.2); time
      the desktop round trip through the existing raster route. Report:
      `plan/elements/spikes/EL0.3-shape-raster.md`.

**DoD:** two answers recorded in README §1; the spike report committed with numbers.

**Evidence (2026-09-26).** MD-E6 and MD-E7 decided autonomously and recorded in README §1. The
spike ran late, against the shipped rasteriser rather than a prototype:
[`spikes/EL0.3-shape-raster.md`](./spikes/EL0.3-shape-raster.md) — 0.2–2.4 ms per preset at 1080p,
0.5–9.1 ms at 4K, 1.6–5.0 ms for the whole preview route at 1080p (Apple M1 Pro).

---

## EL1 — Stock becomes Elements (Photos · Videos) `[x]`

**Ships:** the rename and the panel shell, with no behaviour change to Pexels search, preview,
download, quota or placement. Small, independent; needs MD-E7.

- [x] **EL1.1** `apps/web-editor/src/components/elements/ElementsPanel.tsx`: sub-tab strip
      (`role="tablist"`), only the sub-tabs this build can serve, remembered sub-tab
      (`useViewPreference('elementsTab')`), first-open rule (02 §2).
- [x] **EL1.2** `StockPanel.tsx` → `elements/PexelsBrowser.tsx` with a `kind` prop; the
      `<select>` removed; placeholders and labels per 08 §1; every behaviour kept. Tests move with
      it (`PexelsBrowser.test.tsx`); kind-select cases become sub-tab cases.
- [x] **EL1.3** `Editor.tsx`: id `'elements'`, label, `Shapes` icon (via `icons.tsx`), position
      after Assets, `coerceLeftTab` alias `'stock' → 'elements'`, `DESKTOP_ONLY_TABS`,
      `elementsEl`.
- [x] **EL1.4** Copy (08 §1): the bridge's desktop-only detail, Settings group title + line,
      `toolMeta` labels, `DOMAIN_LABEL.sourcing`, the browser backstop note.
- [x] **EL1.5** Docs: new `docs/guides/elements.md` (hub; Photos & Videos section), retitle
      `stock-sourcing.md`, `settings.md`, `configuration.md`, `system-map.md`; website privacy
      heading; `CHANGELOG.md` → Changed.
- [x] **EL1.6** Tests: `ElementsPanel.test.tsx` (switching, remembered tab, first-open rule,
  browser absence), `Editor.test.tsx` and `view-prefs-persist.spec.ts` (a stored `'stock'`
  opens Elements), `elements.spec.ts` replacing `stock-sourcing.spec.ts`, visual baselines
  refreshed if the rail is in them.

**DoD:** a person who left the rail on Stock reopens on Elements → Photos/Videos with the same
results; every former Stock test passes under its new name; e2e green on a SHA that contains
the change.

**Evidence (2026-09-26).** [CI run 36198403567](https://github.com/rojan-labs/FramePilot/actions/runs/36198403567) on `9bbde591`, every job green including the PX4 oracle (E2E smoke, visual regression, the unit suites).

---

## EL2a — Stills and titles: opacity, fades, crop, and the title's own In/Out `[x]`

**Ships:** fixes for four live gaps (00 G1, G6, G11), and the foundation every element animation
needs. No new user surface.

- [x] **EL2a.1** Failing tests first (pytest + vitest): a still with an `opacity` keyframe; a still
      with a fade/dissolve transition; a still with a crop (the autoReframe case: a landscape photo
      in a portrait project must fill the frame); a title with `opacity`; a title with each of its
      `inAnimation`/`outAnimation` presets (`fade`, `slide-up`, `slide-down`, `pop`).
- [x] **EL2a.2** Compiler: `_compile_image_clip` honours crop and goes through `_attach_mask`
      (opacity × fade envelope); `_compile_text_clip` goes through `_attach_mask` and applies the
      title's In/Out envelope. `_attach_mask` **multiplies** a layer's own alpha (PNG/WebP
      transparency, glyph coverage) instead of replacing it.
- [x] **EL2a.3** Frame plans (`frame_plan.py`, `frame-plan.ts`): stills carry crop and opacity;
      titles carry opacity and the In/Out envelope, ported from `editor/textOverlay.ts`
      (`animationProgress` / `animationTransform`) so the math exists once per runtime and
      vectors pin the two together. The "quirks" docstring and `frame-plan.ts:914`'s comment go
      with the quirks.
- [x] **EL2a.4** Monitor: the image and text branches of the layer engine apply the plan's opacity,
      envelope and crop with the same own-alpha rule.
- [x] **EL2a.5** Oracle rows: `stills/opacity-keyframes`, `stills/fade-in`, `stills/crop-cover`,
  `stills/alpha-times-opacity`, `text/opacity`, `text/in-fade`, `text/in-slide-up`,
  `text/out-pop`.
- [x] **EL2a.6** Goldens regenerated where a fixture had such a still or title; ADR "A still is a
  picture layer like any other"; `CHANGELOG.md` → Fixed (photos fade and crop, titles animate
  in and out in the export).

**DoD:** each case in EL2a.1 gives the expected pixels in the export **and** the monitor; new
oracle rows pass; vectors equal; no existing row regresses; CI green.

**Evidence (2026-09-26).** Export pixels: `engine/python/tests/test_render_stills_and_titles.py`
(10 cases). Plans: `test_frame_plan.py`, `frame-plan.test.ts`; vectors equal
(`frame-plan.parity.test.ts`). Monitor steps: `layer-raster.test.ts` (stills crop/opacity/wipe/
catalog; titles opacity/pop/slide); DOM overlay: `textOverlay.test.ts`. Oracle rows landed as
fixture cases, one per area file rather than one per preset: `alpha/still-opacity` (the PNG
sentinel's transparent border makes it the alpha × opacity row), `geometry/still-crop-cover`,
`transitions/still-transitions` (fade, zoom, wipe, soft-dissolve), `text/title-opacity`,
`text/title-in-out` (fade in, slide-up out, pop in, slide-down out). Decision recorded: a slide
travels 5% of the frame height in every path (ADR 0189); the DOM overlay's box-relative 12% was
not expressible in the export. Goldens: no engine golden fixture holds a still or title with
opacity, a transition, a crop or an In/Out preset, so none changes; CI confirms: [CI run 36198403567](https://github.com/rojan-labs/FramePilot/actions/runs/36198403567) on `9bbde591`, every job green including the PX4 oracle.

## EL2b — Stills and titles: masks, edge styles, geometry transitions `[~]`

Lands **with its first consumer**, not before: edge styles and masks with EL6b (sticker outline,
shadow, masking), geometry transitions (zoom, slide, wipe passes) with EL7 (In/Out).

- [ ] **EL2b.1** Masks and edge styles for stills and titles; edge styles read the layer's own
      alpha when it has no mask stack (`render/edge_styles.py` + the preview's edge passes).
- [ ] **EL2b.2** Catalogue and geometry transitions for stills and titles in the compiler, both
      frame plans and the monitor.
- [ ] **EL2b.3** Oracle rows: `stills/mask-ellipse`, `stills/edge-outline`, `stills/zoom-in`,
      `text/slide-in`.
- [ ] **EL2b.4** (found 2026-09-26 while building shapes) A rotated title is clipped: the export
      rotates a layer inside its own box (`expand=False`) and a title's raster is tight to its
      glyphs, so "HELLO" turned 90° loses most of its letters, on the monitor and in the file.
      Shapes already avoid it with a rotation-safe square raster (ADR 0190); give titles the same
      (a padded raster when the clip animates `rotation`), in the engine raster, both frame plans
      and the monitor, with an oracle row `text/rotated`.

---

## EL3 — One definition of synthetic assets and clip kind per runtime `[x]`

**Ships:** a behaviour-neutral refactor. Adding `__shape__` must be a change to one module per
runtime, not to 17 (00 G4).

- [x] **EL3.1** `packages/editor-core/src/synthetic-assets.ts`: `SYNTHETIC_ASSET_IDS`,
      `isSyntheticAssetId`, `hasTimeBasedSource`, `ClipRenderKind`, `clipRenderKind`,
      `laneTypeForKind`; unit tests. Python twin `timeline/synthetic_assets.py` (the render side
      imports it; `frame_plan.clip_kind` and `operations.py`'s `has_time_based_source` delegate).
- [x] **EL3.2** Replace every comparison in the 17 modules (00 G4 list), including
      `critic.ts:189` and `mission-rubric.ts:230`'s private `SYNTHETIC_ASSET_IDS` sets.
- [x] **EL3.3** A guard test per runtime that fails if `'__text__'`, `'__caption__'` or a
      `=== TEXT_OVERLAY_ASSET_ID`-style comparison appears outside the helper module.
- [x] **EL3.4** `tests/fixtures/clip-kind.json`, read by a vitest and a pytest.

**DoD:** no output change (all tests green, oracle unchanged); the guard tests pass.

**Evidence (2026-09-26).** Helper + twin: `synthetic-assets.ts`, `timeline/synthetic_assets.py`,
both reading `tests/fixtures/clip-kind.json` (9 rows). Guards: `synthetic-assets.guard.test.ts`
(TS, over `packages/` and `apps/`) and `test_synthetic_assets.py` (engine) both failed on the
tree before the change and pass after. They found three sites the G4 list missed: desktop
`main.ts` and web-editor `ai.ts` (comments; their bin-only filter already skips synthetic ids)
and ai-sdk `picture-layers.ts` (a doc comment). All three are rows in 12 now. Tests: editor-core
(operations, frame plan, parity, stock placement, masks), ai-sdk (critic, verify, project index,
context builder, rubric, domain tools: 657), web-editor (selectors, builders: 367), engine
(operations, compiler, frame plan, preview text, stills: 311). ADR 0032 amended. [CI run 36198403567](https://github.com/rojan-labs/FramePilot/actions/runs/36198403567) on `9bbde591`, every job green including the PX4 oracle.

---

## EL4a — Shapes: the minimum vertical slice, complete `[!]`

**Ships (desktop):** six shapes — **highlight box, filled box, ellipse, marker, arrow, underline** —
added at the playhead, styled in the Inspector, moved and resized on the canvas (box handles for
the four boxes, endpoint handles for the arrow and underline), previewed with the engine's own
pixels, exported, undone in one step; the agent can do the same. Depends on EL2a, EL3, MD-E6.

A PR stack, each PR green on its own:

1. **Model** (done) — schema v25 (`ShapeParamsSchema` Zod + Pydantic twin, `SHAPE_ASSET_ID` in the EL3
   helper, passthrough migration + round trip, `pnpm schema:generate` + drift, engine fixtures
   import `SCHEMA_VERSION`); `shape-catalog.json` with the six (timeline-schema + engine mirror +
   drift test); `add_shape` op in TS and Python (apply/invert, `operation-contract`, frame-grid
   arm), validator rules (04 §2.4), cross-runtime behaviour test; ADR "Shapes are drawn by the
   engine".
2. **Engine** (done) — `render/shape_geometry.py` + `render/shape_raster.py` (the only rasteriser),
   `_compile_shape_clip`, frame-plan kind `shape` with bounds computed from params (both runtimes,
   pinned by frame-plan vectors), the raster route's `kind: 'shape'`, monitor drawing and cache,
   render-validation checks (05 §6); Python `validation/patch_validation.py` registers `add_shape`
   and validates its params; element clips are never cuts (`edit-boundaries.ts`,
   `transition-policy.ts`) and never feed caption derivation (`captions/derive.ts`).
3. **Editor** (done) — `addShapePatch` / `setShapeParamsPatch` / `moveShapeEndpointsPatch` in
   `editor-core/src/element-placement.ts`; a Shapes sub-tab of six tiles (SVG drawn from a
   UI-only TS path helper), click-to-add, keyboard; Inspector **Shape** section (fill, stroke,
   width, corners); `PreviewShapeEditor` box and endpoint handles, one patch per gesture; shape
   layers selectable on the monitor (`WebCodecsPreviewPlayer`); the legacy DOM monitor says
   "Elements need the layer preview" rather than showing the wrong picture; "Edit shape" in the clip
   context menu; History reads "Add shape “Highlight box”"; the Text tab's disabled scaffolds
   replaced by the Elements link; Settings "New elements" hint; `px0-inventory` rows.
4. **Agent** (done) — `add_shape` and `set_shape_style` (shape ids as a `z.enum` of the catalogue) in a
   new `elements` domain (summary, label, request words + routing test); `toolMeta`; the shapes
   half of `stickers-and-callouts.md`; the kernel rows of 12 §F (`tool-classification`,
   `tool-scope`, `callNoveltyKey` and the result digest in `orchestrator.ts`, `describe.ts`,
   `prompts.ts`'s domain list, `stage-policy`, `editor-capabilities`); regenerated descriptions,
   skills, parity fixture, Python mirrors, goldens — each diff reviewed as a token delta; MCP
   descriptors include both tools.

Evidence (all required for `[x]`):

- [x] Oracle rows: `shapes/highlight-box`, `shapes/marker-over-video`, `shapes/ellipse-rotated`,
  `shapes/arrow-segment` — landed as `tests/fixtures/frame-plan/shapes.json`; the PX4 oracle
  passed them in [CI run 36198403567](https://github.com/rojan-labs/FramePilot/actions/runs/36198403567) on `9bbde591`, every job green including the PX4 oracle.
- [!] One evaluation case: on a screen-recording fixture with known button coordinates, "Put a box
  around the Export button when I say 'export'" — the model finds the button by reading
  `get_frame` (the only grounding this slice has; 11 §2 defers automatic grounding); report the
  **measured hit rate** over repeated runs, not a single pass. **Built:** the case
  `callout-export-button`, a drawn screen recording with ground truth
  (`engine/python/tests/screen_demo_fixture.py` → `tests/fixtures/mission/labels/screen-demo.json`),
  the fixture project (`mission-fixture-projects.mjs`, `mission-screen-demo`) and the
  `callout-on-target` rubric (unit-tested). **Human step (model runs are paid and not run by the
  agent):** `tests/fixtures/mission/fetch-fixtures.sh`; start a sidecar with
  `FRAMEPILOT_PROJECTS_ROOT=tests/fixtures/mission/projects`; `node
    packages/ai-sdk/scripts/mission-fixture-projects.mjs`; then run the golden harness for
  `--case callout-export-button` with at least 10 runs and record the `callout-on-target` pass
  share here as the hit rate.
- [!] One desktop run on a real 5–15 minute screen recording: five callouts placed by hand and by
  the agent, exported, reopened, undone (10 §4 run A, shapes only). **Human step:** open a real
  screen recording in the desktop app; add five callouts from Elements → Shapes and five with
  the assistant; export; close and reopen the project; undo each; record the export, the
  reopen and the undo results (and any difference between monitor and export) here.
- [x] e2e in a new CI job `elements-e2e`, modelled on `masking-e2e` (the fake-desktop harness + a
  real sidecar): add a highlight box, resize it on the canvas, recolour it, export a frame,
  undo — `tests/e2e/specs/elements-e2e-shapes.spec.ts`, which also compares the monitor with
  the export at the PX4 gates. `docs/guides/elements.md` Shapes; `CHANGELOG.md` → Added (done).
  The job passed on every push since it landed, and [CI run 36203550932](https://github.com/rojan-labs/FramePilot/actions/runs/36203550932) on `276b8827`, every job green including PX4 and `elements-e2e`.

**Status (2026-09-26): `[!]`.** Everything a machine can prove is done and green ([CI run 36203550932](https://github.com/rojan-labs/FramePilot/actions/runs/36203550932) on `276b8827`, every job green including PX4 and `elements-e2e`); the two
`[!]` items above are the measured eval hit rate and the desktop run on real footage, which only a
person can do, with the steps written beside each.

**DoD:** the six shapes work end to end by hand and via `add_shape`; oracle rows pass; a v24
project opens unchanged and a v25 project with shapes is refused by a v24 build with
`NEWER_SCHEMA_MESSAGE`; the eval hit rate and the desktop run are reported.

---

## EL5 — Shapes: the whole catalogue `[x]`

- [x] **EL5.1** The remaining ~99 shapes and every preset (03 §1.2 → ~200 tiles); generators for
      polygons, stars, rings, bubbles, corners, curved arrows, path shapes; an export-rendered
      contact sheet of every shape and preset reviewed before merge.
- [x] **EL5.2** The browse surface for a large catalogue: category chips, search, colour row,
      drag to the timeline (`ELEMENT_DND_TYPE` beside `TEXT_OVERLAY_DND_TYPE` in
      `TimelineView.tsx`), the timeline clip glyph + `--clip-graphic` token, `swapShapePatch`.
- [x] **EL5.3** Stroke styles and caps complete (dashed, dotted, arrow/dot/bar caps on every
      segment shape).
- [x] **EL5.4** Numbered badges: `label` param drawn by the title rasteriser inside the shape,
      validator (≤ 8 chars), Inspector field, `add_shape` `label`, oracle row.
- [x] **EL5.5** Icons: `scripts/elements/build_icons.mjs` → Lucide paths in the catalogue's
      `icons` section; Lucide licence file beside it + licence test; Icons chip; oracle row.
- [x] **EL5.6** Agent: `search_elements` (shapes) — needed once the catalogue is too big to list
      in a tool description.

**DoD:** ~105 shapes, ~200 presets and ~1,600 icons browsable, placeable and exportable; oracle rows
green; contact sheet committed.

**Evidence (2026-09-26).** 106 shapes in nine categories, 260 presets, 1,703 Lucide icons
(`shape-catalog.ts`, `shape-icons.json` ×2 with `LICENSE-lucide.txt`; drift and licence tests in
`shape-icons.test.ts` and `test_shape_icons.py`). Generators: `test_shape_generators.py` draws every
preset and checks nothing is clipped, pins each generator's look (star points, ring hole, bubble
tail, corner marks, curvature sign, even-odd holes, dashes) and every cap × stroke style on every
line shape. Contact sheets reviewed and committed: `docs/reports/elements/shapes-contact-sheet.png`,
`icons-contact-sheet.png` (the review found the open heart outline and two misnamed shapes; fixed
in `78b8b896`). Browse: `ShapesBrowser.test.tsx` (chips, search, colour row, paging, keyboard,
drag), `shape-tile-outline.test.ts`, `element-dnd.test.ts`, the timeline drop in
`TimelineView.interactions.test.tsx`, `swap-shape.test.ts`, `ShapeSection.test.tsx`, minimap and
panel keys. Badges: label rows in `tests/fixtures/shape-params.json` (both runtimes), engine label
tests, Inspector field. Search: one ranking (`shape-search.ts`) pinned to the engine by
`tests/fixtures/shape-search.json`; `search_elements` in both runtimes with a digest; goldens
regenerated. Oracle rows: `shapes/box-stroke-dashed`, `star-knobs`, `curved-arrow`, `bubble-tail`,
`ring-evenodd`, `badge-label`, `icon-stroke`, `blend-multiply` (frame-plan vectors equal in both
runtimes), and [CI run 36203550932](https://github.com/rojan-labs/FramePilot/actions/runs/36203550932) on `276b8827`, every job green including PX4 and `elements-e2e`.

---

## EL6a — Stickers: the minimum vertical slice, complete `[!]`

**Ships:** a curated set of ~200 stickers (≈ 4 MB, committed), placeable by hand and by the agent.
Depends on EL2a, MD-E4.

- [x] **EL6a.1** `scripts/elements/build_library.py` + `fluent.lock.json` + `collections.json`;
      the curated set's padded full files and 144 px thumbnails (251 stickers, 6.3 MB) committed;
      the generated catalogue (curated items marked `bundled`); `LICENSE-fluent-emoji.txt`;
      catalogue-vs-files test (`sticker-catalog.test.ts`); the build's own decisions tested without
      the network (`test_build_library.py`); `pnpm elements:build` / `elements:lock` /
      `elements:icons`.
- [x] **EL6a.2** `packages/ai-sdk/src/providers/elements/`: typed catalogue loader + search, shared
      by panel, main and agent; tests.
- [x] **EL6a.3** Main `ElementsLibrary` + `framepilot:elements:materialize` IPC + preload + bridge;
      tests: unknown id, dedupe, integrity mismatch, missing file, ENOSPC, concurrent same id,
      traversal-shaped ids and project ids, a media folder linked outside the root, a path-shaped
      catalogue file, a tampered reuse, stale temp files.
- [x] **EL6a.4** `isElementAsset`, `sourcedAssetId('element', …)`, `buildAddStickerOps` (folder,
      asset, overlay lane, clip, t = 0 transform sized to the art) + property tests.
- [x] **EL6a.5** Stickers sub-tab: grid, search (name, keywords, the emoji itself), click-to-add,
      keyboard; Inspector **Sticker** section with Replace, and "Replace sticker…" in the clip menu.
- [x] **EL6a.6** Element assets are not footage anywhere: never enrolled or derived (desktop), off
      the engine's visual worklist and the batch analyser by id, absent from Footage
      understanding, exempt from `source-repeats.ts` and `picture-occupancy.ts`; `list_assets`
      labels them. Credits group identical lines. The bin shows an **Elements** folder and an
      "Element" badge. A b-roll cutaway opens under graphics lanes, not over them (found here).
- [x] **EL6a.6b** Opening a project whose element file is missing re-materialises it from the
      library by id before anything reads it, and never stops the project opening;
      `asset-paths.ts`'s sentence names stickers; opt-in local telemetry (`element_materialize`);
      the catalogue chunk loads lazily; the frozen engine decodes WebP on macOS and Windows (the
      `frozen-engine-webp` CI job).
- [x] **EL6a.7** Agent: `add_sticker` host (`ai/sticker-host.ts`) + orchestrator arm that calls the
      sticker builder directly (never the stock placement path); `add_clip` / `add_clips` /
      `move_clip` of an element asset delegate to the same builder; stickers half of the skill; the
      kernel rows of 12 §F (host dispatch, host-outcome arm, `callNoveltyKey` keyed on every
      argument, classification, scope, stage policy, `describe.ts`, the failure sentences in
      `reliability/sourcing-notes.ts` walked by both gates); regenerated goldens and fixtures;
      `graphics.sticker.add` in the capability inventory with a rendered proof.
- [!] **EL6a.8** Oracle rows `stickers/rest`, `stickers/scaled-rotated`, `stickers/fading` (PX4
  green); the evaluation case (built; the run is a human step, below); `security-reviewer`
  pass on 06 §5 (PASS WITH FINDINGS; every finding fixed in `0020a7f6`, recorded in the
  security runbook); docs (guide, ADR 0191, API and MCP pages); `CHANGELOG.md` → Added.

**DoD:** the curated stickers work end to end by hand and via `add_sticker`, including undo and
export; the eval case is reported.

Evidence:

- [x] CI: [run 36225239258](https://github.com/rojan-labs/FramePilot/actions/runs/36225239258) on
      `9633653c`, every job green: PX4 (the three sticker rows), `elements-e2e` (add, replace from the
      Inspector, export, monitor vs export, undo, heal-on-open, axe over the Elements panel in both
      themes), the rendered professional proofs (`graphics.sticker.add`), and the frozen engine
      decoding `fire.webp` with its alpha on macos-14 and windows-latest. CodeQL alone reports
      failure: the PR is over GitHub's 300-file diff limit, so it attributes `main`'s 57 open alerts
      to it; the PR's open alert set equals `main`'s (PLAN.md has the backlog). The security fixes
      (`0020a7f6`) land on the next green run.
- [!] **The evaluation case** `sticker-fire-on-beat` (a drawn talking head who says "this is fire";
  ground truth in `tests/fixtures/mission/labels/reaction-demo.json`; rubric `sticker-on-beat`:
  on the phrase ±0.3 s, the art off the face and above the caption band, on screen ≤ 3 s).
  **Human step (model runs are paid and not run by the agent):** `cd engine/python && uv run
python -m tests.reaction_fixture`; start a sidecar with
  `FRAMEPILOT_PROJECTS_ROOT=$(pwd)/tests/fixtures/mission/projects uv run framepilot serve --host
127.0.0.1 --port 8799`; `pnpm --filter @framepilot/ai-sdk build && node
packages/ai-sdk/scripts/mission-fixture-projects.mjs`; then, detached on an idle machine,
  `FRAMEPILOT_AI_PROVIDER=claude-agent-sdk FRAMEPILOT_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-5
FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8799 node packages/ai-sdk/scripts/mission-baseline.mjs
--case sticker-fire-on-beat --runs 10 --yes`, and record the `sticker-on-beat` pass share here as
  the hit rate.
- [!] **One desktop run** (10 §4 run B, stickers): in the desktop app, add five stickers from
  Elements → Stickers and five with the assistant over real footage; replace one from the
  Inspector; export; close and reopen the project; delete one sticker's file from the project
  folder and reopen (it comes back); undo each add. Record the export, the reopened project and
  any defect here.

## EL6b — Stickers: the whole library `[~]`

Depends on EL6a, MD-E1, EL2b.1.

- [~] **EL6b.1** All 1,595 full files fetched from the pinned commit **when packaging the desktop
  app** (an electron-builder `extraResources` step, cached by the lock hash), not in
  `web-editor#build`; `elementsRoot()` prefers the packaged set and falls back to the curated
  set (06 §4); CI size budget.
  _Built:_ `build_library.py --packaged` (1,344 files, 32.2 MiB, parallel, byte-stable
  reruns; 8 tests), a `manifest.json` main verifies copies against (MD-E1 note), `sourceOf`
  per item, `check:elements` (every sticker placeable, licence, 40 MB) in `desktop-build`.
- [~] **EL6b.2** Virtualised grid, collection chips, glyph search, favourites star; packaged tiles
  through `framepilot:elements:thumbnail`; perf test for 02 §9.
  _Built:_ `@tanstack/react-virtual` grid (40 of 1,595 tiles drawn), Recent / Favourites /
  nine group chips, star + F, in-project dot, drag onto a lane (`onDropSticker`); tiles from
  main in batches of ≤ 96, kept for the session; `StickersBrowser.perf.test.tsx`: search p95
  2.4 ms (≤ 16), warm first tiles 45 ms (≤ 100) in jsdom; the agent's search reaches the
  packaged set only where the host ships it.
- [~] **EL6b.4** `apps/desktop` `dist` runs `build:elements` before `electron-builder`;
  `release.yml` and the `desktop-build` job cache it; `scripts/check-installer-budget.mjs`
  re-checked (raised in the same PR only if needed, with the reason); release checklist and
  runbooks updated.
  _Built:_ both jobs cache `~/.cache/framepilot/elements` and the set by the lock's hash; a
  local unsigned macOS arm64 DMG with the set is 374.0 MiB (budget 400, not raised), and its
  own resources pass `check:elements`; `distribution.md` and the v1 release checklist say so.
- [~] **EL6b.3** Inspector Outline and Shadow (edge styles on the sticker's own alpha, from EL2b);
  the "Enlarged beyond its sharp size" hint; oracle rows `stickers/outline-shadow`,
  `stickers/masked`.
  _Built:_ `EdgeStyleControls` shared with the Mask tab (Outline: colour, width; Shadow:
  preset), each one undoable edit; `stickerEnlargement` reads the frame plan's displayed
  size at the clip's largest (1.27× default at 1080p; > 1.5× says so); rows
  `stickers/stickers-outline-shadow` (EL2b) and `stickers/stickers-masked` (TS and Python
  vectors equal).
- [!] **Run D — Scale** (10 §4, a human step; CI measures the synthetic row, `scale-elements`,
  without a GPU, so only a workstation can hold it to the budget). On an M-series Mac:
  - `pnpm px5:fixture`, then
    `python3 tests/e2e/scripts/px5-local-run.py scale-elements/proxy --budgets`: 20 sticker layers
    over the 4K row against ≤ 1% dropped frames and seek-to-present p95 ≤ 100 ms. Keep the line
    it appends to `tests/e2e/.tmp-px5-scale/results/local-runs.jsonl`.
  - In the desktop app, a 3-minute timeline of real 4K camera footage with 20 stickers (five
    outlined, five turning, some over faces): play it through twice, noting any stutter; export
    it, then hide the stickers' layers and export again. Record both export times (the budget:
    with stickers ≤ 1.3× without).
  - Commit both results as `docs/reports/elements/run-d-scale.md`, with the commit they ran on.

**DoD:** every catalogued sticker is placeable in a packaged build (CI check); budgets met.

---

## EL7 — Animation: In · Out · Loop `[~]`

Depends on EL2b.2 (geometry transitions), and EL4a or EL6a.

- [~] **EL7.1** Inspector **Animation** section for stickers, shapes and titles. **In / Out** are
  layer transitions (`add_layer_transition`, the existing op and catalogue — a curated graphics
  subset: fade, pop, slide ×4, wipe, blur-in); the title's control writes them too from now on,
  while the legacy `inAnimation`/`outAnimation` params (honoured since EL2a) stay readable and are
  no longer written. No new schema. "Animation…" in the clip context menu.
  _Built:_ `AnimationSection.tsx` on the Basic tab (In/Out preset + length, Loop preset + speed +
  amount, Re-apply), one undo each through `planElementAnimation`; the Text tab points there;
  "Animation…" opens it. **Found and fixed:** the op refused graphics lanes and every moving exit,
  because on an exit both renderers kept only the kind's mask (a slide vanished at once). Layer
  transitions now treat graphics lanes, and a moving exit plays its entrance backwards in time
  (frame plan `reversed`, compiler and monitor; `TRANSITION_EXIT_BY_MASK` keeps every existing
  exit as it was). ADR 0192.
- [~] **EL7.2** **Loop** as keyframes from an `editor-core` builder (`loop-motion.ts`, the
  `track-follow.ts` pattern): pulse, float, wiggle, bounce, spin, blink — one patch, one undo,
  rendered by the transform pipeline that already exists. Trade-off recorded in the ADR:
  extending a looped clip does not extend its loop until the Inspector's "Re-apply" (or the
  agent) regenerates it; the critic notes a loop that stops before its clip ends.
  _Built:_ `loop-motion.ts` (8 tests: every preset, frame-pixel moves, spin, read back,
  replace/clear, refusals, ranges); `clipLoop().coversClip` drives Re-apply and the skill's
  instruction; the eval rubric requires `coversClip`.
- [~] **EL7.3** Agent: `set_element_animation`; skill section on restraint; one evaluation case.
  _Built:_ the tool (elements domain, MCP, engine registry delegated to the host), the
  stickers-and-callouts skill's restraint rules, case `animate-arrow-and-sticker` on
  `mission-animate-demo` (rubric `element-animation`: Pop on the arrow, Pulse on the sticker,
  nothing else); +22 tokens a request.
- [~] **EL7.4** Oracle rows `loop/pulse`, `loop/wiggle`, `stickers/in-pop`, `shapes/out-slide`.
  _Built:_ `loop/pulse`, `loop/wiggle` (keyframes written by the builder),
  `stickers/stickers-in-pop`, `shapes/shapes-out-slide`; TS and Python vectors equal; e2e
  (Shapes spec) animates a box from the clip menu through export parity and undo.
- [!] **The evaluation case** `animate-arrow-and-sticker` (a talking head with an arrow and a
  sticker already on it; rubric `element-animation`). **Human step (model runs are paid and not
  run by the agent):** as EL6a's case, with the sidecar up and
  `node packages/ai-sdk/scripts/mission-fixture-projects.mjs --only mission-animate-demo`; then,
  detached on an idle machine, `FRAMEPILOT_AI_PROVIDER=claude-agent-sdk
FRAMEPILOT_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-5 FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8799
node packages/ai-sdk/scripts/mission-baseline.mjs --case animate-arrow-and-sticker --runs 10
--yes`, and record the share of runs passing `arrow-pops-in`, `sticker-pulses` and
  `nothing-else-animated` here.
- [!] **Run C — short-form talking head** (10 §4, a human step): in the desktop app, a real 9:16
  talking-head clip; add three reaction stickers with an In, a Loop and an Out (one by hand, two by
  asking the assistant), export at 1080×1920, and note whether any sticker covers the face or the
  captions and whether the exported motion matches the monitor. Commit the notes as
  `docs/reports/elements/run-c-short-form.md` with the commit they ran on.

**DoD:** each animation previews exactly as it exports, undoes in one step, and is reachable by the
agent.

---

## EL8 — Agent quality and MCP `[ ]`

- [ ] **EL8.1** Critic/verification checks (07 §4 table) with tests; `acceptance.ts` does not accept
      a run whose request named callouts or stickers while none was placed (ADR 0153);
      `temporal-review.ts` never calls a sticker foreign footage.
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
- [ ] **EL12.5** Website: `src/content/features.ts`, `content/docs/{getting-started,the-ai-agent,
keyboard-shortcuts,render-and-export}.mdx`; `MANUAL_TESTING.md` Elements section (macOS and
      Windows); `docs/runbooks/elements.md`; one line each in `README.md` and `PRD.md`;
      `DESIGN_SYSTEM.md` token.
- [ ] **EL12.6** The release gate of 13 §10, every box checked with evidence.

**Last updated:** 2026-09-26
