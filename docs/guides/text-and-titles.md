# Text and titles

Titles (text overlays) are added from the **Text** tab of the left rail and edited in the
Inspector's **Text** tab and on the monitor. They use the same fonts and looks as captions
([ADR 0194](../adr/0194-titles-take-the-caption-typography.md)).

## The Text panel

- **Add a heading / subheading / body text** adds a title at the playhead in the Heading,
  Subheading or Body template and selects it.
- **Search** matches a template's name, sample text, category or font ("neon", "lower thirds",
  "serif").
- **Categories:** Basic, Titles, Lower thirds, Callouts, Social, Quotes, and Caption looks (every
  caption template as a title). "All" shows each category, a **Recent** row of the styles you last
  used, and the first six caption looks with **See all**.
- **Click a tile** to add that title at the playhead. The new title is selected, ready to edit.
  **Drag a tile** onto a lane to add it at the drop point.
- **Apply** (on a tile, while a title is selected) restyles that title and keeps its words, its
  place and its wrap width.
- **On the timeline** lists every title. Click one to go to it and select it, double-click to edit
  its words, or delete it.

A title goes on the lane it is dropped on, else the first overlay lane with room, else a new
overlay lane on top. A title at the same time as another goes on a new layer instead of being
refused.

## Inspector (Text tab)

- **Font:** the bundled caption families, drawn in their own face. **Weight** offers only the
  weights the family ships, and **Italic** appears only for a family with an italic face.
- **Typography:** case, letter spacing, line height, letter opacity (see-through letters), outline
  (colour and width) and shadow (None, Soft, Halo, Hard, Glow; a coloured shadow keeps its colour).
- **Layout:** wrap width, position, and a background chip with its corners and padding.

A title made before this change has no typography and keeps its original look (a fixed black
stroke). Its first typography edit starts from that stroke, so nothing jumps.

## How it works

- Storage: the title's `text` effect params (`TextOverlayParams`, `patch-builders-base.ts`),
  including `typography` and the `templateId` it came from.
- Adding from a template is `add_text_overlay` and `set_effect_params` in one patch, so one undo
  removes it. Restyling is one `set_effect_params`.
- Rendering: a title with typography is drawn by the caption rasterizer (`render/text_overlay.py`
  `title_caption_style` → `render_caption_raster`) in the export and the desktop monitor. The
  browser preview uses the caption CSS (`textOverlay.ts#titleTypographyCss`).
- Catalog: `packages/timeline-schema/src/title-templates.ts`. To add a template, add one object.
  Tests require bundled fonts, real weights and italics, hex colours, a valid typography, a
  separation layer (outline, shadow or chip) and a unique name.

## Limits

- No frosted-glass chip on titles. A caption look with frost keeps its tint and rim.
- No per-word highlight, accent or caption entrance on titles. Animate a title with In/Out/Loop
  (Inspector → Basic → Animation).
- The browser-only fallback preview (no engine) draws titles without typography and says "Preview
  text approximate". The desktop app is exact.
