---
name: caption-design
description: Create synchronized, readable, consistent captions from mapped transcript evidence, then choose an appropriate template and verify committed cue timing.
tools: [get_mapped_transcript, get_timeline, discover_caption_styles, add_caption_layer, auto_emphasize_captions, set_track_caption_style, set_caption_style, verify_captions, get_frame]
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
- Keep phrases semantically complete and short enough to scan at playback speed. `add_caption_layer` creates ONE cue: for a full recording or song, create separate mapped phrase cues (normally 3–7 words, never more than 12), never one full-duration block.
- Call `discover_caption_styles`, start from a returned template/font, and override only the fields the format or brand requires.
- For automatic emphasis, reason over the mapped transcript and pass sparse exact spoken anchors to `auto_emphasize_captions`; never invent or rewrite words.
- Put the shared composition—including font, x/y placement, scale, width, rotation, alignment, spacing, background and safe area—on the track. Use per-cue style only for deliberate exceptions.
- Use strong contrast and an outline on uncontrolled footage.
- Choose energetic one-word/build families for punchy shorts, karaoke/phrase families for readable emphasis, and restrained editorial/broadcast looks for long-form.
- Choose one entrance/emphasis motion language. Do not stack per-word animation, cue entrance/exit, a continuous loop, thick outline, background box, and multiple accent colours unless the editor explicitly asks for that maximal style.
- Custom colours, placement, outline/background strength, and scale require representative preview evidence. `get_frame` is how you obtain it: render a cue over the real footage and LOOK at it. Without that evidence, use a restrained catalog template and report the look as visually unreviewed.
- Apply one caption system throughout a video.

## Decision framework

Confirm current mapping → choose segmentation density → create cues → discover the design catalog → select semantic anchors and compose the track → add intentional cue overrides → `verify_captions` for timing → `get_frame` for legibility → fix what the frame shows.

## Common mistakes

Using source times, one full-duration lyric block, styling before generation, stacking novelty animations, changing templates mid-video, overlarge captions over faces, treating a successful patch as proof of sync, or reporting the captions done without ever having looked at one.

## Verification checklist

Timing and legibility fail in different ways and need different checks. `verify_captions`
reads committed state and can only prove the cues are where the words are; it cannot see
that they are unreadable, off the bottom of the frame, or sitting on someone's face.

- Run `verify_captions` after all caption changes.
- Cue count and density are plausible for the transcript; no paragraph-sized or full-duration fallback block remains.
- No cue is stale, outside the sequence, or spans an edit discontinuity.
- Then LOOK. Call `get_frame` on at least two cues over DIFFERENT backgrounds — the busiest shot and a typical one — and confirm from the image itself:
  - the whole cue is inside the frame and inside the safe area, not clipped at an edge;
  - the text reads at a glance against what is actually behind it;
  - it is not covering a face, a graphic, or the platform's own UI zone;
  - it is not so large it dominates the shot, nor so small it cannot be read on a phone.
- Fix what the frame shows and look again. A cue that verifies clean and reads badly is still a broken caption.

## Recovery advice

If verification fails, regenerate from the current mapped transcript rather than nudging stale cues. If no transcript exists, stop caption work and route to `edit-prep`.

## Related skills

`titles-and-text`, `short-form-pacing`, `vertical-reframe`, `finishing-and-delivery`.
