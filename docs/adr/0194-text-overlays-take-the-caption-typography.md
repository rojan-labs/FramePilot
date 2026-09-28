# ADR 0194 — Text overlays take the caption typography

- **Status:** Accepted.
- **Date:** 2026-09-28
- **Decided by:** maintainer request (2026-09-28): "whatever fonts are available on the captions
  they should be available on the overlay as well … there should be multiple styles of overlays
  as templates", and a Text panel redesigned after the competitors'.
- **Relates to:** ADR 0069 (caption templates are catalog data), ADR 0185 (see-through letters and
  frosted chips), ADR 0180 (the program monitor composites every timeline), plan/PLAN.md "Text
  panel — text overlay templates in caption typography" (TX1–TX6).

## Context

FramePilot had two typographies. A caption carried the whole caption vocabulary (92 bundled
families, outline, shadow, chip shape, case, tracking, line height, see-through letters) and two
renderers held to one another. A text overlay (a text overlay) had a colour, a family, a weight and a
fixed black stroke. Its Inspector offered six font names, five of them not bundled, which the
export looked up on whatever machine it ran on. The Text panel's "style templates" and 9-point
position were preview-only and never saved. A text overlay could not match the captions beside it, and
several text overlay paths stored only their text, so the export drew those in Pillow's default face while
the preview showed Inter.

## Decision

1. **A text overlay's `text` effect may carry `typography`**: the caption style's line-level fields
   (`TextOverlayTypographySchema`, a pick of `CaptionStyleSchema` plus the chip's shape). The text overlay's own
   params stay authoritative for family, weight, colour, size, alignment, wrap width and whether
   there is a chip. `typography` adds the rest. This is no schema migration: effect params are an
   open record, and the type lives in `timeline-schema/text-overlay-styles.ts`.
2. **A text overlay with typography is drawn by the caption rasterizer itself.**
   `render/text_overlay.py#text_overlay_caption_style` maps the params to a `CaptionStyle`, and
   `rasterize_text_overlay`, the one call the export and the desktop monitor share, draws it with
   `render_caption_raster`. Placement stays the text overlay's own (x/y, transform, masks, transitions).
   A text overlay without typography is unchanged byte for byte. An invalid typography falls back to it,
   never failing the render.
3. **The preview uses the caption CSS.** `textOverlayCaptionStyle` (the TS twin of the mapping) feeds
   `captionLineCss` and `captionBoxCss`. The box hugs the text up to the wrap width and reserves the
   caption renderer's padding with or without a chip, so it wraps where the export does. A
   wrapped text overlay's box is narrowed to its longest line after layout (`useHugLines`), as the
   engine's chip is, since CSS alone cannot shrink a wrapped box.
4. **Overlay styles are pure data** (`TEXT_OVERLAY_STYLE_CATALOG`): 59 styles of their own in eight
   categories (Basic, Headlines, Lower thirds, Callouts, Social, Quotes, Script, Retro & fun).
   Applying a style writes the whole look into the params, and nothing resolves a template id at
   render time. The caption templates are NOT offered as overlay styles: what captions and
   overlays share is the fonts and the typography vocabulary, not each other's looks (an early
   revision of this branch mapped all 68 caption templates across; the maintainer did not want
   that, and it was reverted).
5. **Every caption font is an overlay font.** The Text panel's Fonts tab and the Inspector list
   the bundled caption families (one `FontFamilySelect`, one `textOverlayFonts.ts` rule: a font change
   keeps the nearest weight the family ships and drops an italic it lacks).
6. **The engine refuses what the preview's schema refuses** (`_typography_problem`), so an
   out-of-range value draws the plain text overlay in both, and a typed text overlay with no stored family or
   size takes the editor's defaults (Inter, 8%).
7. **Excluded from text overlays:** the frosted chip blur (a text overlay has no backdrop pass), and everything
   word-timed or animated (highlight, accent, entrances, loops). A text overlay animates through its layer
   transitions (EL7).

## Consequences

- The Inspector and the Text panel offer only bundled families (one shared `FontFamilySelect`). A
  stored non-bundled family is shown as "(not bundled)".
- A plain text overlay reads as `PLAIN_TEXT_OVERLAY_TYPOGRAPHY` (its fixed stroke in caption units), and its
  first typography edit starts from it, so converting keeps the look.
- `title_metrics` (the agent's text overlay fit) and `subject_layout` still measure the plain layout. A
  typed text overlay may wrap slightly differently from what they predict. The agent's `add_text_layer`
  sets no typography, so its text overlays are unaffected.
- The browser-only canvas fallback raster (`text-raster.ts`, used when there is no sidecar) does
  not draw typography. The desktop monitor draws the engine's raster and is exact.
- Follow-ups: a `template` argument on `add_text_layer`; frosted text overlays; saved user styles; the
  caption preview's own chipless wrap padding (the same gap point 3 closes for text overlays).
