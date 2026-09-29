---
name: text-overlays
description: Design text overlays — headings, lower thirds, labels, stamps, quotes, story lines — in designed styles and bundled fonts or an editor's own typography system, with readable timing, safe placement and consistent motion; restyle overlays already placed.
tools: [get_timeline, get_mapped_transcript, get_frame, discover_text_overlay_styles, add_text_layer, set_text_style, set_element_animation, add_keyframes, trim_clip]
---

# Text overlays

**An editor's typography system is the design.** When the request gives families, colours,
sizes, a hierarchy, placement or motion rules, pass them explicitly — `fontFamily`,
`fontWeight`, `color`, `sizePercent`, `xPercent`/`yPercent` — on top of the closest designed
style, and keep every overlay of one role identical. The copy it suggests is the copy unless
you have a better line and say so. The defaults below are for text nobody designed.

## Purpose

Add a second information voice that structures or enriches the edit without duplicating captions.

## When to use

Headings, lower thirds, section stamps, statistics, step labels, hook text, end cards, and
authored story lines over footage with no speech — a title card is one kind of text overlay.

## When not to use

Do not transcribe dialogue, crowd the frame, or add text without enough reading time.

## Required inputs

Message hierarchy, audience, frame/safe area, mapped timing, existing captions/graphics, and the request's typography spec when it has one.

## Expected outputs

Short readable text overlays, consistent placement, and restrained entrance/exit motion.

## Core philosophy

One text overlay, one idea. Text must add meaning the audio or picture does not already provide.

## Professional heuristics

- Aim for 3–7 words and at least `max(1.5s, words/3 + 0.5s)`.
- Lower thirds enter after the face/voice is established and usually hold 3–5s.
- Keep one motion language; 0.2–0.4s opacity/position entrances are usually enough.
- Start from a designed style rather than bare text. `discover_text_overlay_styles` lists
  each style by category with what it looks like (typeface, colour, size, where it sits, how
  it stands off the picture); pass the id as `add_text_layer` `style` and the whole look
  comes with it — outline, shadow or chip included. Pass `category` to see one group.
- Any styling arg you pass beside `style` overrides just that field of the style.
- A pixel size in a brief converts against the frame height: `sizePercent` ≈ px ÷ frame
  height × 100 (140 px on a 1920-high frame ≈ 7.3). Words are re-fitted to the box, so a long
  line can come back smaller — look at it with `get_frame`.
- The separation layer (soft shadow, outline, chip) comes with the style. A brief's exact
  "shadow, no outline" is `outlineWidth: 0` plus `shadow` ({color, blur, offsetX, offsetY} in
  em), or `shadow: "none"` to drop a style's.
- One family of styles per piece: a lower-thirds style for every name, one headline style for
  every section card. Mixing looks reads as inconsistency, not variety.
- Match the style to the job: `lower-thirds` for names and roles, `headlines` for hooks and
  section cards, `callouts` for a word or number to notice, `social` for calls to action,
  `quotes` for a line someone said, `script` for a handwritten aside.
- Change a placed overlay with `set_text_style` — its words, a new `style`, size, font,
  weight, colour or position — never delete and re-add it. A new style keeps the overlay
  where it sits.
- Tracking and leading are args: `letterSpacing` in em (a brief's "+250" is 0.25; styles
  described as "wide tracking" carry ~0.22) and `lineHeight` ("leading 0.9" is 0.9), plus
  `fontStyle: "italic"` in a family that ships one, `textTransform` and `textOpacity`. Each
  overrides just that field of the style. Never fake tracking with spaces between letters —
  each letter then reads, wraps and fits as its own word.
- Motion is whole-element: `set_element_animation` gives an overlay an in and an out (fade,
  pop, slide, wipe, blur) and a loop; `add_keyframes` moves, scales, rotates or fades the clip
  with easing. There is no per-letter or per-word reveal, typewriter, tracking animation or
  stroke-on. Build the nearest honest version — a line-by-line build from one overlay per line,
  each entering on its beat, or one clean entrance — and name what was simplified.
- Timed to music: start each overlay on the onset it should land on (`detect_beats`, then
  `map_time`), so the entrance begins on the beat.

## Decision framework

Name the new information → shorten it → allocate reading time → pick the style (the request's
system, else a designed one) → add → animate only if useful → look at it.

## Common mistakes

Caption duplication, premature exit, inconsistent styling, collisions with faces/captions, or
quietly swapping the editor's fonts and colours for a preset.

## Verification checklist

- Readable at speed, checked on `get_frame` over the real footage.
- Adds unique information.
- Avoids safe-area conflicts.
- Animation supports hierarchy.

## Recovery advice

Shorten copy before extending duration; if the frame remains crowded, remove the least important layer.

## Related skills

`caption-design`, `motion-design`, `hook-crafting`, `vertical-reframe`, `masking-and-compositing`
(text behind a subject), `stickers-and-callouts` (boxes, arrows and markers that point at
something on screen).
