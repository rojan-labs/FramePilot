# ADR 0197 — Text overlay lockups: per-line styles on one overlay

- **Status:** Accepted.
- **Date:** 2026-09-30
- **Decided by:** maintainer request (2026-09-30): "the styles that you give are very naive … the
  background of the styles is also not looking good … research the text overlays used by
  professional video editors and motion designers … they prefer using multiple font
  combinations … decide and build on the system".
- **Relates to:** ADR 0194 (text overlays take the caption typography), plan/PLAN.md "Text
  lockups" (TL1–TL4), `docs/guides/text-overlays.md` "Lockups".

## Context

Every text overlay style was one font at one size. The research behind this change (summarised
in the guide) found that most designed titles are LOCKUPS: two or three lines in different
faces, sizes and colours read as one unit. Examples are a small tracked kicker over a heavy
condensed headline, a script word laid over caps, a name over a smaller role, a big number over
a label, and a quote over its attribution. None of them could be made. Two single-font overlays
stacked by hand come close, but they move, scale, animate and restyle separately, and they
collide as soon as either wraps.

## Decision

1. **A lockup is ONE text overlay whose `typography.lines` styles its lines.** A line is one
   `\n`-separated paragraph of the overlay's text, and `lines[i]` styles paragraph `i`.
   - A line may override the face, weight, italic, case, tracking, line height, letter
     opacity, outline and shadow (`null` removes the shadow).
   - It may also set `scale` (× the overlay's size), `color`, `background` (its own chip
     colour, or `null` for none) with a `chip` shape, and `spaceBefore` (ems of the overlay's
     size, may be negative so lines overlap).
   - A paragraph with no entry keeps the overlay's look.

   The text stays a single string, so typing, the on-canvas editor, search, the assistant's
   `text` argument and every existing operation work unchanged. This is no schema migration:
   effect params are an open record, as in ADR 0194.

2. **The base look is the headline.** The overlay's own family, weight, colour and size are the
   main line's, and the other lines override them. The Inspector's font, size and colour
   therefore act on the headline, and a size change scales every line together.
3. **The engine draws each line with the caption rasterizer and stacks the rasters**
   (`render/text_overlay.py#_stack_lockup`), box on box, aligned by the overlay's `align`.
   Later lines paint over earlier ones where they overlap. Frosted lines stack their backdrop
   coverage the same way. The export and the desktop monitor share the call.
4. **The preview stacks the same caption blocks in CSS** (`textOverlay.ts#textOverlayLineBlocks`,
   rendered by `TextOverlayContent`).
   - Each line's CSS line box is the engine's row height: the face's ascent plus descent from
     the generated face metrics (`titleFaceLines`), plus the outline.
   - Without this, a script's tall ascenders or a condensed face at a 0.9 line height stacked
     differently in the tile than in the export.
   - The box paints nothing, and each line starts from a paint reset, so no line inherits a
     ring or shadow it does not have.
5. **Validation is symmetric.** `TextOverlayLineSchema` and the engine's `_lockup_line_problem`
   refuse the same values. A refused lockup draws the plain overlay in both renderers.
6. **Catalog.** A new **Combos** category leads the Text panel: kicker + headline, documentary,
   script + caps, fashion, serif + wide, wedding, chapter title, creator, explainer. Sport,
   Shout, Hook chips, End card and Vlog join their categories. Name tag, Accent bar, Location,
   Smoked, News bar, Big number, Testimonial, Cinematic and Editorial are rebuilt as lockups. The
   ids are unchanged, and those styles keep the headline first, so a one-line text in them still
   draws the headline look. Catalog tests hold the research numbers: every line at least 2.4 % of
   the frame height, scripts never tracked or capitalised, a Combo mixes families, and every
   style's wrap box sits inside the frame.
7. **Tiles are judged against a photograph**, one per category (`public/text-styles/*.webp`,
   Unsplash licence, credited in `LICENSE-unsplash.txt`), under a light scrim, instead of a grey
   gradient. Final Cut Pro previews overlay titles over a landscape photo for the same reason.
8. **The assistant** learns from `discover_text_overlay_styles` which styles are lockups and what
   each line is, and `add_text_layer`'s description says to write one line per part.

## Consequences

- One new optional param, one extra call per line in the engine, and one component in the
  preview. Overlays without `lines` are byte-identical in the export and unchanged in the
  preview.
- A line that WRAPS inside a lockup is pitched slightly tighter in the preview than in the
  export: the engine adds a gap between wrapped rows, and CSS cannot add it without growing that
  line's chip. Lockup lines are short. The desktop monitor draws the engine raster, so it is
  exact.
- Deferred:
  - Per-line editing in the Inspector: lines keep their look while the Inspector edits the base.
  - Per-word colour inside a line. An accent word goes on its own line.
  - Rotated script accents.
  - Anchoring a lower third by its left edge (a box is placed by its centre).
  - Lockup-aware `title_metrics` (#146).
  - The browser-only fallback raster (#142) draws a lockup's text plainly.
