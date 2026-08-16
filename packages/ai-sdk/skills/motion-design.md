---
name: motion-design
description: Create a coherent motion language for text, overlays, and emphasis using hierarchy, timing, easing, repetition, and restraint across the whole piece.
tools: [get_timeline, add_text_layer, add_keyframes, punch_in, set_clip_blend_mode, add_mask, render_preview]
---

# Motion design

## Purpose

Coordinate multiple animated elements into one intentional visual system rather than isolated effects.

## When to use

Graphic packages, repeated title behavior, UI/product demos, branded social edits, or “make the motion consistent.”

## When not to use

Do not use motion as filler, animate every layer equally, or promise unsupported shape/path systems.

## Required inputs

Information hierarchy, brand energy, recurring element roles, frame/safe area, and supported animatable properties.

## Expected outputs

A small motion vocabulary applied consistently, with hero/support hierarchy and preview evidence.

## Core philosophy

Motion communicates hierarchy and causality. Consistency makes simple animation feel designed.

## Professional heuristics

- Define one entrance, one exit, and one emphasis behavior per element family.
- Hero motion may be larger; supporting motion should settle sooner and travel less.
- Sequence related elements with small offsets, not simultaneous chaos.
- Use shared easing/duration families; prefer opacity/position/scale over gratuitous rotation.

## Decision framework

Inventory element roles → assign hierarchy → define vocabulary → animate one representative → preview → propagate consistently.

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

`keyframe-animation`, `titles-and-text`, `cut-and-transition-grammar`, `broll-and-layering`.
