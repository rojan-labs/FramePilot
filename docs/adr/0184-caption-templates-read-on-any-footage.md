# ADR 0184 — Caption templates read on any footage, and the export draws what the preview shows

- **Status:** Accepted. The maintainer asked, on 2026-09-24, to "revise all the caption templates …
  enhance the templates in detail" and to add at least 50 fonts "so that videos and captions can be
  better".
- **Date:** 2026-09-24
- **Relates to:** ADR 0069 (template catalog), ADR 0071 (cue and track style), plan `CT1–CT6` in
  [`plan/PLAN.md`](../../plan/PLAN.md), [`docs/guides/captions.md`](../guides/captions.md).

## Context

Every template was rendered through the export (`render/captions.py`) over a deliberately hard
background: half blown-out, half dark, with a saturated blob. The picture showed two kinds of
problem.

**The templates.** A dozen of them were white text with no outline, shadow or chip. They vanished
on a sky, a white wall or a light shirt, which is the failure `caption_legibility.py` measures after
the fact. A third of the catalog was set in Inter.

**The renderers disagreed.** The template wall and the export drew the same style differently:

1. `outlineWidth` was sixteenths of an em in the preview and raw pixels in the engine. A template's
   `2` was a bold stroke in the editor and a 2 px hairline on a 1080×1920 export.
2. `shadow.blur` is a CSS blur radius (2σ) in the preview, but the engine passed it to Pillow as σ.
   Every exported shadow was twice as soft as the preview.
3. The browser synthesised bold and italic that the family doesn't ship, and moved `opsz` with the
   on-screen size. Pillow draws only bundled faces at default axes.
4. Karaoke-fill and pop/zoom words were drawn from the wrong reference point, so they sat above
   the line in the export.
5. One-word display laid out the whole phrase and drew only the spoken word. On a multi-word cue
   the word slid across the frame inside a chip sized for the phrase. The preview dropped
   not-yet-shown words from the layout, so build lines re-centred as each word arrived. The
   preview also dimmed upcoming words on every phrase caption, and the export only on highlighted
   ones.

## Decision

- **Every template carries a separation layer.** It is one of a small shared set (soft drop, dark
  halo, hard offset, font-relative outline) or a chip dark enough to read against any picture. A
  template without one does not ship.
- **`outlineWidth` is sixteenths of the resolved font size in both renderers.** The preview has
  always read it that way. The engine now converts with `_stroke_px`. This changes the meaning of
  a persisted field's number, so there is no migration: the shape is unchanged. Nothing in the
  editor UI sets the field. It came only from templates and the AI, and the AI's unit sentence
  now states the unit. A project with an explicit outline exports with the stroke its preview
  always showed.
- **`shadow.blur` is a CSS blur radius.** The engine divides by two before blurring.
- **The preview never synthesises a face or moves a non-weight axis** (`font-synthesis: none`,
  `font-optical-sizing: none`). Italic is only asked of families that bundle an italic file.
- **Word geometry is baseline-anchored in the engine,** and scaled words grow about the centre of
  their slot, which is what the preview's CSS transform does.
- **One-word display shows one centred word** with its chip around that word, in both renderers.
  Every other mode keeps each word's place before it appears, in both renderers.
- **Fonts are OFL 1.1 or Apache 2.0 only,** with the licence text shipped next to each file and a
  test that fails without it. Commercial creator faces (Gilroy, Proxima Nova, The Bold Font) are
  not bundled, because their licences forbid redistributing the file.

## Consequences

- Projects that use a catalog template export in the revised look (templates resolve at render
  time). Ids, labels and categories are unchanged.
- The catalog is 62 templates over 92 font families. The bundled fonts add about 13 MB to each of
  the two runtime folders (the preview's `public/fonts`, the engine's `render/fonts`).
- The title tool lists every family, which adds about 227 tokens of tool schema to each agent
  request.
- The `E2E visual regression` snapshots that show caption tiles need a macOS baseline refresh.
