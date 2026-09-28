---
name: text-overlays
description: Design text overlays — headings, lower thirds, labels, callouts, quotes and emphasis text — in the designed text overlay styles and bundled fonts, with readable timing, semantic purpose, safe placement, and consistent motion.
tools: [get_timeline, get_mapped_transcript, discover_text_overlay_styles, add_text_layer, add_keyframes, trim_clip]
---

# Text overlays

## Purpose

Add a second information voice that structures or enriches the edit without duplicating captions.

## When to use

Headings, lower thirds, section cards, statistics, step labels, and hook overlays — a title card is one kind of text overlay.

## When not to use

Do not transcribe dialogue, crowd the frame, or add text without enough reading time.

## Required inputs

Message hierarchy, audience, frame/safe area, mapped timing, and existing captions/graphics.

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
- Change only what the brief asks for: any styling arg you pass beside `style` (a colour,
  a size, a position, `fontFamily`/`fontWeight`) overrides just that field of the style.
- One family of styles per piece: a lower-thirds style for every name, one headline style for
  every section card. Mixing looks reads as inconsistency, not variety.
- Match the style to the job: `lower-thirds` for names and roles, `headlines` for hooks and
  section cards, `callouts` for a word or number to notice, `social` for calls to action,
  `quotes` for a line someone said.

## Decision framework

Name the new information → shorten it → allocate reading time → find a safe free track → add → animate only if useful.

## Common mistakes

Caption duplication, premature exit, inconsistent styling, or collisions with faces/captions.

## Verification checklist

- Readable at speed.
- Adds unique information.
- Avoids safe-area conflicts.
- Animation supports hierarchy.

## Recovery advice

Shorten copy before extending duration; if the frame remains crowded, remove the least important layer.

## Related skills

`caption-design`, `motion-design`, `hook-crafting`, `vertical-reframe`, `stickers-and-callouts`
(boxes, arrows and markers that point at something on screen).
