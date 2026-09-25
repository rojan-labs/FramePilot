# 09 — Phases EL0–EL12

Each phase is one coherent, reviewable goal (one PR, or a short stack), ends in something usable or
provably correct, and is checked off only when its Definition of Done holds (AGENTS.md §9). **A
category ships complete — UI, engine, undo, export, and its agent tool — or it does not ship**; no
placeholder sub-tabs, no disabled tiles, no backend-only phase marked done.

Conventions for every phase: branch in the main checkout, commit and push per step, stage explicit
paths only, no attribution trailers; run the tests you touched, CI runs the rest (verify on the PR's
head SHA); update `plan/PLAN.md`, this plan's ledger, docs and `CHANGELOG.md` in the same phase.

---

## EL0 — Decisions and spikes `[ ]`

**Ships:** answers, measurements, no product code.

- [ ] **EL0.1** Maintainer answers MD-E1…MD-E7 (README §1); record each answer and date there.
- [ ] **EL0.2** Product-scope review of this plan (README §7).
- [ ] **EL0.3** Spike A — shape raster: prototype `shape_raster.py` for rect/ellipse/star/arrow/
      bubble; measure ms at 1080p and 4K; compare the canvas fallback against it (PSNR); time the
      desktop raster round trip through the existing text-raster route; decide the `drawOn` strategy
      (05 §5). Report: `plan/elements/spikes/EL0.3-shape-raster.md`.
- [ ] **EL0.4** Spike B — animated WebP: decode Noto `1f600` with Pillow and with Chromium's
      `ImageDecoder`; compare every frame (max abs diff, PSNR), frame durations, loop; memory at 324 px
      display. Report: `spikes/EL0.4-animated-webp.md`.
- [ ] **EL0.5** Spike C — library build dry run against Fluent `1ffb34c752ec`: counts (1,595),
      default-tone coverage, padding, encode time, total bytes, lock generation. Report:
      `spikes/EL0.5-library-build.md`.
- [ ] **EL0.6** Licence read: Fluent MIT (bundle + notice), Lucide ISC/MIT, Noto Animated CC BY 4.0
      (a credit in the video description satisfies it?) — add to `MAINTAINER_ONLY_ACTIONS`-style list
      if legal review is wanted.

**DoD:** decisions recorded; three spike reports committed with numbers; no production code merged.

---

## EL1 — Stock becomes Elements (Photos · Videos) `[ ]`

**Ships:** the rename and the new panel shell with no behaviour change to Pexels search, preview,
download, quota or placement. Small and independent — can start before EL0 finishes (needs MD-E7).

- [ ] **EL1.1** `apps/web-editor/src/components/elements/ElementsPanel.tsx`: sub-tab strip
      (`role="tablist"`), only the sub-tabs this build can serve, remembered sub-tab
      (`useViewPreference('elementsTab')`), first-open rule (02 §2).
- [ ] **EL1.2** `StockPanel.tsx` → `elements/PexelsBrowser.tsx` with a `kind` prop; the `<select>`
      removed; placeholders and labels per 08 §1; every behaviour kept. Tests move with it
      (`PexelsBrowser.test.tsx`), kind-select cases become sub-tab cases.
- [ ] **EL1.3** `Editor.tsx`: id `'elements'`, label, `Shapes` icon (via `icons.tsx`), position
      after Assets, `coerceLeftTab` alias `'stock' → 'elements'`, `DESKTOP_ONLY_TABS`, `elementsEl`.
- [ ] **EL1.4** Copy (08 §1): bridge desktop-only detail, Settings group title + line, `toolMeta`
      labels, `DOMAIN_LABEL.sourcing`, the browser backstop note.
- [ ] **EL1.5** Docs: new `docs/guides/elements.md` (hub; Photos & Videos section), retitle
      `stock-sourcing.md`, `settings.md`, `configuration.md`, `system-map.md`; website privacy heading;
      `CHANGELOG.md` → Changed. (The pointer from `plan/3rd-party-sourcing/photo-video/README.md` to this
      plan was added with the plan itself.)
- [ ] **EL1.6** Tests: `ElementsPanel.test.tsx` (switching, remembered tab, first-open rule, browser
      absence), `Editor.test.tsx` (alias from a stored `'stock'`), `elements.spec.ts` replacing
      `stock-sourcing.spec.ts`, visual baselines refreshed if the rail is in them.

**DoD:** a person who left the rail on Stock reopens on Elements → Photos/Videos with the same
results; all former Stock tests pass under the new names; e2e green on the PR head.

---

## EL2 — Stills and text join the picture pipeline `[ ]`

**Ships:** a photo or title's opacity keyframes, transitions, crop, masks and edge styles preview
and export — fixing a live gap (00 G1) that every sticker and shape animation depends on.

- [ ] **EL2.1** Failing tests first: pytest cases from the 00 §3 table (opacity 0.25, fade-in at
      0.3 s, crop, mask, text opacity/fade) + expected frame-plan fields.
- [ ] **EL2.2** `compiler.py`: `_compile_image_clip` through crop → grade → masks → `_attach_mask` →
      edge styles → catalogue transition → placement; `_compile_text_clip` gains opacity, transitions,
      edge styles. `_attach_mask` **multiplies** an existing (intrinsic) alpha instead of replacing it.
- [ ] **EL2.3** `frame_plan.py` + `frame-plan.ts`: image and text layers carry crop, opacity, mask,
      transitions, edge styles; the "quirks" docstring and comment removed; vectors regenerated.
- [ ] **EL2.4** Monitor: image/text branches through the same passes with the intrinsic-alpha rule.
- [ ] **EL2.5** Edge styles read the layer's own alpha when it has no mask stack (engine
      `edge_styles.py` + preview `masks/edge-styles.ts`).
- [ ] **EL2.6** PX4 oracle rows (05 §8, EL2 list), all passing.
- [ ] **EL2.7** Golden renders regenerated where a fixture had such a still; ADR "A still is a
      picture layer like any other"; `CHANGELOG.md` → Fixed; `docs/guides/transitions.md` and the
      Inspector guide note that photos and titles now fade and transition.

**DoD:** the reproduced cases give the expected pixels in export **and** monitor; new oracle rows
pass; frame-plan vectors equal; no existing row regresses; `pnpm engine:test` for touched modules
and the vitest suites for touched files green; CI green.

---

## EL3 — One clip kind per runtime `[ ]`

**Ships:** a behaviour-neutral refactor that makes adding `shape` a one-line change.

- [ ] **EL3.1** `packages/editor-core/src/clip-kind.ts`: `ClipRenderKind`, `clipRenderKind`,
      `laneTypeForKind`; unit tests.
- [ ] **EL3.2** Replace the TS copies: `frame-plan.ts`, `stock-placement.ts`, `lane-placement.ts`,
      web-editor `patch-builders-base.ts` / `selectors-base.ts`, ai-sdk `project-index.ts`.
- [ ] **EL3.3** Python: `frame_plan.clip_kind` is the one definition; other copies import it.
- [ ] **EL3.4** `tests/fixtures/clip-kind.json`, read by a vitest and a pytest.

**DoD:** no output change (all existing tests green, oracle unchanged); a grep for the old helpers
finds nothing.

---

## EL4 — Shapes: first slice, complete `[ ]`

**Ships:** ~40 shapes (03 §1.2 ●) findable, placeable, editable on the canvas and in the Inspector,
previewed by the engine's own pixels, exported, undoable — by hand **and** by the agent.
Depends on EL2, EL3, MD-E6.

Engine and model

- [ ] **EL4.1** Schema v25: `ShapeParamsSchema` (Zod) + Pydantic twin, `SHAPE_ASSET_ID`,
      passthrough migration + round-trip tests, `pnpm schema:generate` + drift tests, engine fixtures
      import `SCHEMA_VERSION`; ADR "Shapes are drawn by the engine".
- [ ] **EL4.2** `shape-catalog.json` v1 (timeline-schema) + engine mirror + drift test; an
      export-rendered contact sheet of every shape and preset reviewed before merge.
- [ ] **EL4.3** Geometry (`editor-core/src/shapes/geometry.ts`, `render/shape_geometry.py`) +
      `tests/fixtures/shapes/geometry.json`.
- [ ] **EL4.4** `add_shape` op in TS and Python (apply/invert, `operation-contract`, frame-grid
      arm), validator rules (04 §2.4), cross-runtime behaviour test, algebra property test.
- [ ] **EL4.5** `render/shape_raster.py`, `_compile_shape_clip`, frame-plan kind `shape` (both
      runtimes, vectors), render-validation checks (05 §6).
- [ ] **EL4.6** Raster route `kind: 'shape'` (service + shared-types + bridge), monitor drawing and
      cache, browser canvas fallback with "Preview approximate".

Editor

- [ ] **EL4.7** Builders in `editor-core/src/element-placement.ts`: `addShapePatch`,
      `swapShapePatch`, `resizeShapePatch`, `moveShapeEndpointsPatch`.
- [ ] **EL4.8** Shapes sub-tab: SVG tiles, chips, search, colour row, click-to-add, drag to the
      timeline (`ELEMENT_DND_TYPE`, handled beside `TEXT_OVERLAY_DND_TYPE` in `TimelineView.tsx`),
      keyboard model.
- [ ] **EL4.9** Inspector **Shape** section (registry entry, inline validation messages).
- [ ] **EL4.10** On-canvas handles: box (eight handles, Shift/Alt, snapping) and segment endpoints;
      one patch per gesture.
- [ ] **EL4.11** Timeline clip style + `--clip-graphic` token; Text tab scaffolds removed with the
      link; Settings "New elements" hint.
- [ ] **EL4.12** Elements visible in the browser build (Shapes only); `elements.spec.ts` covers it.

Agent

- [ ] **EL4.13** `search_elements` (shapes), `add_shape`, `set_shape_style`; `elements` domain
      (summary, label, request words + routing test); `toolMeta`; first version of
      `stickers-and-callouts.md` (shapes half); regenerate descriptions, skills, parity fixture, Python
      mirrors, goldens — each diff reviewed as a token delta; MCP descriptors include the three tools.

Evidence

- [ ] **EL4.14** Oracle rows (05 §8, EL4 list); shape-raster benchmark; e2e: add a highlight box,
      resize it on the canvas, recolour it, export a frame, undo; `docs/guides/elements.md` Shapes;
      `CHANGELOG.md` → Added.

**DoD:** the full path works for every EL4 shape manually and via `add_shape`; oracle rows pass; a
v24 project opens unchanged and a v25 project with shapes is refused by a v24 build with
`NEWER_SCHEMA_MESSAGE`; budgets from 05 §7 met.

---

## EL5 — Shapes: the whole catalogue `[ ]`

- [ ] **EL5.1** The rest of 03 §1.2 (~65 shapes, all presets → ~200 tiles), each in the contact
      sheet and the geometry fixture.
- [ ] **EL5.2** Stroke styles and caps complete (dashed, dotted, arrow/dot/bar caps on every
      segment shape).
- [ ] **EL5.3** Numbered badges: `label` param, title rasteriser inside the shape, validator (≤ 8
      chars), Inspector field, `add_shape` `label` argument, oracle row.
- [ ] **EL5.4** Icons: `scripts/elements/build_icons.mjs` → Lucide paths in the catalogue's
      `icons` section; Lucide licence file beside it + licence test; Icons chip; sampled geometry
      vectors; oracle row.

**DoD:** "lots of shapes" is real: ~105 shapes, ~200 presets and ~1,600 icons browsable, placeable,
exportable; oracle and vectors green.

---

## EL6 — Stickers: first slice, complete `[ ]`

**Ships:** 1,595 stickers, offline, placeable by hand and by the agent. Depends on EL2, MD-E1, MD-E2,
MD-E4.

- [ ] **EL6.1** `scripts/elements/build_library.py` + `fluent.lock.json` + `collections.json`;
      generated catalogue (committed), thumbnails (committed), full files (built, git-ignored per
      MD-E2), `LICENSE-fluent-emoji.txt`, size report; `pnpm elements:build`; turbo dependency; CI cache
      by lock hash; catalogue-vs-files test.
- [ ] **EL6.2** `packages/ai-sdk/src/providers/elements/`: typed catalogue loader + search (ranking
      per 03 §2.4), shared by panel, main and agent; tests (ranking, glyph search, empty query).
- [ ] **EL6.3** Main `ElementsLibrary` + `framepilot:elements:materialize` IPC + preload + bridge;
      tests: unknown id, dedupe, integrity mismatch, missing file, ENOSPC, concurrent same id,
      traversal-shaped ids refused.
- [ ] **EL6.4** `isElementAsset`, `sourcedAssetId('element', …)`, `addStickerPatch` (folder, asset,
      lane, clip, t=0 transform) + property tests (one patch, undo deep-equal, no second asset).
- [ ] **EL6.5** Stickers sub-tab: virtualised grid, chips, search, tile states, click/drag,
      keyboard; perf test for the budgets in 02 §9.
- [ ] **EL6.6** Inspector **Sticker** section: Replace…, Outline, Shadow (edge styles on the
      sticker's own alpha), "Enlarged beyond its sharp size" hint.
- [ ] **EL6.7** Credits grouping of identical lines (G10); element assets skip enrolment and footage
      tools; `list_assets` labels them (G9).
- [ ] **EL6.8** Agent: `add_sticker` host (`ai/sticker-host.ts`) + orchestrator arm +
      cross-path deep-equal test; `search_elements` stickers; `picture-layers.ts` exemption for element
      overlays + ADR "An element is an overlay" (MD-E4); skill extended (stickers half); regenerate
      goldens/fixtures.
- [ ] **EL6.9** Browser build: sticker import through `importMedia`, or the sub-tab is absent (02 §1,
      06 §6) — decided with a test either way.
- [ ] **EL6.10** Oracle rows (05 §8, EL6 list); `security-reviewer` pass on 06 §5; docs
      (`elements.md` Stickers, `settings.md` if any setting); `CHANGELOG.md` → Added.

**DoD:** every sticker browsable and searchable offline; add → move/scale/rotate → outline →
export → undo works by hand and via `add_sticker`; the packaged app contains every catalogued file
(CI check); budgets met; oracle rows pass.

---

## EL7 — Animation: In · Out · Loop `[ ]`

- [ ] **EL7.1** Inspector **Animation** section (stickers, shapes, titles): In and Out = a curated
      graphics subset of the transition catalogue (fade, pop, slide ×4, wipe, blur-in) through
      `add_layer_transition`; duration slider; replace/remove.
- [ ] **EL7.2** Titles: `inAnimation`/`outAnimation` params (preview-only, G6) migrate to layer
      transitions (schema v26 migration with tests) so they export; the params are removed from the
      title vocabulary.
- [ ] **EL7.3** `loop_motion` effect (schema v26): presets, evaluation in both frame plans and the
      compiler, vectors (`loop-motion.json`), oracle rows; validator.
- [ ] **EL7.4** `drawOn` for stroked shapes per the EL0.3 decision; oracle row.
- [ ] **EL7.5** Agent: `set_element_animation`; skill section on restraint.

**DoD:** each animation kind previews exactly as it exports (oracle), undoes in one step, and is
reachable by the agent.

---

## EL8 — Agent quality and MCP `[ ]`

- [ ] **EL8.1** Critic/verification checks (07 §4 table) with tests.
- [ ] **EL8.2** Context digest names element clips compactly (07 §5); token delta measured.
- [ ] **EL8.3** `editing-skills-expert` craft pass on `stickers-and-callouts.md`; description under
      the 300-character cap (test).
- [ ] **EL8.4** Evaluation cases 1–5 (07 §8) added to the golden set with expected timeline
      outcomes; results read from the recorded reports.
- [ ] **EL8.5** MCP: verify `search_elements`, `add_shape`, `set_shape_style`,
      `set_element_animation` over MCP end to end; optional MCP sticker materialiser with
      `FRAMEPILOT_ELEMENTS_ROOT` (`.env.example` + `turbo.json` `globalEnv` in the same commit);
      `docs/api/mcp-server.md`.

**DoD:** the eval cases meet their expected outcomes on the recorded run; MCP tests green.

---

## EL9 — Photos and Videos grow up `[ ]`

- [ ] **EL9.1** Category chips as curated queries (cached; each chip is one request, stated in the
      quota strip).
- [ ] **EL9.2** Orientation filter (default: the project's orientation).
- [ ] **EL9.3** Drag a photo/video tile to the timeline (download, then place at the drop).
- [ ] **EL9.4** **Add as overlay** for manual placement (MD-E5): places on a front lane scaled to
      40% and centred; ADR superseding ADR 0140's gating role for manual placement; the agent keeps its
      rule until measured.
- [ ] **EL9.5** Tests (panel matrix rows for each), e2e where the browser can reach, docs.

**DoD:** each addition works end to end on desktop; the quota cost of every new request is visible.

---

## EL10 — Animated stickers (optional pack) `[ ]` — gated on MD-E3

- [ ] **EL10.1** Mirror or pin: 881 Noto animated WebPs with SHA-256 pins in a catalogue section;
      host allowlist.
- [ ] **EL10.2** On-demand download in `ElementsLibrary` (progress, cancel, size cap, pin check,
      per-user cache, copy into project); download registry.
- [ ] **EL10.3** Schema v27 `AssetMedia.animation`; engine `AnimatedImageClip`; monitor
      `ImageDecoder`; timing vectors; oracle rows.
- [ ] **EL10.4** Credits: `attributionRequired: true` → Required group; tile badge.
- [ ] **EL10.5** Agent: `search_elements` returns `animated`, `add_sticker` downloads when needed.

**DoD:** an animated sticker previews frame-exact with the export across loop boundaries; the
credit appears in Credits; offline use of already-downloaded stickers works.

---

## EL11 — Polish `[ ]`

- [ ] **EL11.1** Favourites and Recents (user settings store).
- [ ] **EL11.2** Skin tones (bundle vs tone pack decided with the measured 30 MB).
- [ ] **EL11.3** "Add as sticker" for the user's own images (bin context menu → sticker placement).
- [ ] **EL11.4** Drop onto the program monitor at a position.
- [ ] **EL11.5** Follow subject for stickers (`track-follow.ts`, Inspector + `follow_subject`).
- [ ] **EL11.6** `accessibility-responsive-auditor` and `ui-ux-critic` passes; fixes.

---

## EL12 — Close-out `[ ]`

- [ ] **EL12.1** `docs/guides/elements.md` complete; `docs/api` (schema v25–v27, raster route,
      IPC); `mcp-server.md`; ADR index.
- [ ] **EL12.2** `CHANGELOG.md` and the website changelog (`changelog-maintainer`).
- [ ] **EL12.3** Desktop evidence runs (10 §4) with committed reports.
- [ ] **EL12.4** `plan/PLAN.md` and this plan's ledger reconciled; deferred items listed.

**Last updated:** 2026-09-26
