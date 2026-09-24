---
name: caption-design
description: Create synchronized, readable, consistent captions from mapped transcript evidence, then choose an appropriate template and verify committed cue timing.
tools: [get_mapped_transcript, get_timeline, discover_caption_styles, caption_the_edit, add_caption_layer, auto_emphasize_captions, set_track_caption_style, set_caption_style, verify_captions, check_caption_legibility, get_frame, measure_subject]
---

# Caption design

## Purpose

Make speech readable without competing with the picture, brand, or platform interface.

## When to use

Caption generation, subtitle styling, short-form retention captions, or caption repair after structural edits.

## When not to use

Do not use title layers as captions, caption before cuts are locked, or manually convert source transcript times.

## Required inputs

Current timeline revision, mapped transcript words, target format, visual safe area, and desired brand energy.

## Expected outputs

Sequence-timed cues on a dedicated track, one consistent track style, and a committed-state verification result.

## Core philosophy

Synchronization and legibility outrank novelty. Style supports comprehension; it never excuses stale timing.

## Professional heuristics

- Use the mapped transcript after structural edits; regenerate if cuts or speed change.
- `caption_the_edit` captions the whole edit in one call: it reads the mapped transcript, segments the retained speech into readable phrase cues (3–7 words, never more than 12) at linguistic breaks, and replaces whatever cues are there — use it for a recording and to repair after any cut. `add_caption_layer` creates ONE cue and is only for patching a specific gap by hand; never build a whole track from it, and never one full-duration block.
- Call `discover_caption_styles`, start from a returned template/font, and override only the fields the format or brand requires.
- For automatic emphasis, reason over the mapped transcript and pass sparse exact spoken anchors to `auto_emphasize_captions`; never invent or rewrite words. Pass the multi-word emphasis phrases as `keepTogether` to `caption_the_edit` before `auto_emphasize_captions`, so no phrase is split across two cues.
- Put the shared composition—including font, x/y placement, scale, width, rotation, alignment, spacing, background and safe area—on the track. Use per-cue style only for deliberate exceptions.
- Keep the caption band off the face: below the shoulder line when there is room, never over
  the eyes or mouth. On a tight 9:16 close-up that usually means low in the frame, just above
  the platform UI zone. When the speaker's clip has its background removed,
  `measure_subject` gives the top of the head and the shoulder line; otherwise `get_frame` on
  the tightest shot and read where the face is before choosing the track's y placement.
- Use strong contrast and an outline on uncontrolled footage. A light, un-outlined caption
  over a light shirt, wall or sky does not read, however well it is timed.
- Choose energetic one-word/build families for punchy shorts, karaoke/phrase families for readable emphasis, and restrained editorial/broadcast looks for long-form.
- Translucent looks are real style fields, not colour hacks. See-through letters: set `textOpacity` (0–1; 0 is hollow, outline-only), never a translucent `textColor`, and keep something solid to read by — an outline rim (`outlineColor` + `outlineWidth` 1.5–2) or a shadow; below ~0.4 over busy footage give it both. Frosted glass: set `background.blur` (0.3–0.4 of the font size) with a low-alpha tint (`#ffffff29` light glass over dark or busy footage, `#0b0b0f4d` smoked over bright) and optionally a rim (`borderColor` `#ffffff73`, `borderWidth` 1). The `glass`, `frosted-bar`, `glass-pill`, `ghost`, `hollow` and `veil` templates are ready-made starting points. Check legibility after either.
- Choose one entrance/emphasis motion language. Do not stack per-word animation, cue entrance/exit, a continuous loop, thick outline, background box, and multiple accent colours unless the editor explicitly asks for that maximal style.
- Custom colours, placement, outline/background strength, and scale require representative preview evidence. `get_frame` is how you obtain it: render a cue over the real footage and LOOK at it. Without that evidence, use a restrained catalog template and report the look as visually unreviewed.
- Apply one caption system throughout a video.

## Decision framework

Confirm current mapping → choose the `caption_the_edit` preset (short-form, subtitle, one-word) → write the cues → discover the design catalog → select semantic anchors and compose the track → add intentional cue overrides → `verify_captions` for timing → `check_caption_legibility` for contrast against the footage → `get_frame` for placement → fix what they show.

## Common mistakes

Using source times, one full-duration lyric block, styling before generation, stacking novelty animations, changing templates mid-video, overlarge captions over faces, treating a successful patch as proof of sync, or reporting the captions done without ever having looked at one.

## Verification checklist

Timing and legibility fail in different ways and need different checks. `verify_captions`
reads committed state and can only prove the cues are where the words are; it cannot see
that they are unreadable, off the bottom of the frame, or sitting on someone's face.

- Run `verify_captions` after all caption changes.
- Run `check_caption_legibility`. Every cue under 3:1 needs the track fixed once for all cues
  (an outline, a background box, or a text colour far from the picture), then a re-check.
- Cue count and density are plausible for the transcript; no paragraph-sized or full-duration fallback block remains.
- No cue is stale, outside the sequence, or spans an edit discontinuity.
- Then LOOK. Call `get_frame` on at least two cues over DIFFERENT backgrounds — the busiest shot and a typical one — and confirm from the image itself:
  - the whole cue is inside the frame and inside the safe area, not clipped at an edge;
  - the text reads at a glance against what is actually behind it;
  - it is not covering a face, a graphic, or the platform's own UI zone;
  - it is not so large it dominates the shot, nor so small it cannot be read on a phone.
- Fix what the frame shows and look again. A cue that verifies clean and reads badly is still a broken caption.

## Recovery advice

If verification fails, re-run `caption_the_edit` — it re-derives every cue from the current timeline — rather than nudging stale cues. If no transcript exists, stop caption work and route to `edit-prep`.

## Related skills

`titles-and-text`, `short-form-pacing`, `vertical-reframe`, `finishing-and-delivery`.
