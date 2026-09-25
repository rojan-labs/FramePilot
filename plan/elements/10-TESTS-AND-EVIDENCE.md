# 10 — Tests and evidence

Critical behaviour is proven through real workflows, not lines hit (AGENTS.md §5). Visual claims
get render-backed evidence (`product-discipline.mdc` §8). Heavy suites (e2e, the oracle, perf) run
in **CI on the PR head SHA**, one heavy job at a time locally if at all — local full runs have taken
the 16 GB development Mac past its memory and shut it down.

---

## 1. Test matrix

| Layer               | What is tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Where                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **timeline-schema** | `ShapeParamsSchema` (every key, range, strictness, colour forms); migrations v24→v25 (+v26, v27) passthrough and round trip; newer-schema refusal; JSON-schema drift; shape-catalogue drift TS ↔ Python; clip-kind table                                                                                                                                                                                                                                                                                  | `shape-params.test.ts`, `migrations.test.ts`, `json-schema.test.ts`, `shape-catalog.test.ts`, `test_schema_parity.py`                                                                                                                 |
| **editor-core**     | `add_shape` apply + invert, validator rules (each rule, each message has a remedy, no varying magnitude), deterministic ids; `set_effect_params` re-validation on shapes; `clipRenderKind`; geometry vectors; `addShapePatch` / `swapShapePatch` / `addStickerPatch` property tests (one patch, never overlaps a lane, undo deep-equal, second add reuses the asset); frame-plan vectors for stills, text, shapes, animated frames, loop motion                                                           | `operations.test.ts`, `validator.test.ts`, `clip-kind.test.ts`, `shapes/geometry.test.ts`, `element-placement.test.ts`, `operation-algebra.property.test.ts`, `cross-runtime-operation-behavior.test.ts`, `frame-plan.parity.test.ts` |
| **engine**          | stills and text through the full pipeline (the 00 §3 cases as regression tests); intrinsic alpha × opacity; `shape_geometry` vectors; `shape_raster` goldens (fixed sizes, byte checksums); `_compile_shape_clip`; raster route (`kind: 'shape'`, validation, limits); render-validation checks; `AnimatedImageClip` timing and memory bound; Pydantic parity                                                                                                                                             | `test_render_compiler.py`, `test_shape_geometry.py`, `test_shape_raster.py`, `test_service_preview_raster.py`, `test_render_validation.py`, `test_animated_image.py`                                                                  |
| **web-editor**      | `ElementsPanel` (tabs, remembered tab, first-open rule, browser absence); `PexelsBrowser` (every former Stock case); `StickersBrowser` (virtualised grid renders only visible rows, search ranking, chips, tile states, keyboard, favourites); `ShapesBrowser` (SVG tiles, colour row, keyboard); Inspector Shape/Sticker/Animation sections; on-canvas box and endpoint handles (one patch per gesture); timeline drop of `ELEMENT_DND_TYPE`; `coerceLeftTab` alias; Credits grouping; `toolMeta` labels | `components/elements/*.test.tsx`, `Inspector.*.test.tsx`, `PreviewTransform.test.tsx`, `TimelineView.interactions.test.tsx`, `Editor.test.tsx`, `CreditsSection.test.tsx`                                                             |
| **desktop**         | `ElementsLibrary` (unknown id, dedupe, integrity, missing file, ENOSPC, concurrency, traversal-shaped ids); IPC contract ↔ preload parity; `sticker-host` (bin vs timeline, failure sentences); EL10 downloads (pin mismatch, size cap, cancel leaves no temp)                                                                                                                                                                                                                                            | `media/elements-library.test.ts`, `ipc/*.test.ts`, `ai/sticker-host.test.ts`                                                                                                                                                          |
| **ai-sdk**          | tool schemas (strict, lenient aliases); `add_sticker` orchestrator arm; agent-vs-panel deep-equal; domain routing phrases; critic checks; digest wording and size; catalogue search; skill description ≤ 300 chars; generated fixtures and goldens                                                                                                                                                                                                                                                        | `domain-tools/elements.test.ts`, `orchestrator-stream.test.ts`, `tool-domains.test.ts`, `critic.test.ts`, `providers/elements/*.test.ts`                                                                                              |
| **mcp-server**      | the element tools exposed/hidden as 07 §7 says; cross-host parity                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tools.test.ts`, `cross-host-parity.test.ts`                                                                                                                                                                                          |
| **e2e (browser)**   | `elements.spec.ts`: tab per build; Shapes: add at playhead → canvas resize → recolour → undo; Stickers where the browser build supports them; no provider host in the page; `view-prefs-persist.spec.ts`: stored `'stock'` lands on Elements; `accessibility.spec.ts`: axe clean on the Elements panel in both themes; visual snapshots of each sub-tab                                                                                                                                                   | `tests/e2e/specs/`                                                                                                                                                                                                                    |
| **PX4 oracle**      | every row in 05 §8, added passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `preview-parity-oracle.spec.ts`                                                                                                                                                                                                       |
| **performance**     | 02 §9 and 05 §7 budgets: search keystroke, grid scroll, add latency, monitor with 20 elements, shape-raster time, export ratio                                                                                                                                                                                                                                                                                                                                                                            | `preview-scale-perf.spec.ts` (+ elements row), a grid perf spec, pytest benchmarks, the PX5.11-style dispatch workflow                                                                                                                |
| **licences**        | every bundled library has its licence file beside it; `pnpm license:scan` on manifest changes                                                                                                                                                                                                                                                                                                                                                                                                             | `elements-licences.test.ts`, CI                                                                                                                                                                                                       |

**Every new op tests apply and invert. Every new validator rule tests its message. No skipped tests
without a linked issue.**

---

## 2. What "done" looks like per category (the manual path, scripted in e2e where the browser can)

1. Open Elements → sub-tab → search → the right tiles appear.
2. Click a tile → a clip appears at the playhead on a graphics lane, selected, handles visible.
3. Move/resize/rotate on the canvas; change a style in the Inspector.
4. Scrub: the monitor shows it; `grab_frame` at the same time shows the same pixels (oracle row).
5. Export: the element is in the file (render validation passes).
6. Undo: the clip (and, if created by the add, the lane, folder and asset) is gone; redo restores.
7. Save, close, reopen: identical.
8. Failure: one forced failure per category shows its sentence (disk full, missing file, invalid
   shape params, no key for Photos).

---

## 3. Parity oracle discipline

- New rows are added **passing**; the baseline JSON keeps no listed failures.
- Rows sample at transition/animation boundaries (start, mid, ±1 frame of the end) and at a loop
  wrap.
- A row that starts failing after a compositor or engine change fails the job — the same rule as
  PX4 today.

---

## 4. Desktop evidence runs (EL12; `product-discipline.mdc` §8)

Run on a desktop build against **real** media, reports committed under
`docs/reports/elements/`:

| Run                             | Material                                        | What is measured                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Manual SaaS demo**        | a real 5–15 min screen recording, 16:9          | five callouts (box, circle, arrow, underline, badge) timed to narration, two stickers; export; monitor vs export frames at each element's midpoint; add latency; reopen; undo all   |
| **B — Agent SaaS demo**         | the same recording                              | eval cases 1, 3, 4, 5 (07 §8); timeline outcome and rendered frames judged, not tool calls                                                                                          |
| **C — Short-form talking head** | real 9:16 talking-head clip                     | reaction stickers with In/Loop/Out, safe-area and face-overlap advisories, export at 1080×1920                                                                                      |
| **D — Scale**                   | 3-minute 4K timeline + 20 elements (3 animated) | PX5 monitor budgets on an M-series Mac; export ratio ≤ 1.3×                                                                                                                         |
| **E — Compatibility**           | a v24 project with photos, titles and stock     | opens unchanged; renders the same except the G1 fixes (listed); a v25 project refused by the previous release with `NEWER_SCHEMA_MESSAGE`; stored `'stock'` rail tab opens Elements |

A claim of "done" for a category cites the run and the commit it ran on.

**Last updated:** 2026-09-26
