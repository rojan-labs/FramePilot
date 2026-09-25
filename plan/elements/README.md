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

| File                                                         | What it holds                                                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `README.md` (this)                                           | Decision record, scope gate, architecture at a glance, phase map, ledger                                                    |
| [`00-CURRENT-STATE.md`](./00-CURRENT-STATE.md)               | Verified inventory of everything "Stock" touches today, and the gaps found (with a reproduced export gap)                   |
| [`01-CAPCUT-REFERENCE.md`](./01-CAPCUT-REFERENCE.md)         | How CapCut organises Elements / Stickers / Shapes; what we copy, adapt, and skip                                            |
| [`02-UX-SPEC.md`](./02-UX-SPEC.md)                           | Panel, tabs, tiles, states, keyboard, drag and drop, Inspector, on-canvas handles, timeline look, copy                      |
| [`03-CONTENT-LIBRARY.md`](./03-CONTENT-LIBRARY.md)           | The shape catalogue (every base shape and preset), sticker sources and licences, sizes (measured), taxonomy, build pipeline |
| [`04-DATA-MODEL.md`](./04-DATA-MODEL.md)                     | Schema v25, the `__shape__` clip, `add_shape`, validator rules, provenance, ids, folders, clip-kind consolidation           |
| [`05-RENDER-AND-PREVIEW.md`](./05-RENDER-AND-PREVIEW.md)     | Engine rasteriser, compiler, both frame plans, layer compositor, animated stickers, parity oracle, performance              |
| [`06-DESKTOP-HOST-AND-IPC.md`](./06-DESKTOP-HOST-AND-IPC.md) | Main-process library service, IPC, sandbox, CSP, packaging, browser build                                                   |
| [`07-AI-AND-MCP.md`](./07-AI-AND-MCP.md)                     | Tools, the `elements` domain, orchestration, the overlay placement policy change, skill, MCP, goldens                       |
| [`08-RENAME-MATRIX.md`](./08-RENAME-MATRIX.md)               | Every surface the word "Stock" reaches: renamed, kept, or aliased — and why                                                 |
| [`09-PHASES.md`](./09-PHASES.md)                             | The executable phases **EL0–EL12**: tasks, files, tests, Definition of Done, evidence                                       |
| [`10-TESTS-AND-EVIDENCE.md`](./10-TESTS-AND-EVIDENCE.md)     | Test matrix, parity oracle rows, performance budgets, the desktop evidence runs                                             |
| [`11-RISKS-AND-DEFERRED.md`](./11-RISKS-AND-DEFERRED.md)     | Risk register, explicitly deferred scope, open questions                                                                    |

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
or tutorial, and today FramePilot cannot draw one (`OverlaysPanel.tsx:46-51` scaffolds a disabled
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
justified by the old flat monitor; this plan revisits both (EL8, EL9).

### D5 — Parity by construction

Shapes are rasterised by the engine (Pillow) for the export **and** for the desktop monitor, through
the same raster route the monitor already uses for text (`POST /preview/text-raster`, PX2.3). The
browser build falls back to a canvas rasteriser and says "Preview approximate", exactly as titles
do (ADR 0180 decision 4). Stickers are files that both runtimes decode. New PX4 oracle rows prove
it.

### D6 — Fix the picture pipeline for stills and graphics first

Verified on `98ea829a` (00 §3): a still image and a text overlay ignore **opacity keyframes and
transitions** at export _and_ in both frame plans (`frame_plan.py:21-23` documents it as a
"quirk"; `frame-plan.ts:914` "The export places a still without its crop, mask, opacity or
transition"). CapCut-style In/Out/Loop animation of a sticker or shape is impossible until that is
fixed, and the Inspector's opacity control on a photo does nothing today. Phase EL2 fixes it before
any new element type lands.

### D7 — Rename what people see; never rename what projects store

User-facing text says "Elements" everywhere. Persisted and model-facing identifiers are **kept**:
asset ids `stock_pexels_*` (in saved projects and the project brain), `Asset.source.provider =
'pexels'`, the `sources.json` ledger, and the tool names `search_stock` / `add_stock` (recorded runs
and goldens reference them). The Pexels IPC channels stay `framepilot:stock:*` because they are the
Pexels provider's channels, which is still accurate. The persisted left-rail preference `'stock'`
is aliased to `'elements'`. Full matrix: [`08-RENAME-MATRIX.md`](./08-RENAME-MATRIX.md).

### D8 — Sticker library: Fluent Emoji (MIT) core; animated stickers are an optional later pack

- **Core (bundled, offline):** Microsoft Fluent Emoji, MIT licence, 1,595 emoji at upstream commit
  `1ffb34c752ec` (2026-08-24), 3D style (256 px PNG upstream; 19.6 KB average as lossless WebP,
  measured). Per-emoji `metadata.json` supplies CLDR name, group and keywords, which is a ready-made
  search index.
- **Animated (optional, later, EL10):** Google Noto Animated Emoji, **CC BY 4.0** (attribution
  required), 881 items, 512 px animated WebP (~370 KB each, measured). The engine's Pillow already
  decodes them (48 frames RGBA, verified). Carried as required credits through `Asset.source`
  (schema v20), the path CC-BY music already uses.
- **Excluded:** brand and social-network logos (trademark), GIPHY/Tenor content (rights unclear for
  monetised video), anything CC BY-SA or non-commercial.

### D9 — Shapes are data, drawn by one vector primitive

A shape is a catalogue entry (`shape-catalog.json` in `timeline-schema`, mirrored into the engine
with a drift test, the caption-template pattern) that resolves to a normalised vector path plus a
style. One rasteriser draws all of them. The same primitive later draws line icons (Lucide, ISC,
already a dependency) with no new renderer.

### Open maintainer decisions

| Id        | Decision                                                                                                                    | Recommendation                                                                                             | Needed before |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------- |
| **MD-E1** | Bundle ~33 MB of sticker content in the installer (Fluent 3D lossless WebP ≈ 30 MB + thumbnails ≈ 3 MB)                     | **Yes** — offline, instant, like the 25 MB of caption fonts already bundled                                | EL6           |
| **MD-E2** | Store the generated sticker files in git, or fetch them at build time from the pinned upstream commit with SHA-256 pins     | **Fetch at build** (repo pack is 80 MB; stickers would add ~40%); commit only the catalogue and thumbnails | EL6           |
| **MD-E3** | Ship Noto Animated Emoji (CC BY 4.0, credit required in the video description) as a downloadable pack                       | **Yes, as EL10**, after a licence read (same class of question as MO-6/MO-11)                              | EL10          |
| **MD-E4** | Let the agent place stickers and shapes over footage (an exemption from the ADR 0169 coverage refusal for element overlays) | **Yes** — the refusal's premise (the flat monitor) is gone                                                 | EL8           |
| **MD-E5** | Relax the cutaway-only placement of Pexels photos/videos for **manual** placement (picture-in-picture from the panel)       | **Yes, manual only first**; the agent keeps cutaway-first until measured                                   | EL9           |
| **MD-E6** | Schema v25 (a forward-safety bump for shape clips)                                                                          | **Yes** — an older build must refuse a project with shapes, not render it without them                     | EL4           |
| **MD-E7** | Left-rail order: Elements moves to second, after Assets (CapCut's order)                                                    | **Yes**                                                                                                    | EL1           |

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

**Minimum vertical slice.** EL1 (rename, no behaviour change) is the first shippable step and is
small. The first _capability_ slice is **EL2 + EL4**: stills/text honour opacity and transitions,
then one Shapes sub-tab with the basic, arrow, line and highlight shapes, placed, edited, previewed,
exported and undone. Stickers (EL6) follow on the same foundation.

**Reuse.** Pexels service, quota, key custody and provenance (unchanged); `add_text_overlay`'s
synthetic-clip pattern for shapes; the engine text-raster route for shape rasters; the layer
compositor and PX4 oracle; `add_layer_transition` and the transition catalogue for In/Out
animation; `track-follow.ts` for stickers that follow a subject; `@tanstack/react-virtual` for the
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

| Phase    | Ships                                                                                                                                                                                                                                                                     | Depends on               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **EL0**  | Decisions answered, three spikes (shape raster parity, animated WebP parity, library build dry run), product-scope review                                                                                                                                                 | —                        |
| **EL1**  | Stock → **Elements** rename; Photos and Videos as sub-tabs; alias of the saved tab; docs and copy                                                                                                                                                                         | EL0 (MD-E7)              |
| **EL2**  | Stills and text honour opacity keyframes, In/Out transitions, crop and masks, in both frame plans, the monitor and the export                                                                                                                                             | EL0                      |
| **EL3**  | One clip-kind function per runtime (replaces six copies)                                                                                                                                                                                                                  | —                        |
| **EL4**  | **Shapes, first slice, complete**: schema v25, `add_shape`, engine rasteriser, raster route, Shapes sub-tab (~40 shapes), Inspector, on-canvas handles, export, undo — **and** the agent's `search_elements` / `add_shape` / `set_shape_style` in a new `elements` domain | EL2, EL3, MD-E6          |
| **EL5**  | Shapes breadth: the full catalogue (~105 shapes / ~200 presets), dashes and caps, numbered badges, ~1,600 line icons                                                                                                                                                      | EL4                      |
| **EL6**  | **Stickers, first slice, complete**: library build, bundle, `elements:materialize`, Stickers sub-tab (1,595 stickers), placement, Inspector, credits — **and** the agent's `add_sticker` with the overlay placement policy                                                | EL2, MD-E1, MD-E2, MD-E4 |
| **EL7**  | Animation: In / Out (layer transitions) and Loop (new declarative `loop_motion`) for stickers, shapes and titles; `set_element_animation`                                                                                                                                 | EL2, EL4 or EL6          |
| **EL8**  | Agent quality: critic checks, compact digest, skill craft pass, evaluation cases, MCP verification (+ optional MCP sticker materialiser)                                                                                                                                  | EL4, EL6                 |
| **EL9**  | Photos/Videos upgrades: category chips, orientation filter, drag to timeline, manual picture-in-picture                                                                                                                                                                   | EL1, MD-E5               |
| **EL10** | Animated stickers (optional pack): on-demand download, animated decode in both runtimes, required credits                                                                                                                                                                 | EL6, EL7, MD-E3          |
| **EL11** | Favourites and recents, skin tones, "Add as sticker" for your own PNGs, stickers that follow a subject                                                                                                                                                                    | EL6                      |
| **EL12** | Docs, both changelogs, release notes, desktop evidence runs, close-out                                                                                                                                                                                                    | all shipped phases       |

**First executable slice:** EL1 (small, independent) and EL2 (engine, fixes a live bug in photos
and titles). **First new capability:** EL4 Shapes.

---

## 5. Definition of done for the programme

The programme is done when all of the following hold on a desktop build, with evidence committed:

1. The left rail shows **Elements** with Photos, Videos, Stickers and Shapes, and nothing in the UI,
   docs or website says "Stock" except where it names the Pexels library by its function.
2. Each category completes the path: find → preview in the panel → add (click or drag) → appears at
   the playhead on the right lane → edit in the Inspector and on the canvas → preview equals export
   (oracle rows) → one undo removes it → failures are stated in words.
3. The agent can find and place a sticker and a shape, and edit both, through registered tools
   that return validated patches; the MCP server exposes what it can serve.
4. Old projects open unchanged; a project with shapes refuses to open in a pre-v25 build with a
   clear message; saved `leftTab: "stock"` lands on Elements.
5. `plan/PLAN.md`, the guides, the ADRs, `CHANGELOG.md` and the website changelog are updated.

---

## 6. Ledger

| Phase | Status | Notes                                           |
| ----- | ------ | ----------------------------------------------- |
| EL0   | `[ ]`  |                                                 |
| EL1   | `[ ]`  |                                                 |
| EL2   | `[ ]`  | Gap reproduced 2026-09-26 on `98ea829a` (00 §3) |
| EL3   | `[ ]`  |                                                 |
| EL4   | `[ ]`  |                                                 |
| EL5   | `[ ]`  |                                                 |
| EL6   | `[ ]`  |                                                 |
| EL7   | `[ ]`  |                                                 |
| EL8   | `[ ]`  |                                                 |
| EL9   | `[ ]`  |                                                 |
| EL10  | `[ ]`  | Optional; gated on MD-E3                        |
| EL11  | `[ ]`  |                                                 |
| EL12  | `[ ]`  |                                                 |

---

## 7. Product-scope review

_Filled in below after the review runs (§2 "Product-scope review")._

**Last updated:** 2026-09-26
