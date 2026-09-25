# Elements

**Elements** is the left-rail tab for everything you put on or into the picture that you did not
film. It sits second in the rail, right after **Assets**, and replaces the old **Stock** tab.

| Sub-tab    | What it is               | Where it works | Guide                                    |
| ---------- | ------------------------ | -------------- | ---------------------------------------- |
| **Photos** | Stock photos from Pexels | Desktop        | [Photos and videos](./stock-sourcing.md) |
| **Videos** | Stock video from Pexels  | Desktop        | [Photos and videos](./stock-sourcing.md) |
| **Shapes** | Callouts you draw on top | Desktop        | [Shapes](#shapes), below                 |

## Finding your way around

- The sub-tab strip sits at the top of the panel. Click a sub-tab, or focus the strip and use
  **←** / **→** (Home and End jump to the ends).
- Elements remembers which sub-tab you were on, and reopens there.
- If you left the rail on the old **Stock** tab, FramePilot opens **Elements** in its place.
- **Photos** and **Videos** share one search box: type "city skyline" in Photos, switch to
  Videos, and the same words are searched there.

## Photos and Videos

These need a free Pexels API key (Settings → AI → **Photos & videos (Pexels)**). Only the words
you type leave your computer. Everything else — the curated/popular feed on an empty search, the
hover-scrub preview, the monthly quota, and placing a clip as a cutaway — works as described in
[Photos and videos (Pexels)](./stock-sourcing.md).

In the browser build, Photos and Videos are not shown: reaching Pexels needs the desktop app's
main process. While they are the only sub-tabs, the whole Elements tab is absent in the browser.

## Shapes

Six shapes for pointing at things — the staples of a screen recording or a product demo:

| Shape             | What it is for                                    |
| ----------------- | ------------------------------------------------- |
| **Highlight box** | A yellow outline around a button, a field, a menu |
| **Filled box**    | A solid box, e.g. to cover or back something      |
| **Ellipse**       | A red ring to circle something                    |
| **Marker**        | A translucent yellow bar over a line of text      |
| **Arrow**         | A red arrow pointing at something                 |
| **Underline**     | A yellow line under a word or a headline          |

- **Add one:** click its tile. It lands at the playhead for the default overlay length
  (Settings → Editing), on an overlay layer, and is selected. One click is one undo step; History
  reads "Add shape “Highlight box”".
- **Move and resize it on the monitor:** drag the box to move it, a side or corner to resize it.
  An arrow or underline has two round handles, one per end: drag the arrow's tip onto what it
  points at. Arrow keys nudge a selected shape (Shift for a bigger step). Double-click a shape on
  the monitor, or press Enter on it, to select it.
- **Style it in the Inspector (Shape):** fill and stroke on or off, their colour and opacity,
  stroke width and style (solid, dashed, dotted), corner rounding, arrow head size, the caps on a
  line's ends, and the box or the ends as numbers. A change that would leave a shape invisible —
  turning off its only colour — is not made, and the Inspector says why.
- **Everything else is ordinary clip editing:** trim, split, move and delete it on the timeline;
  animate it with Position & size keyframes; give it a blend mode or a transition. The Adjust,
  Speed, Crop, Mask and Effects sections are not shown for a shape: the export draws a shape from
  its own settings, and those sections would do nothing to it.
- **Sizes follow the frame.** A box's size is a share of the frame height, like a title's text, so
  a shape keeps its look when you change the project's orientation.
- **What you see is what you export.** The render engine draws every shape, and the monitor shows
  those same pixels.
- **Ask the assistant:** "put a box around the Export button when I say export", "arrow to the
  price", "make the highlight boxes red" — it uses the same shapes (`add_shape`,
  `set_shape_style`) and looks at the frame to place them.

Shapes need the desktop app: the render engine that draws them runs there. A project with shapes
needs FramePilot with project format 25 or later; an older version refuses to open it rather than
dropping the shapes.

## What stays the same

Saved projects are untouched by the rename: a clip you added from the Stock tab keeps its asset,
its credit and its place on the timeline. The AI agent's photo and video tools keep their names.

## See also

- [Photos and videos (Pexels)](./stock-sourcing.md)
- [Settings](./settings.md)
- The plan behind this tab: `plan/elements/`
