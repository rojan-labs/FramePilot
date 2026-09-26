# ADR 0190 — Shapes are drawn by the engine

- **Status:** Accepted.
- **Date:** 2026-09-26
- **Relates to:** ADR 0032 (type-agnostic layers; its 2026-09-26 amendment on synthetic ids), ADR
  0180 (the layer compositor is the monitor), ADR 0189 (a still is a picture layer), ADR 0144 (an
  edit that renders as nothing is refused), plan [`plan/elements/`](../../plan/elements/README.md)
  (EL4a, MD-E6).

## Context

Elements adds shapes: a highlight box around a button in a screen recording, an arrow at it, an
ellipse, a translucent marker over a line of text, an underline. They must look identical on the
monitor and in the exported file, be editable by hand and by the agent, and survive undo.

Three designs were on the table:

1. **SVG or canvas in the editor, rasterised again by the engine.** Two rasterisers for every shape
   (and later ~100 shapes and ~1,600 icons), kept in agreement by a geometry fixture. Every
   anti-aliasing difference is an oracle failure.
2. **Pre-rendered PNGs in the catalogue.** No resizing without blur, no recolouring, no endpoint
   editing for arrows, and a large download.
3. **Parameters in the project; the engine draws them; the monitor shows the engine's pixels.**

## Decision

Option 3.

- **The model.** A shape is a synthetic clip (asset id `SHAPE_ASSET_ID`, one per runtime in the
  synthetic-assets helper) carrying one effect of type `shape` whose params are a flat
  `ShapeParams`: a catalogue shape id, a box (`x`, `y` centre in percent of each axis; `width`,
  `height` in percent of the frame **height**) or two ends (`x1, y1, x2, y2`, percent of each
  axis), `fill`, `stroke`, `strokeWidth` (percent of the frame height), `strokeStyle`, end caps, and
  the shape's own numeric knobs (`cornerRadius`, `headSize`). One sizing unit for every graphic, so
  a shape and a title scale together and a circle stays a circle when the orientation changes.
- **`null` means absent.** The engine's `set_effect_params` clears a key given JSON `null`;
  TypeScript keeps it. So both validators read `null` and "no key" alike for every shape key, and
  the two runtimes can never disagree about the same edit.
- **The catalogue is data** (`timeline-schema/src/shape-catalog.ts`, generated to
  `schema/shape-catalog.json` and the engine's copy): frame, generator, bounded knobs, insert size,
  named presets. Renderers dispatch on the generator, never on a shape id.
- **One validator per runtime, same sentences** (`shapeParamsProblem` /
  `shape_params_problem`), pinned by `tests/fixtures/shape-params.json`. The messages name the
  remedy and never echo a magnitude, because the agent's repeated-failure guard keys on the text. A
  shape that would draw nothing is refused (ADR 0144): a box needs a fill or a stroke, a line
  needs a stroke.
- **One rasteriser** (`render/shape_raster.py`, Pillow and numpy, no new dependency): coverage
  masks at 4× supersampling, box-averaged down, composited in premultiplied float and rounded once,
  so a translucent marker has no dark fringe. 1080p ≈ 4 ms and 4K ≈ 18 ms on Apple Silicon, inside
  the 15 ms and 50 ms budgets.
- **Placement is plain arithmetic in both runtimes** (`shape_bounds` / `shapeBounds`): the integer
  frame rectangle the raster covers, pinned by the frame-plan vectors. A frame plan's `shape` layer
  carries those bounds plus the clip's transform, opacity and transitions, exactly as a title's
  layer does, and the export places the raster with the title's pipeline.
- **A rotating shape gets a square raster** as wide as its diagonal. The export rotates a layer
  inside its own box (`expand=False`); without the square, a rotated arrow would lose its tip.
- **The monitor draws the engine's raster**, fetched over the existing preview raster route with
  `kind: "shape"`, cached by what changes pixels (params and frame size), never by transform.
- **Schema v25** (MD-E6): purely additive, and the envelope bump makes an older build refuse a
  project with shapes instead of opening it with every shape missing.

## Consequences

- Preview equals export by construction for a shape's look; the only thing both runtimes compute
  is the bounds, and vectors hold them equal.
- The browser build (no engine) cannot draw shapes until a labelled approximation lands (EL11).
- Titles still rotate inside their tight glyph box and can clip when turned; that is recorded for
  EL2b, which owns geometry for stills and titles.
- A considered alternative, a general `Clip.graphic` field unifying titles and shapes, was
  rejected: it would migrate every title for no user outcome today.

## Amendment — the whole catalogue (EL5, 2026-09-26)

- **Generators, not shapes, are what the rasteriser knows.** Nine: `rect`, `ellipse`, `segment`
  (now optionally curved by a `curvature` knob), `polygon`, `star`, `ring` (even-odd hole),
  `bubble`, `corners`, and `path` — an outline of absolute `M L C Z` on a 0–100 box. The catalogue
  (106 shapes, 260 presets) is data over those nine; a new shape is a catalogue entry.
- **Icons are path shapes.** `scripts/elements/build_icons.mjs` rewrites every Lucide icon (ISC,
  already a web-editor dependency) into that path vocabulary — arcs become cubics, a subpath that
  returns to its start closes — and writes the outlines beside both catalogue copies with the
  licence. `icon/<name>` is a shape id; the validators check it against a names-only list, so
  neither runtime loads 0.7 MB of outlines to validate.
- **Badges add two optional v25 keys**, `label` (1–8 code points) and `labelColor`, accepted only
  on shapes the catalogue marks `labelled`. No envelope bump: v25 has not shipped, so no v25
  project without them exists to protect. The label is drawn with the title face through the
  title rasteriser's font loader.
- **One search ranking**, in `timeline-schema/shape-search.ts`, serves the Shapes tab and the
  agent's `search_elements`; the engine's twin is pinned by `tests/fixtures/shape-search.json`.
- **The canvas is no longer shifted by half a subpixel.** Pillow truncates float coordinates and
  fills inclusively, so the shift biased every shape up and left and spilled coverage into the
  top and left margin; a test now redraws every preset with a wide margin and checks nothing was
  clipped.

## Amendment — 2026-09-26: no browser approximation (EL11)

The consequence above that the browser build "cannot draw shapes until a labelled approximation
lands (EL11)" is settled the other way: EL11's product-scope review keeps Elements out of the
browser build. A `Path2D` rasteriser for the whole catalogue would be the second geometry
implementation this ADR rejected, and it would drift. If the browser build gains an engine
connection, shapes use the existing raster route.
