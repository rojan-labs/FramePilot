---
name: masking-and-compositing
description: Masks and cut-outs on request — remove a background, blur a face, hide or isolate a subject, grade part of the picture, split screen, gradients, heart/star shapes, video in text, a title behind someone, tracking. The editor picks unclear targets; report flagged moments, never call a mask verified.
tools: [find_mask_targets, create_mask, remove_background, track_mask, refine_mask, create_shape_mask, mask_with_layer, style_cutout_edge, measure_subject, put_text_behind_subject, follow_subject, get_masks, delete_mask]
---

# Masking and compositing

## Purpose

Limit what a clip shows, or what an effect touches, to a real subject in the picture, as the
editor would in the Inspector's Mask tab, with the same review list.

## When to use

"Remove the background", "cut her out", "hide the logo", "darken everything but the presenter",
"desaturate the car", "put the title behind him", "split screen", "a heart around her face",
"video inside the title".

## When not to use

- A whole-clip look: use the color tools. A mask is for part of the picture.
- A title that follows a subject: it does not render yet. Say so; do not approximate it.
- Filling a removed object with generated picture: not available. A hidden region shows whatever
  is on the layer below, or black.

## Required inputs

The clip, the editor's own words for the target, and what the mask is for: keep the subject
(`cutout`), take it out of the picture (`hide`), or limit an effect to it (`effect`).

## Expected outputs

One reviewable patch per call, undoable in one step, and a reply that states how many moments
need a look.

## Core philosophy

You choose **which** thing and **what for**; FramePilot measures **where**. You never give
coordinates. Every mask comes from a detection, a pack measurement, or numbers the editor typed.

## The tools, in the order the work uses them

- `find_mask_targets` (clipId, description) finds candidates; `resolved` names the one to use.
  `ambiguous_target`, `needs_click` and `needs_face_selection` show the editor a picker: stop,
  say what to choose, wait. Never pick for them or re-ask more vaguely for another answer.
- `create_mask` (candidateId, precision, purpose, edge, track). `precision: "cutout"` is an exact
  AI edge; `"shape"` fits an ellipse (default for a face), rectangle, or path. `userShape` is only
  for numbers the editor typed; anything else is refused.
- `remove_background` is the cut-out of the main subject, or of the candidate you pass.
- `track_mask` makes an existing shape follow its subject; `create_mask` with `track: true` does
  it in one step. A cut-out needs no tracking: it is measured on every frame.
- `refine_mask` adjusts by intent: `edge` (exact, soft, very_soft), `grow` (tighter, looser — one
  step per call), `mode`, `invert`, `space`. FramePilot picks the numbers. `space: "frame"` holds a
  shape still while the picture moves under it; `"source"` moves it with the picture again.
- `create_shape_mask` (preset, placement, purpose, edge): `split` (side it keeps), `mirror` band
  (`direction`), `gradient` (side that stays opaque), `radial_gradient`, and the shapes `heart`,
  `star` / `polygon` (`points`), `speech_bubble`, `arrow`, `rounded_frame`. Place it on a
  candidateId, on the frame (no placement), or in a `userBox` only from numbers the editor typed.
  `purpose` and `effect` work as in `create_mask`.
- `mask_with_layer` (clipId, sourceClipId or sourceTrackId, channel): another clip or a whole
  track becomes this clip's mask — a title for video inside text. `alpha` uses its shape, `luma`
  its brightness, `inverted-*` the reverse. The source stops being drawn on its own.
- `style_cutout_edge` (clipId, style `outline`/`glow`/`shadow`, preset, color): a line, glow or
  drop shadow around a cut-out; `color` only when the editor named one; `remove: true` undoes it.
- `measure_subject` (clipId, start, end, text, style): where the cut-out subject sits — top of
  the head, shoulder line (the face is between), width covered per band — and, given your
  title, the `xPercent`/`yPercent` and `sizePercent` where it reads as behind. Never edits.
- `put_text_behind_subject` (clipId, text, start, end, style): needs the cut-out first;
  `start`–`end` is the moment, not the shot. A heavy condensed `fontFamily` (Anton, Bebas Neue)
  is the look. A second title on the shot shares its layer.
- `follow_subject` makes one mask reuse another mask's measured track. The source must be tracked.
- `get_masks` lists a clip's masks with ids; `delete_mask` removes one.

## Recipes

- **Remove the background:** `remove_background`. A long clip offers the editor a **Start**
  button instead; say it is waiting. For an approximate edge, `precision: "shape"` is immediate.
- **Title behind a subject:** cut-out first → `measure_subject` with the exact text, style and
  moment → `put_text_behind_subject` with its `xPercent`, `yPercent`, `sizePercent` → `get_frame`:
  the word reads, both ends show beside the subject, its edge is clean. If no height works,
  follow the note (another word or size; zoom out when the head fills the width) — never place
  it anyway. A cut-out still waiting for the editor: say so and stop.
- **Spotlight / "darken everything but the presenter":** `find_mask_targets` → `create_mask` with
  `purpose: "effect"`, `effect: "darken"` on the presenter → `refine_mask` with `invert: true`.
  A clip renders one grade: if it has one, the tool refuses; the editor limits it in the Inspector.
- **Grade only the sky, a sign, a wall:** outside the detector's vocabulary, so
  `find_mask_targets` returns `needs_click`; the editor clicks it in the Inspector.
- **Blur a face or a plate:** `create_mask`, `purpose: "effect"`, `effect: "blur_to_hide"`,
  `track: true` if it moves; one mask per face.
- **Hide a person or an object:** `create_mask`, `purpose: "hide"`, `track: true` if it moves;
  with nothing below, say it exports as black.
- **Split screen:** `create_shape_mask` with `preset: "split"` and `side` on the top clip; the clip
  below shows in the other half.
- **Darken the sky / a graduated filter:** `create_shape_mask` with `preset: "gradient"`,
  `side: "top"`, `purpose: "effect"`, `effect: "darken"`.
- **A heart or star around someone:** `find_mask_targets` → `create_shape_mask` with the preset
  and the candidateId.
- **Sticker outline or shadow on a cut-out person:** cut-out first, then `style_cutout_edge`
  (`preset: "sticker-outline"` for a thick border).
- **Video inside text:** put the title above the clip (titles tools), then `mask_with_layer` on the
  clip with `sourceClipId` = the title and `channel: "alpha"`.
- **Everyone except the host:** `find_mask_targets` returns `needs_face_selection`; the editor
  picks the faces. Face recognition is their choice per project, off by default.

## Professional heuristics

- A hard-edged grade shows its outline: effect masks want a soft edge, composites the exact one.
- Track anything that moves more than a little. A locked-off shot with a still subject needs no
  track, and an untracked shape has no review list.
- One mask per thing. Refine the mask you made rather than stacking a second on top of it.
- Read the clip's row first: `masks: …` says what it already has, and `get_masks` gives the ids.

## Decision framework

Target unclear → ask (the picker). Subject moves → track. Exact edge needed (hair, hands, a
composite) → cutout. Soft-edged treatment (a spotlight, a grade) → shape with `edge: "soft"`.

## Common mistakes

- Choosing between candidates yourself after an `ambiguous_target`.
- Calling the same host tool again after `pack_missing` or a cut-out waiting for the editor.
- Saying a mask is verified, done and checked, or omitting the flagged count.
- Guessing a title's height or size, or holding it for the whole clip.

## Verification checklist

- Every result's flagged count is in the reply, in the editor's words ("3 moments need a look in
  the review list").
- A spot check that agreed is a second opinion, not a review; one that could not tell put its
  frames on the review list.
- Only the editor's review makes a mask verified. Never say it on their behalf.

## Recovery advice

A spot check that says the mask is on the wrong thing means nothing was applied: call
`find_mask_targets` more specifically, or ask which they mean. A refusal names its remedy;
follow it rather than retrying.

## Related skills

`color-grading`, `titles-and-text`, `broll-and-layering`.
