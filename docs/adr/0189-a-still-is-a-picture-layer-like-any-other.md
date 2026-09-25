# ADR 0189 — A still is a picture layer like any other

- **Status:** Accepted.
- **Date:** 2026-09-26
- **Relates to:** ADR 0180 (the layer compositor is the monitor), ADR 0178 (mask stacks), the
  frame-plan parity contract (`frame-plan.ts` ↔ `render/frame_plan.py`, PX1), plan
  [`plan/elements/`](../../plan/elements/README.md) (EL2a).

## Context

A photo, a sticker or a title is a picture on the timeline, but the export treated it as a
second-class one. `_compile_image_clip` took a still's colour grade and its placement and nothing
else; `_compile_text_clip` took a title's placement. The frame plan copied those rules as
documented "quirks", so the monitor agreed with the export — on the wrong picture:

- The Inspector's opacity control and opacity keyframes did nothing to a photo or a title.
- A fade, dissolve, wipe or catalog transition on a photo or a title never drew.
- A still's crop was ignored, so an auto-reframed landscape photo in a portrait project showed
  bars and the footage behind it.
- A title's In/Out animation (fade, slide up, slide down, pop) played in the browser's DOM
  overlay only. On the desktop monitor and in the export the title just appeared.

Elements puts stickers and shapes on the timeline as stills. Every one of those gaps would have
shipped as a sticker that cannot fade, pop in or be cropped.

## Decision

A still and a title go through the same picture pipeline as a video clip, in the export, the
frame plan and the monitor:

- **Export** (`render/compiler.py`): a still is cropped, graded, blurred by a legacy blur
  transition, given its alpha by `_attach_mask`, transitioned by the catalog and placed by
  `_place_video_clip`. A title takes the same chain from its blur step on.
- **Own alpha multiplies.** `_attach_mask` multiplies the alpha it computes (opacity × fade ×
  wipe × mask stack) into the layer's existing mask — a PNG's transparency, a title's glyph
  coverage — instead of replacing it. Replacing it would turn a fading sticker into an opaque
  square. The monitor's alpha pass does the same (`alpha = u_opacity * texel.a`).
- **The title envelope is one computation per runtime.** `title_envelope_at` (Python) and
  `titleEnvelopeAt` / `titleEnvelopeFromParams` (TypeScript) give opacity, vertical travel and
  scale for the four presets. The frame plan folds it into the layer's opacity, anchor and scale.
  The DOM overlay and the canvas overlay painter read the same function, so no path keeps its
  own copy.
- **A slide travels 5% of the frame height** (`TITLE_SLIDE_TRAVEL`). The DOM overlay used to move
  by 12% of the text box, which the export cannot express without the box's size. A pop starts
  at 0.7 (`TITLE_POP_FROM`), as before. An absent duration means the editor's 0.4 s default.
- **Mask stacks stay video-only** for now (`with_stack=False`). Masks, edge styles and geometry
  transitions on stills are EL2b, with their own oracle rows.

Parity is pinned the usual way. The new fixture cases (`alpha/still-opacity`,
`geometry/still-crop-cover`, `transitions/still-transitions`, `text/title-opacity`,
`text/title-in-out`) are frame-plan vectors both runtimes must equal, and each is a PX4 oracle
row comparing the monitor's pixels to the export's.

## Consequences

- Projects that already had an opacity keyframe, a transition or a crop on a photo or a title
  now export with it. That is the fix, and it changes those exports. Nothing in the project file
  changes: no schema change, no migration.
- A title with an In/Out preset now slides by a share of the frame, not of its box. A one-line
  title moves further than before; a paragraph moves less. The DOM overlay, the canvas painter,
  the monitor and the export all agree.
- The frame plan's "quirks" list is shorter by three entries. The remaining still-only
  differences (masks, edge styles) are named in the docstring and owned by EL2b.
