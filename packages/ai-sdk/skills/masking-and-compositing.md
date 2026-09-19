---
name: masking-and-compositing
description: Masks and cut-outs on request — remove a background, blur a face, hide or isolate a subject, grade part of the picture, split screen, gradients, heart/star shapes, video in text, a title behind someone, tracking. The editor picks unclear targets; report flagged moments, never call a mask verified.
tools: [find_mask_targets, create_mask, remove_background, track_mask, refine_mask, create_shape_mask, mask_with_layer, style_cutout_edge, put_text_behind_subject, follow_subject, get_masks, delete_mask]
---

# Masking and compositing

## Purpose

Limit what a clip shows, or what an effect touches, to a real subject in the picture: exactly as
the editor would in the Inspector's Mask tab, through the same packs, the same operations and the
same review list.

## When to use

"Remove the background", "cut her out", "hide the logo", "darken everything but the presenter",
"desaturate the car", "put the title behind him", "make the mask follow him", "split screen",
"darken the top of the frame", "a heart around her face", "video inside the title".

## When not to use

- A whole-clip look: use the color tools. A mask is for part of the picture.
- A title that follows a subject: it does not render yet. Say so plainly; do not approximate it
  and do not call anything else by its name.
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

- `find_mask_targets` (clipId, description) finds candidates. `resolved` names the candidate to
  use. `ambiguous_target`, `needs_click` and `needs_face_selection` mean the editor is being shown
  a picker: stop, tell them what to choose, and wait for their next message. Never pick for them,
  and never re-ask with a vaguer description to get a different answer.
- `create_mask` (candidateId, precision, purpose, edge, track). `precision: "cutout"` is an exact
  AI edge; `"shape"` fits an ellipse (default for a face), rectangle, or path. `userShape` is only
  for numbers the editor typed; anything else is refused.
- `remove_background` is the cut-out of the main subject, or of the candidate you pass.
- `track_mask` makes an existing shape follow its subject; `create_mask` with `track: true` does
  it in one step. A cut-out needs no tracking: it is measured on every frame.
- `refine_mask` adjusts by intent: `edge` (exact, soft, very_soft), `grow` (tighter, looser — one
  step per call), `mode`, `invert`, `space`. FramePilot picks the numbers. `space: "frame"` holds a
  shape, split, band or gradient still on the frame while the picture moves under it (a window
  the shot slides through); `"source"` makes it move with the picture again.
- `create_shape_mask` (preset, placement, purpose, edge): `split` (side it keeps), `mirror` band
  (`direction`), `gradient` (side that stays opaque), `radial_gradient`, and the shapes `heart`,
  `star` / `polygon` (`points`), `speech_bubble`, `arrow`, `rounded_frame`. Place it on a
  candidateId, on the frame (no placement), or in a `userBox` only from numbers the editor typed.
  `purpose` and `effect` work as in `create_mask`.
- `mask_with_layer` (clipId, sourceClipId or sourceTrackId, channel): another clip or a whole
  track becomes this clip's mask — a title for video inside text. `alpha` uses its shape, `luma`
  its brightness, `inverted-*` the reverse. The source stops being drawn on its own.
- `style_cutout_edge` (clipId, style `outline`/`glow`/`shadow`, preset, color): a line, glow or
  drop shadow around what the clip's masks keep. The clip needs its cut-out first; `color` only
  when the editor named one; `remove: true` takes that style off.
- `put_text_behind_subject` needs the background removed on that clip first.
- `follow_subject` makes one mask reuse another mask's measured track. The source must be tracked.
- `get_masks` lists a clip's masks with ids; `delete_mask` removes one.

## Recipes

- **Remove the background:** `remove_background`. For a long clip the editor is offered a
  **Start** button instead; tell them it is waiting for them. If an approximate edge is enough,
  `create_mask` with `precision: "shape"` is immediate.
- **Title behind a subject:** background removed first, then `put_text_behind_subject`. If the
  cut-out is still waiting for the editor to start it, say so and stop there.
- **Spotlight / "darken everything but the presenter":** `find_mask_targets` → `create_mask` with
  `purpose: "effect"`, `effect: "darken"` on the presenter → `refine_mask` with `invert: true`.
  A clip renders one grade: if it already has one, the tool refuses; tell the editor to limit the
  existing grade to the mask in the Inspector.
- **Grade only the sky, a sign, a wall:** these are outside the detector's vocabulary, so
  `find_mask_targets` returns `needs_click`. The editor clicks it with the Inspector's subject tool.
- **Blur a face or a plate:** `create_mask`, `purpose: "effect"`, `effect: "blur_to_hide"`,
  `track: true` if it moves; one mask per face.
- **Hide a person or an object:** `create_mask` with `purpose: "hide"` and `track: true` if it
  moves. The region shows the layer below; if nothing is below, say it will export as black.
- **Split screen:** `create_shape_mask` with `preset: "split"` and `side` on the top clip; the clip
  below shows in the other half.
- **Darken the sky / a graduated filter:** `create_shape_mask` with `preset: "gradient"`,
  `side: "top"`, `purpose: "effect"`, `effect: "darken"`.
- **A heart or star around someone:** `find_mask_targets` → `create_shape_mask` with the preset
  and the candidateId.
- **Sticker outline or shadow on a cut-out person:** background removed first, then
  `style_cutout_edge` with `style: "outline"` (`preset: "sticker-outline"` for a thick border) or
  `style: "shadow"`.
- **Video inside text:** put the title above the clip (titles tools), then `mask_with_layer` on the
  clip with `sourceClipId` = the title and `channel: "alpha"`.
- **Everyone except the host:** `find_mask_targets` returns `needs_face_selection`; the editor
  picks the faces. Face recognition is their choice per project, off by default.

## Professional heuristics

- An effect mask wants a soft edge: a hard-edged grade shows its outline; a soft one reads as
  light. A composite wants the exact cut-out edge.
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
- Promising a title that follows a subject.
- Giving a split, a gradient or a shape coordinates: place it on a candidate or the frame.

## Verification checklist

- Every result's flagged count is in the reply, in the editor's words ("3 moments need a look in
  the review list").
- A spot check that agreed is a second opinion, not a review; one that could not tell put its
  frames on the review list.
- Only the editor's review makes a mask verified. Never say it on their behalf.

## Recovery advice

A spot check that says the mask is on the wrong thing means nothing was applied: call
`find_mask_targets` with a more specific description, or ask which one they mean. A refusal names
its remedy; follow it rather than retrying the same call.

## Related skills

`color-grading`, `titles-and-text`, `broll-and-layering`.
