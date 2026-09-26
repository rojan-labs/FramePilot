---
name: stickers-and-callouts
description: Stickers, emoji (🔥 👍 🎉) and callouts — highlight boxes, arrows, circles, underlines, numbered badges — on the word and the thing on screen, clear of faces, captions and platform UI; animate, restyle, move or remove them. Explains add_sticker, add_shape, set_shape_style, set_element_animation.
tools: [get_mapped_transcript, get_frame, get_timeline, get_clips, measure_subject, search_elements, add_sticker, add_shape, set_shape_style, set_element_animation, move_clip, trim_clip, delete_clip]
---

# Stickers and callouts

## Purpose

Point the viewer's eye at one thing on screen for as long as the voice is on it, or punctuate a
moment with a sticker — a 🔥 on "this is fire" — that lands on the word and gets out of the way.

## When to use

Screen recordings, product demos and stills, tutorials, reviews: "box the Export button", "circle
the error", "underline the headline"; and changes to ones already placed: "make the boxes red",
"pop the arrow in", "remove the stickers".

## When not to use

Not as decoration, not on every sentence. Not for text the viewer should read — that is
`add_text_layer`.

## Required inputs

The word timing (`get_mapped_transcript`) and a look at the frame where it lands (`get_frame`). No
tool finds a button or a headline for you: you place by what you see, in percent of the frame.

## Expected outputs

One element per named thing, on screen while it is talked about, in one consistent style.

## Core philosophy

A callout is a finger pointing at the screen: it lands on the right thing at the right word, then
gets out of the way.

## The tools

- `add_shape` places a preset. The staples: `rounded-rect/highlight` (yellow outline box),
  `rounded-rect/filled` (solid box), `ellipse/outline` (red ring), `marker-highlight/yellow`
  (translucent marker), `line-arrow/red` (arrow), `underline-marker/yellow` (underline).
- `search_elements` finds the rest — curved arrows, speech bubbles, stars, badges, icons — and
  every sticker ("fire" or 🔥). A badge takes a `label`: `numbered-circle/red-1` with `label: "2"`
  is step two.
- Boxes take `box {x, y, width, height}`: the CENTRE in percent of the frame, the size in percent
  of the frame HEIGHT. A 16:9 frame is 177.8 of these units wide (9:16 is 56.25), so on 16:9 a
  button a tenth of the frame wide is `width: 18`. Lines and arrows take `ends {x1, y1, x2, y2}` in
  percent of each axis; the head is at `x2, y2`.
- `set_shape_style` changes only what you pass, on one shape. A sticker has no restyle tool.
- `set_element_animation`: in and out are `fade`, `pop`, `slide-left`, `slide-right`, `slide-up`,
  `slide-down`, `wipe`, `blur`; the loop is `pulse`, `float`, `wiggle`, `bounce`, `spin` or
  `blink`, one per clip. A loop covers the clip as it is now: after lengthening it, set it again.

## Reading what is already there

The timeline you are shown each turn gives every sticker and shape a row — clip id, span, then
what it is and where it sits, in the units its tool takes. No `get_clips` needed to find or change
one:

- `sticker "Fire" at 75%, 25%, 30% high · in: pop · loop: pulse` → `xPercent` 75, `yPercent` 25,
  `sizePercent` 30.
- `shape rounded-rect · outline #FFD400 · box 50, 50, 48×27` →
  `box {x: 50, y: 50, width: 48, height: 27}`.
- `shape line-arrow · outline #FF3B30 · ends 38, 38 → 50, 50` →
  `ends {x1: 38, y1: 38, x2: 50, y2: 50}`.

A long layer can end "…(+N more clip(s)…)": `get_clips` lists those.

## Professional heuristics

- **Land on the word.** Start when the thing is named, hold to the next beat, end before the next
  callout. 1.5–3 s is typical.
- **One idea at a time.** Sequence callouts about different moments. Two that belong to one beat
  (a name and its button) may share the screen, staggered; never more than three elements at once.
- **Pad the target.** A box is 10–20% bigger than what it frames; a marker covers the line's
  height, not more.
- **Point, don't cover.** An arrow starts in empty space and its tip stops at the target's near
  edge, just short of the content — never on its middle, where the head hides it.
- **One style per video.** Same preset, colour and stroke for every callout: yellow on dark UIs,
  red on light ones. A tutorial's steps are numbered badges in order.
- **Stickers punctuate, they do not decorate.** One on the beat it answers — the joke, the reveal,
  the win — held 1–2 s, in empty space beside the subject; two stickers at once is one too many.
- **Keep stickers sharp.** Sticker art is 256 px and exports soft past about 1.5× that: keep
  `sizePercent` to about 35 on a 1080-high frame, 20 on a 1080×1920 vertical, 17 at 4K.
- **Animate with restraint.** A 0.3–0.5 s entrance on the element that should catch the eye — a
  sticker pops, a box fades or pops in on the word — and at most one loop on screen, on a sticker,
  slow (a pulse of a second or more). Never loop a box or an arrow: the motion pulls the eye off
  what it points at. Leave the way you came in, or fade.

## Where it may sit

- **Inside the frame**, the whole element 10% in from every edge. The position is its centre: a
  30%-high sticker at `yPercent` 95 hangs off the picture, and one wholly outside the frame for its
  span is refused.
- **Off faces.** Judge the face on `get_frame`. On a clip with a cut-out (background removed),
  `measure_subject` over the element's span gives the head top and shoulder line; the face is
  between.
- **Above the captions.** While captions show, its bottom edge stays above 78% of the frame height,
  the caption band.
- **Clear of the app's buttons.** Vertical for TikTok, Reels and Shorts, the app draws buttons down
  the right edge and text along the bottom: stay left of 86% and above 82%.
- A callout stays on its target, even at an edge or as a ring around a face; these limits are for
  stickers and badges, which choose their own spot.

## Recipes

- **A product still** ("underline the product name and point an arrow at the button"): `get_frame`
  on the still → `underline-marker/yellow`, `ends` across the name just under its baseline (`y1`
  equals `y2`) → `line-arrow/red` from empty space to the button's near edge, half a second later →
  both until the still ends → `get_frame` with both showing.
- **"Make all the highlight boxes red and thicker"**: one `set_shape_style` per box row
  (`shape rounded-rect`, `rectangle`, `hand-drawn-box` with an outline), each with the same
  `stroke: "red"` and `strokeWidth` (the staples draw 0.8; thicker is 1.2–1.6) and nothing else.
  Never delete and re-add.
- **"Remove the stickers"**: `delete_clip` on each clip whose row reads `sticker "…"`, without
  `ripple`; footage, shapes and titles stay.
- **Move or resize a sticker**: `delete_clip` it, `add_sticker` the same one (`search_elements` for
  its `elementId`) with the new numbers, and animate it again. Timing only: `move_clip`.

## Decision framework

Word start from the transcript → `get_frame` there → place → `get_frame` at the element's midpoint
→ fix with `set_shape_style` → next. Asked for a sticker or a callout? The job is not done until one
is on the timeline: fix a refused call from its message and place it.

## Common mistakes

A box drawn from a guess; an arrow head on the target's centre; callouts that outlast the sentence;
a sticker blown past its sharp size; re-adding a shape to restyle it.

## Verification checklist

- `get_frame` at the element's midpoint shows it on (or pointing at) the named thing, whole.
- It starts within a fraction of a second of the word and is gone before the next callout.
- Nothing covers a face, a caption or the app's buttons; never more than three at once.

## Recovery advice

A shape in the wrong place: `set_shape_style` with a corrected `box` or `ends`, not a second shape.
Wrong timing: `move_clip` or `trim_clip`. A refused edit names its remedy; follow it.

## Related skills

`titles-and-text`, `motion-design`, `masking-and-compositing`.
