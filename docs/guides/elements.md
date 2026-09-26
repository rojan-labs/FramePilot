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
- Elements remembers which sub-tab you were on, and reopens there. The first time, it opens on
  **Photos** if you have added a Pexels key, and on **Stickers** if not: they work offline with no
  setup.
- If you left the rail on the old **Stock** tab, FramePilot opens **Elements** in its place.
- **Photos** and **Videos** share one search box: type "city skyline" in Photos, switch to
  Videos, and the same words are searched there. **Stickers** and **Shapes** keep their own search
  and scroll position while you move between sub-tabs, until FramePilot closes.
- On every sub-tab the search box and the one row of category chips stay put while the tiles
  scroll under them.
- Whatever way an element goes in — a click, a key, a drop on a lane or on the monitor — the new
  clip is selected, so the Inspector and the monitor's handles are on it, and a screen reader hears
  where it landed: "Added Fire at 0:12", "Added the arrow at 0:04", "Added the video at 1:02".

## Photos and Videos

These need a free Pexels API key (Settings → AI → **Photos & videos (Pexels)**). Only the words
you type leave your computer. Without a key, the tab explains this and offers **Add Pexels key**,
which opens Settings with the key field in view and the cursor in it.

- **Categories.** A row of chips under the search box — Business, Technology, People, Nature,
  City, Abstract, Backgrounds, Food, Travel, Textures — each a ready-made search. One click is one
  search of your Pexels allowance; clicking the same chip again costs nothing. Typing leaves the
  category, and **Curated** (Photos) or **Popular** (Videos) takes you back to Pexels' own feed.
- **Orientation.** **Any**, **Landscape**, **Portrait** or **Square**, starting on your project's
  shape — a vertical short is offered vertical shots first. With a category or a search, changing
  it searches again straight away. On the **Curated** / **Popular** feed, which Pexels can't filter
  by shape, it narrows the page already loaded instead of searching again.
- **Add** puts the shot in as a **cutaway** at the playhead: it replaces the picture for its
  length, so over footage it is greyed out and says why: "Add replaces the picture, and there's
  footage at the playhead. Use Overlay to put it on top, or move the playhead to a gap." On a
  screen recording or a talking head, that is most of the timeline, so **Overlay** is the one to
  reach for.
- **Overlay** (Add as overlay) puts it **on top** of whatever is at the playhead: a
  picture-in-picture, centred, at 40% of its fitted size, on a layer in front of your footage and
  under your titles, stickers and shapes. It is selected when it lands, ready to move and resize on
  the monitor. Started inside your programme, it ends where the programme ends rather than making
  the video longer. From the keyboard, a full-frame shot over your footage is **Overlay**, then
  **Scale** 1 in the Inspector's **Position & size** section.
- **Drag a tile onto the timeline** to put the shot full frame at the drop point — on the video
  layer you dropped it on when it has room there, else on a new layer in front of your footage.
- **Keyboard:** the grid is one Tab stop; the arrows move between tiles, Home and End jump to the
  ends. **Enter** adds the focused tile (or, over footage, says why Add can't), **Shift+Enter**
  adds it as an overlay, and **Escape** cancels a download in progress. A focused video tile
  previews as a pointed-at one does, unless your system asks for reduced motion.
- A tile's duration is shown on the picture; its size and photographer show when you point at it.
  A tile already in your project says **In this project**: click it (or press Enter on the tile)
  to find the clip in **Assets**.

Every way in downloads into your project first, with a progress bar and **Cancel** on the tile,
and one undo takes back the clip, any layer it opened and the bin entry. The feed, the hover-scrub
preview and the monthly quota work as described in
[Photos and videos (Pexels)](./stock-sourcing.md).

In the browser build, Photos and Videos are not shown: reaching Pexels needs the desktop app's
main process. While they are the only sub-tabs, the whole Elements tab is absent in the browser.

### Your own images as an overlay

A logo, a screenshot or a cut-out you imported goes over your footage the same way. In the
**Assets** bin, hover an image and click its **Add as overlay** button (the picture-in-picture
icon), or focus the card and press **⌘⇧Enter** (Ctrl+Shift+Enter on Windows and Linux). It lands
as a Pexels **Overlay** does: at the playhead, centred, at 40% of its fitted size, on a layer in
front of your footage and under your titles, stickers and shapes, for five seconds, or until your
programme ends if that is sooner. It is selected when it lands, and a screen reader hears "Added
logo.png as an overlay at 0:04". One undo takes it back; the image stays in the bin.

The button is on image cards only. Stickers keep their own placement (the card's **Add**), sound
has no picture, and your own videos are not offered as overlays yet. On those cards **⌘⇧Enter**
does nothing (it used to add the file as **⌘Enter** does); **⌘Enter** still adds it.

At the smaller bin sizes a card is too narrow for four buttons, so it shows **Add**, **Add as
overlay** (on images) and a **More actions** button (⋯) that holds **Relink media…** and **Remove
from project**; a wider card shows those two directly. On any card, **Shift+F10** (or the
context-menu key) opens More actions from the keyboard, then the arrows and Enter pick one.

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
- **Drop one on the monitor** to put it where you want it in the picture: it lands at the
  playhead, centred where you let go — a line on its middle, an arrow on its tip — and is
  selected, ready to fine-tune; a screen reader hears "Added the highlight box at 0:12". While a
  tile is over the monitor the picture's edge lights up; let go in the black around it and the
  shape lands on the nearest edge. One drop is one undo step. From the keyboard, the same result
  is Enter on the tile, then the arrow keys to nudge the selected shape, or its box in the
  Inspector's **Shape** section.
- **Move and resize it on the monitor:** drag the box to move it, a side or corner to resize it.
  An arrow or underline has two round handles, one per end: drag the arrow's tip onto what it
  points at. Arrow keys nudge a selected shape (Shift for a bigger step). Double-click a shape on
  the monitor, or press Enter on it, to select it. The box and handles are white on a dark edge,
  so they show over any footage in either theme; a screen reader names the shape ("Move Arrow").
  The resize and end handles are for the pointer only; from the keyboard, size a shape with its
  **Box** or **Ends** numbers in the Inspector. Holding Shift to keep a shape's proportions, Alt
  to resize from the centre, snapping and a rotate handle are not offered for shapes yet; turn one
  with **Position & size** in the Inspector.
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

All 1,595 stickers of Microsoft's [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) 3D
set. 251 of them are picked into thirteen collections: Reactions, Celebrate, Hands & gestures,
Hearts, Tech & work, Arrows & pointers, Symbols & signs, Money, Food, Nature, Animals, Travel and
Objects. They all ship inside the desktop app, so they work offline and nothing is downloaded when
you add one. (A development build lists the 251 until `pnpm --filter @framepilot/desktop
build:elements` has built the rest.)

- **Browse:** the chips along the top narrow the grid: **All**, **Recent** (what you added
  lately, with a click or a drag), **Favourites**, the thirteen collections, then the nine groups
  of the whole set (Smileys & Emotion, People & Body, Animals & Nature, Food & Drink, Travel &
  Places, Activities, Objects, Symbols, Flags). A group named like a collection says "(all)":
  "Objects (all)" is every object, "Objects" the picked few. The chip strip scrolls sideways.
- **Search** matches a sticker's name and what it is for ("fire", "party", "thumbs", "check"),
  and you can paste the emoji itself: 🔥 finds the fire sticker.
- **Favourites:** hover a tile and click its star, or press **F** on it. They stay across projects
  and restarts.
- **Keyboard:** the grid is one Tab stop. Arrows move between tiles, Home and End jump to the ends,
  Enter adds, F stars.
- **Already in the project:** a small dot marks a sticker the project holds. Clicking it still adds
  another.
- **Add one:** click its tile. FramePilot copies the sticker into the project folder (it appears
  in the bin's **Elements** folder, marked **Element**) and places it at the playhead for the
  default overlay length (Settings → Editing), on an overlay layer, centred, a third of the frame
  high — or, on a vertical or 4K project, as big as the sticker stays sharp (about a fifth of the
  height), since the library art is drawn at one size. It is selected, and one undo removes it;
  History reads "Add sticker “Fire”". The same sticker added twice uses one copy of the file.
- **Drag one onto the timeline:** drop a tile on an overlay lane and it lands there at the drop
  time. Dropped on footage, it goes on a graphics layer of its own instead.
- **Drop one on the monitor:** it lands at the playhead, centred where you let go, at its usual
  size, and is selected; a screen reader hears "Added Fire at 0:12". A drop in the black around
  the picture lands on its nearest edge. One drop is one undo step. From the keyboard, the same
  result is Enter on the tile, then **Position & size** in the Inspector. (Photos and videos go
  on the timeline, not the monitor, for now.)
- **Move, size and turn it** on the monitor like any other picture: drag it, drag a corner, or use
  the rotate handle. From the keyboard, Tab to the box and use the arrows to move it a pixel at a
  time (Shift, ten); on a corner the arrows scale it by 1% (Shift, 10%), and on the rotate handle
  they turn it by 1° (Shift, 15°). Each press is one undo step. **Position & size** in the
  Inspector sets the same values as numbers, and keyframes animate them. Opacity, fades,
  transitions and blend modes work as they do on a photo.
- **Outline it or give it a shadow:** the Inspector's **Sticker** section has **Outline** (colour
  and width) and **Shadow** (a preset). They trace the sticker's art, not its square. For a glow,
  or every setting, use **Inspector → Mask → Edge style**; a mask you draw on the sticker narrows
  what the styles trace.
- **Soft when enlarged:** a sticker is drawn from a 256-pixel image. Drawn more than one and a half
  times that at your export size, it exports soft, and the Sticker section says **Enlarged beyond
  its sharp size**. The default size is under the line at 1080p; in a 4K project, make stickers
  smaller or accept a softer look.
- **Replace it** without losing your work: in the Inspector's **Sticker** section press
  **Replace…**, or right-click the clip and choose **Replace sticker…**. Elements opens on
  Stickers, with the keyboard in its search; pick another and it takes the old one's place, with
  the same timing, position, size and animation, and the keyboard goes back to **Replace…**.
  **Cancel** or Escape leaves it as it was; so does choosing another Elements tab.
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

## Animation: In, Out and Loop

A sticker, a shape, a title or a picture on a graphics layer can come in, go out and loop while it
is on screen. Right-click it on the timeline and choose **Animation…** — the Inspector opens on the
section with the keyboard on **In** — or find **Animation** on the Inspector's Basic tab.

- **In and Out:** Fade, Pop, Slide left, Slide right, Slide up, Slide down, Wipe or Blur, each with
  a length (at most half the clip). A slide is named by the way it travels: **Slide left** comes in
  moving left, and as an Out it leaves moving left. A moving Out plays its In backwards, so it
  eases away the way it eased in.
- **Loop:** Pulse (grows and shrinks), Float (drifts up and down), Wiggle (rocks), Bounce (hops),
  Spin or Blink, with its **Speed** (seconds per cycle) and **Amount**. A loop is written over the
  clip as it is when you set it: lengthen the clip later and the section says the clip is longer
  than its loop, with **Re-apply** to cover it again. A loop will not replace animation you keyed
  yourself: clear those keyframes first, or pick a loop that moves something else.
- Every change is one undo, and the monitor shows exactly what the export draws.
- **Titles** used to set In and Out on the Text tab; that is Animation's job now. A title that
  already had them keeps them until you change them here.
- **Ask the assistant:** "make the arrow pop in and the sticker pulse". It uses the same In, Out
  and Loop (`set_element_animation`), and keeps to one entrance and at most one slow loop unless
  you ask for more.

## The assistant and elements

The assistant places, changes and removes elements the way you do, and holds itself to the same
standards a careful editor would:

- **It knows what is already there.** Each sticker and shape on the timeline is described to it
  in a few words — "sticker "Fire" at 75%, 25%, 30% high · in: pop", "shape rounded-rect ·
  outline #FFD400 · box 50, 50, 48×27" — in the same numbers its tools take. So "make all the
  highlight boxes red and thicker" restyles the boxes you have, in place, and "remove the
  stickers" removes the stickers and nothing else.
- **It reviews what it placed.** After an edit, its review notes a sticker over a face it
  measured, an element under the captions or, on a TikTok, Reels or Shorts export, under the
  app's own buttons, more than three elements on screen at once, a sticker drawn larger than
  its art stays sharp, and a loop that no longer covers its clip. These are notes, not refusals,
  and a callout that points at something stays on it — a box around a button at the top of a
  screen recording is where it should be.
- **It finishes what you asked for.** A request for a sticker or a callout is not done until one
  is on the timeline.
- **It will not place an element nowhere.** An edit that would leave a sticker or shape outside
  the frame for its whole time on screen is refused, since it would export as nothing.
- **A new sticker is sharp.** Added without a size, a sticker is a third of the frame high, or on
  a vertical or 4K project as big as its art stays sharp. A size you or the assistant ask for is
  kept.
- **Other AI apps (MCP)** can find, draw, restyle and animate shapes in a project. Stickers are
  added in the FramePilot app: over MCP the search offers shapes only and says so.

## What stays the same

Saved projects are untouched by the rename: a clip you added from the Stock tab keeps its asset,
its credit and its place on the timeline. The AI agent's photo and video tools keep their names.

## See also

- [Photos and videos (Pexels)](./stock-sourcing.md)
- [Settings](./settings.md)
- The plan behind this tab: `plan/elements/`
