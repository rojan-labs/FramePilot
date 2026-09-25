---
name: stickers-and-callouts
description: Place callout shapes — highlight boxes, arrows, circles, markers, underlines — on the thing the narration names, at the moment it is named, sized to be read and clear of faces and captions. Explains add_shape and set_shape_style.
tools: [get_mapped_transcript, get_frame, get_timeline, measure_subject, add_shape, set_shape_style, move_clip, trim_clip, delete_clip]
---

# Stickers and callouts

## Purpose

Point the viewer's eye at one thing on screen — a button in a screen recording, a price, a line of
text — for exactly as long as the voice is talking about it.

## When to use

Screen recordings, SaaS and product demos, tutorials, reviews: "box the Export button", "circle
the error", "arrow to the price", "underline the headline", "highlight that line".

## When not to use

Not as decoration. Not on every sentence. Not over a face or over the caption band. Not for text
the viewer should read — that is `add_text_layer`.

## Required inputs

The word timing (`get_mapped_transcript`), and a look at the frame where the callout lands
(`get_frame` at that moment): you place by what is on screen, in percent of the frame.

## Expected outputs

One shape per named thing, on screen while it is being talked about, in one consistent style.

## Core philosophy

A callout is a finger pointing at the screen: it must land on the right thing at the right word,
then get out of the way.

## The tools

- `add_shape` places a preset: `rounded-rect/highlight` (yellow outline box), `rounded-rect/filled`
  (solid box), `ellipse/outline` (red ring), `marker-highlight/yellow` (translucent marker),
  `line-arrow/red` (arrow), `underline-marker/yellow` (underline).
- Boxes take `box {x, y, width, height}`: the CENTRE in percent of the frame, the size in percent
  of the frame HEIGHT (as `add_text_layer` sizes text). A 16:9 frame is 177.8 units wide in these
  units, so a box `width: 36` is about a fifth of the frame's width.
- Lines and arrows take `ends {x1, y1, x2, y2}` in percent of each axis. The head is at `x2, y2`:
  start the arrow in empty space and end it just short of the target.
- Colours are `#rrggbb`, `#rrggbbaa`, a name (yellow, red, white, blue, green, black), or `none`.
- `set_shape_style` changes only what you pass: colours, stroke, corners, arrow head, box, ends.

## Professional heuristics

- **Land on the word.** Start the shape when the thing is named (word start from the mapped
  transcript), hold it until the next beat, and end it before the next callout starts. 1.5–3 s is
  typical.
- **One at a time.** Two callouts on screen at once split the eye; sequence them.
- **Pad the target.** A box is 10–20% bigger than the button it frames; a marker covers the line's
  height, not more.
- **Contrast.** Yellow reads on dark UIs, red on light ones; a white filled box behind text needs
  the text on a layer above it.
- **One style per video.** Reuse the same preset and colour for every callout.
- **Faces and captions.** Use `measure_subject` for the face box and keep clear of the bottom
  caption band.

## Decision framework

Find the moment in the transcript → `get_frame` there → read the target's position → place the
preset → `get_frame` again at the shape's midpoint → adjust with `set_shape_style` → move on.

## Common mistakes

A box drawn from a guess instead of the frame; an arrow whose head sits on the target's centre
(it hides what it points at); callouts that outlast the sentence; three styles in one video.

## Verification checklist

- `get_frame` at the shape's midpoint shows it around (or pointing at) the named thing.
- It starts within a fraction of a second of the word and is gone before the next callout.
- Nothing covers a face or a caption.

## Recovery advice

A shape in the wrong place: `set_shape_style` with a corrected `box` or `ends` — do not add a
second one. Wrong timing: `move_clip` or `trim_clip`. Unwanted: `delete_clip`.

## Related skills

`titles-and-text`, `motion-design`, `masking-and-compositing`.
