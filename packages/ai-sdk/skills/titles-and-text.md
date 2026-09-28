---
name: titles-and-text
description: Design title cards, lower thirds, labels and emphasis text — typeface (any bundled font), weight, hierarchy, readable timing, safe placement and consistent motion; restyle existing titles.
tools: [get_timeline, get_mapped_transcript, add_text_layer, set_text_style, set_element_animation, add_keyframes, trim_clip]
---

# Titles and text

## Purpose

Add a second information voice that structures or enriches the edit without duplicating captions.

## When to use

Titles, lower thirds, section cards, statistics, step labels, and hook overlays.

## When not to use

Do not transcribe dialogue, crowd the frame, or add text without enough reading time.

## Required inputs

Message hierarchy, audience, frame/safe area, mapped timing, and existing captions/graphics.

## Expected outputs

Short readable text clips, consistent placement, and restrained entrance/exit motion.

## Core philosophy

One card, one idea. Text must add meaning the audio or picture does not already provide.

## Professional heuristics

- Aim for 3–7 words and at least `max(1.5s, words/3 + 0.5s)`.
- Lower thirds enter after the face/voice is established and usually hold 3–5s.
- Keep one motion language; 0.2–0.4s opacity/position entrances are usually enough.

## Type

- `add_text_layer` takes `fontFamily` (any bundled family: serif display faces such as
  "Playfair Display" or "DM Serif Display", sans such as "Inter" or "Space Grotesk",
  hand/script faces such as "Caveat") and `fontWeight` (100–900). A brief's named font
  that is not bundled gets its closest bundled equivalent, and you say which.
- Build a hierarchy from two faces at most: a display face for the title, a sans for
  labels. Keep one family per role across the whole edit.
- Change a placed title with `set_text_style` (words, size, font, weight, colour,
  position) — never delete and re-add it. Animate it in and out with
  `set_element_animation`.
- There is no letter-spacing (tracking) control. Do not fake it with spaces between the
  letters: each letter then reads, wraps and fits as a separate word. Use a wide face or a
  heavier weight, and say tracking was not available.

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
