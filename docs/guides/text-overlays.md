# Text and text overlays

Text overlays (text overlays) are added from the **Text** tab of the left rail and edited in the
Inspector's **Text** tab and on the monitor. Every font captions have is available to them, and
they are drawn with the same typography engine
([ADR 0194](../adr/0194-text-overlays-take-the-caption-typography.md)).

## The Text panel

The panel has two tabs, **Styles** and **Fonts**.

### Styles

- **Add a heading / subheading / body text** adds a text overlay at the playhead in the Heading,
  Subheading or Body template and selects it.
- **Search** matches a template's name, sample text, category or font ("neon", "lower thirds",
  "serif").
- **Categories:** Basic, Headlines, Lower thirds, Callouts, Social, Quotes, Script, and Retro & fun,
  59 styles in all. "All" shows every category, after a **Recent** row of the styles you last
  used.
- **Click a tile** to add that text overlay at the playhead. The new text overlay is selected, ready to edit.
  **Drag a tile** onto a lane to add it at the drop point.
- **Apply** (on a tile, while a text overlay is selected) restyles that text overlay and keeps its words, its
  place and its wrap width.
- **On the timeline** lists every text overlay. Click one to go to it and select it, double-click to edit
  its words, or delete it.

### Fonts

All 92 bundled caption fonts, each drawn in its own face with the weights it ships (and "Italic"
where it has one). Search them, or filter by Sans serif, Display, Serif, Monospace or
Handwritten & script.

- With a text overlay selected, **click a font** to set that text overlay in it. The weight moves to the nearest
  one the font ships, and an italic it lacks is dropped.
- With nothing selected, **click a font** to add a heading in it at the playhead.

A text overlay goes on the lane it is dropped on, else the first overlay lane with room, else a new
overlay lane on top. A text overlay at the same time as another goes on a new layer instead of being
refused.

## Inspector (Text tab)

- **Font:** the bundled caption families, drawn in their own face. **Weight** offers only the
  weights the family ships, and **Italic** appears only for a family with an italic face.
- **Typography:** case, letter spacing, line height, letter opacity (see-through letters), outline
  (colour and width) and shadow (None, Soft, Halo, Hard, Glow; a coloured shadow keeps its colour).
- **Layout:** wrap width, position, and a background chip with its corners and padding.

A text overlay made before this change has no typography and keeps its original look (a fixed black
stroke). Its first typography edit starts from that stroke, so nothing jumps.

## How it works

- Storage: the text overlay's `text` effect params (`TextOverlayParams`, `patch-builders-base.ts`),
  including `typography` and the `templateId` it came from.
- Adding from a template is `add_text_overlay` and `set_effect_params` in one patch, so one undo
  removes it. Restyling is one `set_effect_params`.
- Rendering: a text overlay with typography is drawn by the caption rasterizer (`render/text_overlay.py`
  `text_overlay_caption_style` → `render_caption_raster`) in the export and the desktop monitor. The
  browser preview uses the caption CSS (`textOverlay.ts#textOverlayTypographyCss`).
- Catalog: `packages/timeline-schema/src/text-overlay-styles.ts`. To add a style, add one object.
  Tests require bundled fonts, real weights and italics, hex colours, a valid typography, a
  separation layer (outline, shadow or chip), a unique name, and at least 5 styles per category.
- Fonts: `CAPTION_FONT_CATALOG` (the caption fonts); the font-change rule is
  `apps/web-editor/src/editor/textOverlayFonts.ts`.

## Limits

- No frosted-glass chip on text overlays (a text overlay has no backdrop pass).
- No per-word highlight, accent or caption entrance on text overlays. Animate a text overlay with In/Out/Loop
  (Inspector → Basic → Animation).
- The browser-only fallback preview (no engine) draws text overlays without typography and says "Preview
  text approximate". The desktop app is exact.
