---
name: motion-design
description: Motion-language reference for text, stickers, shapes and emphasis — hierarchy, timing, easing, repetition and restraint across the whole piece, or applying the motion rules a brief sets consistently.
tools: [get_timeline, add_text_layer, set_element_animation, add_keyframes, punch_in, set_clip_blend_mode, get_frame]
---

# Motion design

**A brief's motion rules are the vocabulary** — entry and exit lengths, easing, "every in/out
on a beat", "no bounce", the most elements on screen at once. Apply them uniformly; the defaults
below fill what they leave open.

## Purpose

Coordinate multiple animated elements into one intentional visual system rather than isolated effects.

## When to use

Graphic packages, repeated text-overlay behavior, UI/product demos, branded social edits, or “make the motion consistent.”

## When not to use

Do not use motion as filler, animate every layer equally, or promise unsupported shape/path systems.

## Required inputs

Information hierarchy, brand energy, recurring element roles, frame/safe area, supported animatable properties, and the request's motion rules.

## Expected outputs

A small motion vocabulary applied consistently, with hero/support hierarchy and preview evidence.

## Core philosophy

Motion communicates hierarchy and causality. Consistency makes simple animation feel designed.

## What moves, and how

- `set_element_animation` gives a sticker, shape or text overlay an in and an out (fade, pop,
  slide-left/right/up/down, wipe, blur, with a length in seconds) and one loop. Its curves are
  fixed; there is no easing argument.
- `add_keyframes` animates a clip's scale, x, y, rotation and opacity with a chosen easing —
  the route when a specified easing or travel matters.
- There is no path or stroke drawing, per-letter animation, or automatic motion blur on moving
  graphics; name the simplification when a brief asks for one.

## Professional heuristics

- Define one entrance, one exit, and one emphasis behavior per element family.
- Hero motion may be larger; supporting motion should settle sooner and travel less.
- Sequence related elements with small offsets, not simultaneous chaos.
- Use shared easing/duration families; prefer opacity/position/scale over gratuitous rotation.
- Beat-landed entrances start on the onset (`detect_beats`, then `map_time`), not near it.

## Decision framework

Inventory element roles → assign hierarchy → define vocabulary (the request's, else your own) → animate one representative → preview → propagate consistently.

## Common mistakes

Every element bouncing, mixed easing languages, motion longer than reading time, unsafe placement, or stacking animation with busy transitions.

## Verification checklist

- Motion clarifies reading order.
- Repeated roles behave consistently.
- Text remains readable throughout.
- No element collides or outlasts its purpose.

## Recovery advice

Remove the lowest-priority motion first, then reduce travel and duration. If hierarchy is still unclear, solve layout before animation.

## Related skills

`keyframe-animation`, `text-overlays`, `stickers-and-callouts`, `cut-and-transition-grammar`, `broll-and-layering`.
