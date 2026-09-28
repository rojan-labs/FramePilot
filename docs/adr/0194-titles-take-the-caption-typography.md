# ADR 0194 — Titles take the caption typography

- **Status:** Accepted.
- **Date:** 2026-09-28
- **Decided by:** maintainer request (2026-09-28): "the typography should sync with the captions
  typography … whatever typography we have on captions should be there on overlay", and a
  template-first Text panel.
- **Relates to:** ADR 0069 (caption templates are catalog data), ADR 0185 (see-through letters and
  frosted chips), ADR 0180 (the program monitor composites every timeline), plan/PLAN.md "Text
  panel — title templates in caption typography" (TX1–TX6).

## Context

FramePilot had two typographies. A caption carried the whole caption vocabulary (92 bundled
families, outline, shadow, chip shape, case, tracking, line height, see-through letters) and two
renderers held to one another. A title (a text overlay) had a colour, a family, a weight and a
fixed black stroke. Its Inspector offered six font names, five of them not bundled, which the
export looked up on whatever machine it ran on. The Text panel's "style templates" and 9-point
position were preview-only and never saved. A title could not match the captions beside it, and
several title paths stored only their text, so the export drew those in Pillow's default face while
the preview showed Inter.

## Decision

1. **A title's `text` effect may carry `typography`**: the caption style's line-level fields
   (`TitleTypographySchema`, a pick of `CaptionStyleSchema` plus the chip's shape). The title's own
   params stay authoritative for family, weight, colour, size, alignment, wrap width and whether
   there is a chip. `typography` adds the rest. This is no schema migration: effect params are an
   open record, and the type lives in `timeline-schema/title-templates.ts`.
2. **A title with typography is drawn by the caption rasterizer itself.**
   `render/text_overlay.py#title_caption_style` maps the params to a `CaptionStyle`, and
   `rasterize_text_overlay`, the one call the export and the desktop monitor share, draws it with
   `render_caption_raster`. Placement stays the title's own (x/y, transform, masks, transitions).
   A title without typography is unchanged byte for byte. An invalid typography falls back to it,
   never failing the render.
3. **The preview uses the caption CSS.** `titleCaptionStyle` (the TS twin of the mapping) feeds
   `captionLineCss` and `captionBoxCss`. The box hugs the text up to the wrap width and reserves the
   caption renderer's padding with or without a chip, so it wraps where the export does.
4. **Templates are pure data** (`TITLE_TEMPLATE_CATALOG`): 31 hand-made looks, plus every caption
   template as a title ("Caption looks"). Applying a template writes the whole look into the params,
   and nothing resolves a template id at render time.
5. **Excluded from titles:** the frosted chip blur (a title has no backdrop pass), and everything
   word-timed or animated (highlight, accent, entrances, loops). A title animates through its layer
   transitions (EL7).

## Consequences

- The Inspector and the Text panel offer only bundled families (one shared `FontFamilySelect`). A
  stored non-bundled family is shown as "(not bundled)".
- A plain title reads as `PLAIN_TITLE_TYPOGRAPHY` (its fixed stroke in caption units), and its
  first typography edit starts from it, so converting keeps the look.
- `title_metrics` (the agent's title fit) and `subject_layout` still measure the plain layout. A
  typed title may wrap slightly differently from what they predict. The agent's `add_text_layer`
  sets no typography, so its titles are unaffected.
- The browser-only canvas fallback raster (`text-raster.ts`, used when there is no sidecar) does
  not draw typography. The desktop monitor draws the engine's raster and is exact.
- Follow-ups: a `template` argument on `add_text_layer`; frosted titles; saved user styles; the
  caption preview's own chipless wrap padding (the same gap point 3 closes for titles).
