---
name: broll-and-layering
description: Select and place evidence-backed b-roll and overlays that clarify narration, cover seams, and preserve visual hierarchy without decorative clutter.
tools: [list_assets, get_timeline, get_mapped_transcript, search_visual, add_clip, trim_clip, set_clip_blend_mode, add_mask, add_keyframes, set_track_flags]
---

# B-roll and layering

## Purpose

Turn narration into visual proof while keeping the speaker, graphics, and textures legible as one composition.

## When to use

Cutaways, jump-cut coverage, product/process illustration, textures, picture-in-picture, or masked overlays.

## When not to use

Do not add unrelated movement, cover an emotional performance, or use blend modes as a substitute for shot selection.

## Required inputs

Mapped narration timing, indexed visual evidence, available assets, free overlay ranges, and the story function of each cutaway.

## Expected outputs

Short evidence-backed overlay placements with a WHY that names what each shot clarifies or conceals.

## Core philosophy

B-roll is evidence, not wallpaper. Show concrete nouns and actions; return to faces for emotion, trust, and punchlines.

## Professional heuristics

- Enter slightly before the referenced word so recognition and language land together.
- Typical cutaways last 2–4 seconds; vary duration with information density.
- Keep A-roll audio continuous beneath b-roll.
- Use `normal` for footage; reserve `screen`, `multiply`, or `soft-light` for suitable graphic textures.
- Fade designed overlays; hard pop-ons should be intentional.

## Decision framework

Find a narrative cue → retrieve matching real footage → judge relevance and best source span → confirm a free upper track → place → inspect the return to A-roll.

## Common mistakes

Starting every asset at frame zero, covering the payoff, repeating one shot scale, stacking too many layers, or guessing what an asset shows.

## Verification checklist

- Every cutaway matches the spoken idea.
- No overlay collision or unintended occlusion exists.
- The speaker returns for emotional beats.
- Source selection avoids camera-settle or unusable frames.
- Layer flags, masks, and fades behave as intended.

## Recovery advice

If no matching asset exists, omit the cutaway and say what is missing. If a seam remains distracting, adjust the cut point or framing before adding another layer.

## Related skills

`footage-intelligence`, `titles-and-text`, `cut-and-transition-grammar`, `cinematic-storytelling`.
