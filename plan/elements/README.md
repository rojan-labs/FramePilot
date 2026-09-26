# Elements — Photos · Videos · Stickers · Shapes — `[ ]` planned

> **Sub-plan index.** Created 2026-09-26. Owner: maintainer. Parent: [`plan/PLAN.md`](../PLAN.md)
> → "Elements library". Supersedes the _panel_ half of
> [`plan/3rd-party-sourcing/photo-video/`](../3rd-party-sourcing/photo-video/README.md) (the
> Pexels service, key custody and quota it built are kept and reused, not replaced).
>
> **Maintainer request (2026-09-26), punctuation added:** "right now we have stock as a section on the
> application where there are stock videos. I want to rename that to elements and on that there
> will be multiple things: photos, videos, stickers, shapes. Take example of how CapCut does it.
> I want lot of shapes and stickers as well loaded up. Prepare an end to end plan on doing this
> from 0-100 … doing structural changes even if we have to."

The **Stock** tab becomes **Elements**: one place to find anything you put _on_ or _into_ the
picture that you did not film. Photos and Videos are the existing Pexels stock library. Stickers
are a large bundled library of emoji-style stickers. Shapes are recolourable vector graphics
(boxes, circles, arrows, lines, callouts, highlight marks, badges) that the engine draws. Every
one of them lands on the timeline as an ordinary typed, validated, reversible edit that previews
and exports identically, and the agent can use all four.

---

## Files

| File                                                         | What it holds                                                                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md` (this)                                           | Decision record, scope gate, architecture at a glance, phase map, ledger                                                                                             |
| [`00-CURRENT-STATE.md`](./00-CURRENT-STATE.md)               | Verified inventory of everything "Stock" touches today, and the gaps found (with a reproduced export gap)                                                            |
| [`01-CAPCUT-REFERENCE.md`](./01-CAPCUT-REFERENCE.md)         | How CapCut organises Elements / Stickers / Shapes; what we copy, adapt, and skip                                                                                     |
| [`02-UX-SPEC.md`](./02-UX-SPEC.md)                           | Panel, tabs, tiles, states, keyboard, drag and drop, Inspector, on-canvas handles, timeline look, copy                                                               |
| [`03-CONTENT-LIBRARY.md`](./03-CONTENT-LIBRARY.md)           | The shape catalogue (every base shape and preset), sticker sources and licences, sizes (measured), taxonomy, build pipeline                                          |
| [`04-DATA-MODEL.md`](./04-DATA-MODEL.md)                     | Schema v25, the `__shape__` clip, `add_shape`, validator rules, provenance, ids, folders, clip-kind consolidation                                                    |
| [`05-RENDER-AND-PREVIEW.md`](./05-RENDER-AND-PREVIEW.md)     | Engine rasteriser, compiler, both frame plans, layer compositor, animated stickers, parity oracle, performance                                                       |
| [`06-DESKTOP-HOST-AND-IPC.md`](./06-DESKTOP-HOST-AND-IPC.md) | Main-process library service, IPC, sandbox, CSP, packaging, browser build                                                                                            |
| [`07-AI-AND-MCP.md`](./07-AI-AND-MCP.md)                     | Tools, the `elements` domain, orchestration, the overlay placement policy change, skill, MCP, goldens                                                                |
| [`08-RENAME-MATRIX.md`](./08-RENAME-MATRIX.md)               | Every surface the word "Stock" reaches: renamed, kept, or aliased — and why                                                                                          |
| [`09-PHASES.md`](./09-PHASES.md)                             | The executable phases **EL0–EL12**: tasks, files, tests, Definition of Done, evidence                                                                                |
| [`10-TESTS-AND-EVIDENCE.md`](./10-TESTS-AND-EVIDENCE.md)     | Test matrix, parity oracle rows, performance budgets, the desktop evidence runs                                                                                      |
| [`11-RISKS-AND-DEFERRED.md`](./11-RISKS-AND-DEFERRED.md)     | Risk register, explicitly deferred scope, open questions                                                                                                             |
| [`12-SURFACE-COVERAGE.md`](./12-SURFACE-COVERAGE.md)         | **Every surface Elements touches** — schema, editor-core, web editor, desktop, engine, AI SDK kernel, MCP, CI, scripts, docs, website — with its phase and its proof |
| [`13-PRODUCTION-READINESS.md`](./13-PRODUCTION-READINESS.md) | The per-PR production checklist, rollout/rollback, cross-platform, data safety, security, support runbook, agent quality bar, release gate                           |
| [`AGENT-GOAL.md`](./AGENT-GOAL.md)                           | The goal prompt (< 3,500 characters) for an autonomous agent to implement this plan end to end                                                                       |

---

## 1. Decision record

Recorded so a later agent does not silently reverse them (`.agents/rules/product-discipline.mdc`
§10). **D1 is the maintainer's; D2–D9 are this plan's recommendations and stand unless the
maintainer changes them; MD-E1…MD-E7 are open and need a maintainer answer before the phase that
depends on each.**

### D1 — Maintainer scope decision: Stock becomes Elements, with four categories and large libraries

This is an explicit expansion of product breadth (priority-order item 3–5 of
`product-discipline.mdc` §2) chosen by the maintainer, including permission for structural
change. It is recorded here as the override that rule requires. It does **not** waive the
finish-before-expand rule: every category ships as a complete vertical slice (entry → placement
→ validation → preview → export → undo → failure state → tests) or does not ship.

### D2 — The CapCut model, grounded in what FramePilot already is

| Category     | What it is here                                                                                                                                 | Built on                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Photos**   | Pexels stock photos                                                                                                                             | the shipped Pexels service, quota and key custody (unchanged)                           |
| **Videos**   | Pexels stock video                                                                                                                              | same                                                                                    |
| **Stickers** | A bundled library of ~1,600 emoji-style stickers (Microsoft Fluent Emoji, MIT); an optional animated pack later                                 | ordinary `image` assets materialised into the project, placed as overlays               |
| **Shapes**   | ~100 recolourable vector shapes and ~200 styled presets: basic shapes, arrows, lines, callouts, highlight marks, stars, badges, frames, symbols | a new synthetic `__shape__` clip drawn by the engine, the way text overlays already are |

Shapes are the category with the strongest pull from the product's own niche. Highlight boxes,
arrows, circles and underlines over a screen recording are the most common graphic in a SaaS demo
or tutorial, and today FramePilot cannot draw one (`OverlaysPanel.tsx:48-53` scaffolds a disabled
"Shape" type).

### D3 — Every element is an ordinary edit

No parallel overlay system. A sticker is an `image` asset plus a clip; a shape is a clip with one
typed `shape` effect. Adding either is **one patch** (bin folder + asset + lane + clip + initial
transform), so **one undo** removes all of it. Everything that already works on clips (move, trim,
split, keyframes, layer transitions, blend modes, masks, track follow, the Inspector, the agent's
editing tools) works on elements with no special case beyond the ones this plan names.

### D4 — Stickers and shapes are overlays

They sit on graphics lanes in front of the footage. This became honest on 2026-09-25: the program
monitor composites every timeline in every build (ADR 0180 amendment; `compositor-flag.ts`
defaults to `layers`; PX4 oracle 72/72). The cutaway-only rule for stock (ADR 0140) and the agent's
refusal of scaled or positioned picture overlays (ADR 0169/0170, `picture-layers.ts`) were both
justified by the old flat monitor. Element assets never go through that cutaway placer: stickers
are placed on overlay lanes by their own builder, and `add_clip` of an element asset delegates to it
(EL6a, 07 §4). Manual picture-in-picture for Pexels media is EL9.

### D5 — Parity by construction

Shapes are rasterised by the engine (Pillow) for the export **and** for the desktop monitor, through
the same raster route the monitor already uses for text (`POST /preview/text-raster`, PX2.3). The
engine is the **only** shape rasteriser; TypeScript draws shapes only as SVG panel tiles. A browser
fallback ("Preview approximate", as titles have under ADR 0180 decision 4) is deferred to EL11 —
desktop first. Stickers are files that both runtimes decode. New PX4 oracle rows prove it.

### D6 — Fix the picture pipeline for stills and graphics first

Verified on `98ea829a` (00 §3): a still image and a text overlay ignore **opacity keyframes and
transitions** at export _and_ in both frame plans (`frame_plan.py:21-23` documents it as a
"quirk"; `frame-plan.ts:914` "The export places a still without its crop, mask, opacity or
transition"). Three live consequences: the Inspector's opacity control on a photo does nothing; a
title's In/Out control does nothing on the desktop monitor or in the export (G6); and a landscape
photo the agent places in a portrait project gets a cover crop (`autoReframeCrop`) that neither the
monitor nor the export applies, while the coverage check believes it (G11). CapCut-style
In/Out/Loop animation of a sticker or shape is impossible until this is fixed. **EL2a** fixes the
opacity, fade, crop and title-animation half before any new element type lands; **EL2b** (masks,
edge styles, geometry transitions for stills) lands with its first consumer.

### D7 — Rename what people see; never rename what projects store

User-facing text says "Elements" everywhere. Persisted and model-facing identifiers are **kept**:
asset ids `stock_pexels_*` (in saved projects and the project brain), `Asset.source.provider =
'pexels'`, the `sources.json` ledger, and the tool names `search_stock` / `add_stock` (recorded runs
and goldens reference them). The Pexels IPC channels stay `framepilot:stock:*` because they are the
Pexels provider's channels, which is still accurate. The persisted left-rail preference `'stock'`
is aliased to `'elements'`. Full matrix: [`08-RENAME-MATRIX.md`](./08-RENAME-MATRIX.md).

### D8 — Sticker library: Fluent Emoji (MIT) core; animated stickers are an optional later pack

- **Core (offline):** Microsoft Fluent Emoji, MIT licence, 1,595 emoji at upstream commit
  `1ffb34c752ec` (2026-08-24), 3D style (256 px PNG upstream; 19.6 KB average as lossless WebP,
  measured). A curated ~200 are committed and ship in every build (EL6a); the full set is fetched
  from the pinned commit when the desktop app is packaged (EL6b). Per-emoji `metadata.json` supplies
  CLDR name, group and keywords, which is a ready-made search index.
- **Animated (optional, later, EL10):** Google Noto Animated Emoji, **CC BY 4.0** (attribution
  required), 881 items, 512 px animated WebP (~370 KB each, measured). The engine's Pillow already
  decodes them (48 frames RGBA, verified). Carried as required credits through `Asset.source`
  (schema v20), the path CC-BY music already uses.
- **Excluded:** brand and social-network logos (trademark), GIPHY/Tenor content (rights unclear for
  monetised video), anything CC BY-SA or non-commercial.

### D9 — Shapes are data, drawn by one vector primitive

A shape is a catalogue entry (`shape-catalog.json` in `timeline-schema`, mirrored into the engine
with a drift test, the caption-template pattern) that resolves to a normalised vector path plus a
style. One rasteriser — the engine's — draws all of them; the frame plans carry a shape's bounds
computed from its parameters, so no second geometry implementation has to agree with the first to
the pixel. The same primitive later draws line icons (Lucide, ISC, already a dependency) with no
new renderer.

### Open maintainer decisions

| Id        | Decision                                                                                                                               | Recommendation                                                                                                                                                                                                                                                               | Needed before |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **MD-E7** | Left-rail order: Elements moves to second, after Assets (CapCut's order)                                                               | **Yes — decided autonomously, 2026-09-26** (maintainer instruction: take the recommended answer)                                                                                                                                                                             | EL1           |
| **MD-E6** | Schema v25 (a forward-safety bump for shape clips)                                                                                     | **Yes — decided autonomously, 2026-09-26** (the recommended answer: an older build must refuse a project with shapes, not render it without them)                                                                                                                            | EL4a          |
| **MD-E4** | The agent may place stickers over footage (ADR "An element is an overlay"); element assets never go through the footage cutaway placer | **Yes — decided autonomously, 2026-09-26**: the flat-monitor premise of the coverage refusal is gone; a sticker routed through it becomes a full-frame cutaway                                                                                                               | EL6a          |
| **MD-E2** | Commit the curated ~200 stickers and their thumbnails (≈ 5 MB); never commit the rest                                                  | **Yes — decided autonomously, 2026-09-26**: the repo pack is 80 MB; the full set would add ~40% (the curated 251 are 6.3 MB with tiles)                                                                                                                                      | EL6a          |
| **MD-E1** | Ship the other ~1,395 stickers in the **desktop installer** (≈ 33 MB with thumbnails, fetched from the pinned commit at packaging)     | **Yes — decided autonomously, 2026-09-26** (the recommended answer: offline and instant, like the caption fonts). The packaging step ships a manifest of the files it encoded, which the library verifies, because a lossless WebP's bytes can differ between build machines | EL6b          |
| **MD-E5** | Relax the cutaway-only placement of Pexels photos/videos for **manual** placement (picture-in-picture from the panel)                  | **Yes — decided autonomously, 2026-09-26** (the recommended answer: manual only first — **Add** stays a cutaway, **Add as overlay** is a picture-in-picture; the agent keeps cutaway-first until measured)                                                                   | EL9           |
| **MD-E3** | Ship Noto Animated Emoji (CC BY 4.0, credit required in the video description) as on-demand downloads                                  | **Yes, as EL10, after a licence read — decided autonomously, 2026-09-26**; the licence read is a human step, so EL10 waits on it (09, EL10)                                                                                                                                  | EL10          |

Each is asked when its phase is next, not all at once (EL0.1).

---

## 2. Scope gate (`product-discipline.mdc` §3)

**User outcome.** A creator cutting a demo, tutorial or short puts a highlight box on the button
they are talking about, an arrow at the setting that matters, a 🔥 on the line that lands, or a
stock photo behind a point — without leaving FramePilot, seeing exactly what will export, and able
to ask the agent to do the same.

**Current gap.** Shapes: **impossible** today (no shape clip exists; the Overlays panel's "Shape"
type is a disabled scaffold). Stickers: **possible only by hand-importing a PNG**, which lands
fit-to-frame as a cutaway, cannot fade (D6), and has no library. Photos/videos: **work**, but the
panel is a single mixed list behind a kind dropdown and placement is cutaway-only.

**Minimum vertical slice** (adopted from the scope review, §7). EL1 (the rename, no behaviour
change) runs in parallel. The first capability slice is **EL2a → EL3 → EL4a**: stills and titles
honour opacity, fades, crop and their own alpha; one helper per runtime owns synthetic asset ids and
clip kind; then, on desktop, **six shapes** — highlight box, filled box, ellipse, marker, arrow,
underline — added at the playhead, styled in the Inspector, moved and resized with box and endpoint
handles, exported and undone in one step, and placeable by the agent through `add_shape` /
`set_shape_style`; proven by four oracle rows, one evaluation case with a measured hit rate, and one
desktop run on a real screen recording. Stickers start at EL6a (a curated ~200) on the same
foundation.

**Reuse.** Pexels service, quota, key custody and provenance (unchanged); `add_text_overlay`'s
synthetic-clip pattern for shapes; the engine text-raster route for shape rasters; the layer
compositor and PX4 oracle; `add_layer_transition` and the transition catalogue for In/Out
animation; the `track-follow.ts` keyframe-planning pattern for loops, and `track-follow.ts` itself
for stickers that follow a subject; `@tanstack/react-virtual` for the
grid; the lane allocator; `create_folder`; `Asset.source` and the Credits view; the stock download
path (temp → atomic rename, size cap, stall timeout, cancel, progress registry) for the optional
per-sticker animated downloads.

**Deferred scope.** See [`11-RISKS-AND-DEFERRED.md`](./11-RISKS-AND-DEFERRED.md) §2: AI-generated
stickers, GIPHY/Tenor, brand logos, Lottie at runtime, compound text-and-shape templates beyond
numbered badges, gradient fills and inner shadows on shapes (outline, glow and drop shadow come
free from edge styles), sticker search in other languages, a second stock provider, auto-callouts
placed from visual understanding.

**Evidence.** [`10-TESTS-AND-EVIDENCE.md`](./10-TESTS-AND-EVIDENCE.md): unit + apply/invert for
every new op, Python raster goldens, frame-plan vectors, new PX4 oracle rows (pixel parity), e2e for
each sub-tab, performance budgets on a 1,600-tile grid and a 20-element timeline, and a desktop run
on real footage (a 5–15 minute screen recording cut to a short with callouts and stickers,
exported, reopened, undone).

**Product-scope review.** Run 2026-09-26 against this plan; verdict and changes recorded in §7.

---

## 3. Architecture at a glance

```
                       Elements panel (web-editor)
   ┌───────────┬───────────┬──────────────────────┬────────────────────────┐
   │  Photos   │  Videos   │  Stickers            │  Shapes                │
   │  Pexels   │  Pexels   │  bundled catalogue   │  shape catalogue       │
   └─────┬─────┴─────┬─────┴──────────┬───────────┴───────────┬────────────┘
         │ IPC (existing stock:*)     │ IPC elements:materialize │ (no IPC: pure data)
         ▼                            ▼                          │
   main: StockService          main: ElementsLibrary            │
   (download, derive,          (resolve id → bundled file,      │
    ledger, provenance)         copy into project media,        │
         │                      provenance, no enrolment)       │
         └──────────────┬─────────────┘                          │
                        ▼                                        ▼
        editor-core placement builders (one per kind, shared by panel AND agent)
          addStockClipPatch · addStickerPatch · addShapePatch
                        ▼
          Patch → validate (schema v25 rules) → apply → history (one undo)
                        ▼
      ┌─────────────────┴──────────────────┐
      ▼                                    ▼
  frame-plan.ts ◀── vectors ──▶ frame_plan.py
      ▼                                    ▼
  layer compositor (monitor)          compiler.py (export)
  - stickers: decoded image            - stickers: ImageClip → full picture pipeline
  - shapes: engine raster via          - shapes: shape_raster.py → same pipeline
    POST /preview/text-raster (kind: shape)
      └────────────── PX4 oracle compares pixels ──────────────┘
```

The agent reaches the same builders through `search_elements`, `add_sticker` (host-materialised,
like `add_stock`) and `add_shape` (pure patch), in a new `elements` tool domain ([`07`](./07-AI-AND-MCP.md)).

---

## 4. Phase map

Full tasks, files, tests and DoD in [`09-PHASES.md`](./09-PHASES.md).

| Phase    | Ships                                                                                                                                                    | Depends on         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **EL0**  | MD-E6 and MD-E7 answered; shape-raster spike; the scope review (done)                                                                                    | —                  |
| **EL1**  | Stock → **Elements** rename; Photos and Videos as sub-tabs; alias of the saved tab; docs and copy                                                        | MD-E7              |
| **EL2a** | Stills and titles honour opacity keyframes, fades, crop and their own alpha; titles' In/Out presets render (fixes G1, G6, G11)                           | —                  |
| **EL2b** | Masks, edge styles and geometry transitions for stills and titles — with their first consumers (EL6b, EL7)                                               | EL2a               |
| **EL3**  | One definition of synthetic asset ids and clip kind per runtime (replaces 17 modules' comparisons) + guard tests                                         | —                  |
| **EL4a** | **Shapes minimum slice, complete** (desktop): six shapes, Inspector, box/endpoint handles, export, undo, `add_shape` / `set_shape_style`, one eval case  | EL2a, EL3, MD-E6   |
| **EL5**  | Shapes breadth: ~105 shapes / ~200 presets, chips, search, colour row, drag, clip glyph, dashes and caps, numbered badges, ~1,600 icons                  | EL4a               |
| **EL6a** | **Stickers minimum slice, complete**: curated ~200, materialise IPC, Stickers tab, Replace, credits, `add_sticker`, `add_clip` delegation, one eval case | EL2a, MD-E2, MD-E4 |
| **EL6b** | The full 1,595 in the desktop installer, virtualised grid, collections, outline and shadow                                                               | EL6a, EL2b, MD-E1  |
| **EL7**  | Animation: In/Out (layer transitions) and Loop (keyframes from a builder) for stickers, shapes and titles; `set_element_animation`                       | EL2b, EL4a or EL6a |
| **EL8**  | Agent quality: critic checks, compact digest, skill craft pass, remaining eval cases, MCP verification (+ optional MCP sticker materialiser)             | EL4a, EL6a         |
| **EL9**  | Photos/Videos upgrades: category chips, orientation filter, drag to timeline, manual picture-in-picture                                                  | EL1, MD-E5         |
| **EL10** | Animated stickers (optional): on-demand download, animated decode in both runtimes, required credits                                                     | EL6a, EL7, MD-E3   |
| **EL11** | Favourites and recents, skin tones, "Add as sticker", drop on the monitor, follow subject, the browser build                                             | EL6a               |
| **EL12** | Docs, both changelogs, release notes, remaining desktop evidence runs, close-out                                                                         | shipped phases     |

**First executable slice:** EL1 (small, independent) and EL2a (engine; fixes three live bugs in
photos and titles). **First new capability:** EL4a — six shapes, end to end.

---

## 5. Definition of done for the programme

The programme ships when the release gate in [`13-PRODUCTION-READINESS.md`](./13-PRODUCTION-READINESS.md) §10
holds and every row of [`12-SURFACE-COVERAGE.md`](./12-SURFACE-COVERAGE.md) is done. In outcome terms, on a desktop build with evidence committed:

1. The left rail shows **Elements** with Photos, Videos, Stickers and Shapes, and nothing in the UI,
   docs or website says "Stock" except where it names the Pexels library by its function.
2. Each category completes the path: find → preview in the panel → add (click or drag) → appears at
   the playhead on the right lane → edit in the Inspector and on the canvas → preview equals export
   (oracle rows) → one undo removes it → failures are stated in words.
3. The agent can find and place a sticker and a shape, and edit both, through registered tools
   that return validated patches; the MCP server exposes what it can serve.
4. Old projects open unchanged except the listed EL2a fixes (photos fade and crop, titles animate);
   a project with shapes refuses to open in a pre-v25 build with a clear message; a saved
   `leftTab: "stock"` lands on Elements.
5. `plan/PLAN.md`, the guides, the ADRs, `CHANGELOG.md` and the website changelog are updated.

---

## 6. Ledger

| Phase | Status | Notes                                                                     |
| ----- | ------ | ------------------------------------------------------------------------- |
| EL0   | `[x]`  | Scope review (§7); MD-E6, MD-E7 decided; spike A report with numbers      |
| EL1   | `[x]`  | Rename + Photos/Videos sub-tabs; CI green on `9bbde591`                   |
| EL2a  | `[x]`  | Export, plans, monitor, DOM overlay fixed; CI green on `9bbde591`         |
| EL2b  | `[~]`  | Masks, edge styles, turning titles for stills and titles; awaiting CI     |
| EL3   | `[x]`  | One helper per runtime + guards; CI green on `9bbde591`                   |
| EL4a  | `[!]`  | Built and green on `276b8827`; eval run and desktop run are human steps   |
| EL5   | `[x]`  | 106 shapes, 260 presets, 1,703 icons, search, badges; CI green `276b8827` |
| EL6a  | `[!]`  | Green on `9633653c`; eval run and desktop run are human steps             |
| EL6b  | `[~]`  | Built: installer set, grid, Inspector, rows; CI pending; run D human      |
| EL7   | `[~]`  | Built: In/Out/Loop, tool, rows, e2e; CI pending; eval and run C human     |
| EL8   | `[~]`  | Built: checks, rows, skill, cases 4–6, MCP; CI pending; evals human       |
| EL9   | `[~]`  | Built: chips, orientation, drag, Add as overlay (ADR 0193); CI pending    |
| EL10  | `[!]`  | Optional; waits on the MD-E3 licence read (a human step, see 09)          |
| EL11  | `[ ]`  |                                                                           |
| EL12  | `[ ]`  |                                                                           |

---

## 7. Product-scope review

Run 2026-09-26 by the `product-scope-reviewer` against this plan, `product-discipline.mdc`,
`AGENTS.md` and `CLAUDE.md`, with D1 (the maintainer's breadth decision) taken as given.

**Verdict: SHRINK** — keep the programme, shrink the slices. Every finding was checked against the
code before it was adopted; all of the following were confirmed and are now in the plan:

| #   | Finding                                                                                                                                                                                                                                                                                             | Adopted as                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | EL4 (~40 shapes, full panel, two handle systems, browser fallback, three tools, MCP) was too big for a first slice                                                                                                                                                                                  | **EL4a**: six shapes on desktop, as a four-PR stack; the rest moved to EL5                                                                                                                    |
| 2   | Proof of the agent path waited for EL8                                                                                                                                                                                                                                                              | One evaluation case in each category's DoD (EL4a, EL6a, EL7). Grounding is the model reading `get_frame`, reported as a measured hit rate, because automatic UI grounding is deferred (11 §2) |
| 3   | Synthetic ids are compared in **17** modules, not six; `critic.ts:189` and `mission-rubric.ts:230` would count every shape as a missing asset; `frame_plan.py:87` / `frame-plan.ts:447` would call `__shape__` a video                                                                              | **EL3** widened to synthetic asset ids + clip kind, with a guard test per runtime (00 G4)                                                                                                     |
| 4   | A 1e-6 TS↔Python geometry fixture had no consumer once the engine is the only rasteriser                                                                                                                                                                                                            | Dropped; frame-plan bounds come from params; TS geometry is UI-only; the browser fallback is deferred to EL11                                                                                 |
| 5   | EL2 bundled unrelated stages, and missed a live crop bug (G11) and that title In/Out does nothing on desktop (G6)                                                                                                                                                                                   | **EL2a** (opacity, fades, own alpha, still crop, title In/Out) now; **EL2b** (masks, edge styles, geometry transitions) with its first consumers                                              |
| 6   | `loop_motion` + schema v26 had no need a keyframe builder cannot meet                                                                                                                                                                                                                               | Loops are keyframes from `editor-core` (the `track-follow.ts` pattern); `drawOn` deferred; schema v26 is now only EL10's `AssetMedia.animation`                                               |
| 7   | EL0 held spikes for optional phases and asked every MD up front                                                                                                                                                                                                                                     | Spike B moved to EL10, spike C into EL6a.1; each MD is asked when its phase is next                                                                                                           |
| 8   | MD-E4 sat in two phases, and its mechanics were wrong: `createPicturePlacer` is reached only from `add_clip`, `add_clips`, `move_clip` and the `add_stock` path; overlay lanes are skipped (`carriesPicture`); the real trap is `add_clip` of a sticker becoming a cover-cropped full-frame cutaway | MD-E4 is needed before EL6a; `add_sticker` never uses the stock placement path; `add_clip` / `add_clips` / `move_clip` of an element asset delegate to the sticker builder (07 §3–4)          |
| 9   | Fetching all 1,595 stickers in `web-editor#build` ties the web build to a network fetch                                                                                                                                                                                                             | A committed curated ~200 (≈ 4 MB) first (EL6a); the full set is fetched when the desktop app is packaged (EL6b)                                                                               |

Factual corrections made: the raster route's line numbers (`service.py:1211, 6771`), D2's
`OverlaysPanel.tsx:48-53`, 00 G4's function name (`clipKindOf`), 00 G6 (the control does nothing on
desktop — it is not "preview-only"), and 04 §2.5's "one-line change" (true only after EL3).

### EL11 review (2026-09-26)

Run again before EL11 was built. **Verdict: SHRINK** — two items are shown gaps in the editing loop
and stay small: an "Add as overlay" button for the user's own images on the bin's picture cards,
through EL9.4's builder rather than sticker placement (EL11.3), and dropping a sticker or shape onto
the layer monitor at a position (EL11.4). Favourites and recents were already built in EL6b.2
(one gap: a dragged sticker is not recorded as recent). Deferred with their reasons (11 §2): skin
tones (measured ≈ 37 MB, over both the packaged-set and installer budgets), follow subject (MO-14 is
open), and the browser build (both halves stay absent, already proved by tests). The accessibility
and UI passes move into the release gate (EL12.6).

**Last updated:** 2026-09-26
