# Text and text overlays

Text overlays are any words you put on screen: a title, a description, a label, a quote, a call to
action. They are added from the **Text** tab of the left rail and edited in the Inspector's **Text**
tab and on the monitor. Every font captions have is available to them, and
they are drawn with the same typography engine
([ADR 0194](../adr/0194-text-overlays-take-the-caption-typography.md)).

## The Text panel

The panel has two tabs, **Styles** and **Fonts**.

### Styles

- **Add a heading / subheading / body text** adds a text overlay at the playhead in the Heading,
  Subheading or Body template and selects it.
- **Search** matches a template's name, sample text, category or font ("neon", "lower thirds",
  "serif").
- **Categories:** Combos, Basic, Headlines, Lower thirds, Callouts, Social, Quotes, Script, and
  Retro & fun, 74 styles in all. "All" shows every category, after a **Recent** row of the styles
  you last used. **Combos** are multi-font lockups (see [Lockups](#lockups)).
- **Tiles** show each style over a photograph chosen for its category (a person for lower thirds,
  a street for headlines, a dark sea for callouts), because a text style is judged against a
  picture.
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

## Lockups

A lockup is a text overlay whose lines are set in different faces, sizes and colours, and read
as one title. Examples: a small tracked kicker over a heavy headline, a script word laid over
caps, a name over its role, a big number over its label. Each line of the text (split where you
press Shift+Enter, or where the assistant writes `\n`) takes its own look from the style.
Lines past the ones the style names keep the headline's look.

- Type the words as usual. Double-click on the monitor to type; while you type, the words show in
  the headline's look, and each line gets its own look back when you finish.
- The Inspector's font, size and colour act on the headline. Changing the size scales every
  line together.
- **Apply** restyles any text overlay, lockup or not; its words stay, line by line.

### The rules the styles follow

Researched 2026-09-30 from broadcast, documentary, editorial and creator practice. The numbers
are enforced by `text-overlay-styles.test.ts`.

- **Two families, and a third only as an accent.** A script or handwritten accent is limited to a
  few words. Never pair two faces that are nearly the same: two geometric sans of one weight,
  two condensed caps, two scripts or two Didones read as a mistake.
- **Step sizes clearly.**
  - A kicker is 25–35 % of a display headline.
  - A lower third's role is 55–75 % of the name.
  - A stat's label is 13–20 % of the number.
  - No line is smaller than 2.4 % of the frame height (~28 px at 1080p). Thinner lines do not
    survive a streaming encode.
- **Tracking.**
  - Small caps kickers and roles: +0.12 to +0.4 em.
  - Condensed caps headlines: 0 to +0.03 em.
  - Heavy display in mixed case: −0.01 to −0.03 em.
  - Scripts: never tracked and never capitalised, because tracking breaks their joins.
- **Tight leading.** Stacked display caps sit at 0.85–0.95. A kicker sits close enough to its
  headline to read as one unit.
- **One accent.** Use one accent colour, on one element: the kicker, the script word or a chip.
- **Separation by genre.**
  - Cinematic, documentary and wedding titles use no plate, just a soft lift.
  - Lower thirds and news use plates, one per line.
  - Social uses chips or a heavy outline.
  - Didones and scripts get a shadow, never an outline.
- **Placement.** Titles stay inside title-safe (90 % of the frame). Lower thirds sit bottom-left,
  above the caption band. Hooks sit in the upper third.

Sources:

- SMPTE ST 2046-1 safe areas.
- Lower-third guides from LiGR, anfx and Infinite Creation.
- Material Design's overline style.
- Adobe's font-pairing guidance.
- Apple's keynote typography, and a Vox-style token set.
- Classic pairings: Bebas Neue + Montserrat, Playfair Display + Montserrat, Great Vibes +
  Montserrat, Archivo Black + Inter + Caveat.

### How a lockup is stored

`typography.lines` on the text overlay's `text` effect (`TextOverlayLineSchema`,
`text-overlay-styles.ts`), one entry per line. A line may set any of these fields:

- `fontFamily`, `fontWeight`, `fontStyle`, `textTransform`, `letterSpacing` and `lineHeight`.
- `textOpacity`, `outlineColor` and `outlineWidth`.
- `shadow`, where `null` means none.
- `scale`, relative to the overlay's size.
- `color`.
- `background`, the line's chip colour, where `null` means no chip.
- `chip`, the chip's shape.
- `spaceBefore`, in ems of the overlay's size. It may be negative, so lines overlap.

See [ADR 0197](../adr/0197-text-overlay-lockups.md).

## Inspector (Text tab)

- **Font:** the bundled caption families, drawn in their own face. **Weight** offers only the
  weights the family ships, and **Italic** appears only for a family with an italic face.
- **Typography:** case, letter spacing, line height, letter opacity (see-through letters), outline
  (colour and width) and shadow (None, Soft, Halo, Hard, Glow; a coloured shadow keeps its colour).
- **Layout:** wrap width, position, and a background chip with its corners and padding.
- **Frost:** frosted glass behind the chip, which blurs the video under it (0 is off). It is drawn
  through the text overlay's own position, size, rotation and transitions, in the export and both
  monitors.
- **Position & size:** Stretch X and Stretch Y squash or stretch the letters on top of the uniform
  scale.

## On the monitor

The selected text overlay gets the monitor's bounding box ([guide](monitor-bounding-box.md)):

- Drag inside it to move it.
- Drag a corner to scale the words and the wrap width together.
- Drag the left or right side to reflow the words: a new wrap width, the same size.
- **Shift**-drag any handle to stretch the letters.
- Drag the lollipop to turn it.
- Double-click to type.

The box hugs the words as the export lays them out, so its size is the size of the ink on screen.

## The assistant

The assistant knows the styles. `add_text_layer` takes a `style` id and applies the whole look;
any colour, size, position, font or weight you ask for overrides just that field.
`discover_text_overlay_styles` lists the styles with one line describing each (typeface, colour,
size, placement, separation). The `text-overlays` skill tells it when to use which. It restyles
an overlay it already placed with `set_text_style` (new words, a new style that keeps the overlay
where it sits, or any single field) instead of deleting and re-adding it. It can also
stretch or squash a text overlay (`add_keyframes` with `scaleX`/`scaleY`).

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
- Lockups are drawn line by line through the same rasterizer and stacked
  (`text_overlay_line_layouts` → `_stack_lockup`). The preview renders each line as its own
  caption block (`textOverlayLineBlocks` via `TextOverlayContent`), with the line box set to the
  engine's row height (`titleFaceLines`), so the lines stack where the export stacks them.
- Catalog: `packages/timeline-schema/src/text-overlay-styles.ts`. To add a style, add one object.
  Tests require bundled fonts, real weights and italics, hex colours, a valid typography, a
  separation layer (outline, shadow or chip), a unique name, at least 5 styles per category and a
  wrap box inside the frame. Lockup lines are held to the rules in [Lockups](#lockups).
- Tile photographs: `apps/web-editor/public/text-styles/<category>.webp` (640×360, Unsplash
  licence, credited in `LICENSE-unsplash.txt`). A new category needs a photo of its own.
- Fonts: `CAPTION_FONT_CATALOG` (the caption fonts); the font-change rule is
  `apps/web-editor/src/editor/textOverlayFonts.ts`.

## Limits

- Frosted glass ignores the text overlay's masks and edge styles: it frosts the chip's whole area
  ([#141](https://github.com/rojan-labs/FramePilot/issues/141)).
- No per-word highlight, accent or caption entrance on text overlays. Animate a text overlay with In/Out/Loop
  (Inspector → Basic → Animation).
- The browser-only fallback preview (no engine) draws text overlays without typography and says "Preview
  text approximate" ([#142](https://github.com/rojan-labs/FramePilot/issues/142)). The desktop app is
  exact.
- The assistant's fit measures the face, weight and case, not tracking, outline or chip padding
  ([#146](https://github.com/rojan-labs/FramePilot/issues/146), [#135](https://github.com/rojan-labs/FramePilot/issues/135)).
- A lockup's lines keep their own looks; the Inspector edits the headline only, and one word
  inside a line cannot take its own colour (put an accent word on its own line).
- A line that wraps inside a lockup is drawn slightly tighter in the browser preview than in the
  export (the desktop monitor is exact).
- Saved styles of your own are not there yet ([#145](https://github.com/rojan-labs/FramePilot/issues/145)).
