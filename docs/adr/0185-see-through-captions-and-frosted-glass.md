# ADR 0185 — See-through caption letters and frosted-glass caption boxes

- **Status:** Accepted. The maintainer asked, on 2026-09-24, for translucent captions that the AI
  and a person can both build, "through the core … end to end", and chose two looks: see-through
  text and a frosted-glass box.
- **Date:** 2026-09-24
- **Relates to:** ADR 0069 (template catalog), ADR 0071 (cue and track style), ADR 0184 (caption
  templates read on any footage), plan `CT7–CT12` in [`plan/PLAN.md`](../../plan/PLAN.md).

## Context

Neither look could be expressed. A `textColor` with alpha gave a tint, not see-through letters,
and each renderer drew the outline and shadow under the translucent fill. The preview used a CSS
stroke centred on the outline plus a `text-shadow`, and both show through a translucent letter.
The export drew the shadow under it at reduced strength. So a "see-through" caption showed its own
outline and shadow inside its letters, and a different amount in each renderer. A frosted box
needs the picture _behind_ the caption, and the export rasterises a caption as a standalone image
that cannot see the picture.

## Decision

**Schema v24** (additive migration, a v23 project renders unchanged):

- `captionStyle.textOpacity` (0–1) is the opacity of the letters' fill: every fill colour
  (text, highlight, accent, karaoke). The outline ring stays at full strength and is drawn only
  outside the letters. The shadow is cast by the letters at full strength and knocked out wherever
  a letter is. What shows through a letter is the chip or the picture, never the caption's own
  outline or shadow. At 0 the letters are hollow.
- `background.blur` (the Gaussian's standard deviation, a fraction of the font size) makes the
  chip frosted glass: the delivered picture behind the chip is replaced by its blur, and `color`
  tints it. `borderColor`/`borderWidth` (sixteenths of the font size) draw the glass rim inside the
  chip, so the rim never changes the chip's size.

**Export (`render/captions.py`, `render/compiler.py`).** Each word's letter fill is recorded in a
coverage mask as it is drawn. The drawn words are split into their ring and their fill, and the
shadow is knocked out by the mask. Paint order: box, active-word chips, shadow, ring, glow, letters.
The renderer returns the chip's backdrop mask from the same layout pass. The mask goes through
every whole-caption transform and is placed exactly like the caption. When any caption is frosted,
a caption compositor reads each frame once and handles each caption playing at `t`: it blurs only
the chip's box (plus 3σ) under the mask, then composites the caption with MoviePy's own
`compose_on`. Nesting one composite per cue would re-blit the frame once per caption on the track.

**Preview (`CaptionOverlay`, `captionPreview.ts`).** A see-through caption is three stacked copies
of one layout: chips; opaque glyphs through an SVG filter (dilate by the outline width, blur and
offset for the shadow, then cut out the glyphs); translucent letters and glow. This is the export's
paint order. The filter works in pixels, so the font size is measured. The frost is
`backdrop-filter: blur()` (a standard deviation, like the field) and the rim is an inset ring.
Neither goes on cue-list rows.

**Surfaces.** Six templates (Glass, Frosted Bar, Glass Pill, Ghost, Hollow, Veil). The caption
panel gets a "Transparency and glass" section: letter opacity, box kind, tint, box opacity, frost,
corners and rim. The AI caption tools, the units sentence and the caption-design skill name the
fields and their ranges. `check_caption_legibility` draws key-coloured letters solid, because a
translucent key colour escaped its colour distance.

## Consequences

- A see-through caption costs the export a coverage mask and one split per frame. A frosted caption
  costs a blur of the chip's box per frame. Tracks without either composite exactly as before.
- Parity has been checked side by side in Chromium against the Pillow render. Known small
  differences: the preview's dilation kernel is square where Pillow's stroke is round (invisible
  at 1–3 px), and the preview's box does not fade with a non-per-word entrance while the export's
  box and frost do (a pre-existing difference in how each renderer fades the box).
- `textColor` alpha keeps its old meaning (a tint). The tools and the skill point to `textOpacity`
  for see-through.
