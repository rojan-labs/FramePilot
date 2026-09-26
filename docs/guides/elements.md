# Elements

**Elements** is the left-rail tab for everything you put on or into the picture that you did not
film. It sits second in the rail, right after **Assets**, and replaces the old **Stock** tab.

| Sub-tab      | What it is               | Where it works | Guide                                    |
| ------------ | ------------------------ | -------------- | ---------------------------------------- |
| **Photos**   | Stock photos from Pexels | Desktop        | [Photos and videos](./stock-sourcing.md) |
| **Videos**   | Stock video from Pexels  | Desktop        | [Photos and videos](./stock-sourcing.md) |
| **Shapes**   | Callouts you draw on top | Desktop        | [Shapes](#shapes), below                 |
| **Stickers** | Emoji art, in 3D         | Desktop        | [Stickers](#stickers), below             |

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

About a hundred shapes in nine groups, each in a few ready-made styles, plus every
[Lucide](https://lucide.dev) icon (about 1,700). The tab opens on the six staples of a screen
recording or a product demo:

| Shape             | What it is for                                    |
| ----------------- | ------------------------------------------------- |
| **Highlight box** | A yellow outline around a button, a field, a menu |
| **Filled box**    | A solid box, e.g. to cover or back something      |
| **Ellipse**       | A red ring to circle something                    |
| **Marker**        | A translucent yellow bar over a line of text      |
| **Arrow**         | A red arrow pointing at something                 |
| **Underline**     | A yellow line under a word or a headline          |

- **Browse:** the chips narrow the grid to Basic, Arrows, Lines, Callouts, Highlights, Stars &
  badges, Frames, Symbols, Numbers or Icons. **Search** matches names and what a shape is for
  ("box", "curved arrow", "speech bubble", "badge", "check") and reaches the icons too. Icons show
  120 at a time; **Show more icons** adds more.
- **Colour:** the colour row above the grid recolours every tile and becomes the colour of the
  next shape you add; the split disc goes back to each shape's own colours. A colour you pick with
  the picker joins the row. The row, the chip and your recent colours are remembered for you, not
  saved in the project.
- **Numbered badges** carry a number (or any label up to eight characters) inside the shape. The
  Numbers chip has steps 1–5; change the label in the Inspector for any other.
- **Keyboard:** the grid is one Tab stop — arrows move between tiles, Home and End jump to the
  first and last, Enter adds. `/` jumps to the search while you are in the panel; Escape clears
  it.
- **Add one:** click its tile. It lands at the playhead for the default overlay length
  (Settings → Editing), on an overlay layer, and is selected. One click is one undo step; History
  reads "Add shape “Highlight box”". Or **drag** the tile onto the timeline: it lands where you
  drop it, on that layer if it is an overlay layer with room.
- **Move and resize it on the monitor:** drag the box to move it, a side or corner to resize it.
  An arrow or underline has two round handles, one per end: drag the arrow's tip onto what it
  points at. Arrow keys nudge a selected shape (Shift for a bigger step). Double-click a shape on
  the monitor, or press Enter on it, to select it.
- **Style it in the Inspector (Shape):** the shape itself (swap a box for a star, an arrow for a
  curved arrow — the colours and placement stay), fill and stroke on or off, their colour and
  opacity, stroke width and style (solid, dashed, dotted), the shape's own settings (corner
  rounding, star points, curve, tail position…), a badge's label and its colour, the caps on a
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
  price", "number each step", "make the highlight boxes red" — it searches the same catalogue
  (`search_elements`), places the same shapes (`add_shape`, `set_shape_style`) and looks at the
  frame to place them.
- **On the timeline** shape clips have their own colour and a small picture of the shape beside
  the name, on the lanes and on the minimap.

Shapes need the desktop app: the render engine that draws them runs there. A project with shapes
needs FramePilot with project format 25 or later; an older version refuses to open it rather than
dropping the shapes.

## Stickers

251 stickers from Microsoft's [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) 3D set,
in thirteen collections: Reactions, Celebrate, Hands & gestures, Hearts, Tech & work, Arrows &
pointers, Symbols & signs, Money, Food, Nature, Animals, Travel and Objects. They ship inside the
app, so they work offline and nothing is downloaded when you add one. The rest of the Fluent
Emoji set comes in a later update.

- **Browse and search:** the chips narrow the grid to one collection. **Search** matches a
  sticker's name and what it is for ("fire", "party", "thumbs", "check"), and you can paste the
  emoji itself: 🔥 finds the fire sticker.
- **Keyboard:** the grid is one Tab stop. Arrows move between tiles, Home and End jump to the ends,
  Enter adds.
- **Add one:** click its tile. FramePilot copies the sticker into the project folder (it appears
  in the bin's **Elements** folder, marked **Element**) and places it at the playhead for the
  default overlay length (Settings → Editing), on an overlay layer, centred, a third of the frame
  high. It is selected, and one undo removes it; History reads "Add sticker “Fire”". The same
  sticker added twice uses one copy of the file.
- **Move, size and turn it** on the monitor like any other picture: drag it, drag a corner, or use
  the rotate handle. **Position & size** in the Inspector sets the same values as numbers, and
  keyframes animate them. Opacity, fades, transitions and blend modes work as they do on a photo.
- **Replace it** without losing your work: in the Inspector's **Sticker** section press
  **Replace…**, or right-click the clip and choose **Replace sticker…**. Elements opens on
  Stickers; pick another and it takes the old one's place, with the same timing, position, size
  and animation. **Cancel** leaves it as it was.
- **From the bin:** double-click a sticker in the Elements folder, or drag it onto the timeline, and
  it is placed exactly as the Stickers tab places it: never as full-frame footage.
- **A sticker is not footage.** It is never analysed or indexed, it does not appear in Footage
  understanding, and it is never treated as a repeated take. A b-roll cutaway the assistant adds
  over it goes in underneath it, so the sticker stays on top.
- **Credits:** the Export dialog's Credits list Fluent Emoji once, however many stickers you use.
  The licence (MIT) does not require it, but it is right to say where the art came from.
- **If a sticker's file goes missing** from the project folder, FramePilot copies it back from the
  app when you open the project, before anything tries to read it.
- **Ask the assistant:** "add a fire emoji when I say 'this is fire'", "put a thumbs-up at the
  end". It searches the same library (`search_elements`), adds the sticker the way the tab does
  (`add_sticker`), and looks at the frame to keep it clear of faces and captions.
- **What you see is what you export.** The render engine draws the same file, at the same place,
  size and transparency, as the monitor.

If a sticker cannot be added, the tab says why: not enough disk space, a damaged or missing file
in this install of FramePilot (reinstalling fixes it), or a project folder that cannot be written
to. Stickers need the desktop app: in the browser the Stickers tab is not shown.

## What stays the same

Saved projects are untouched by the rename: a clip you added from the Stock tab keeps its asset,
its credit and its place on the timeline. The AI agent's photo and video tools keep their names.

## See also

- [Photos and videos (Pexels)](./stock-sourcing.md)
- [Settings](./settings.md)
- The plan behind this tab: `plan/elements/`
