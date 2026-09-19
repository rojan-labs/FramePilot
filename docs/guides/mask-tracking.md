# Mask tracking

A mask can follow what it covers. This is how that works, end to end, and where each piece
lives.

> Related: [Mask tools](./mask-tools.md) for drawing and animating a mask,
> [Preview masks](./preview-masks.md) for how a mask reaches the monitor,
> [ADR 0178](../adr/0178-mask-stack-replaces-mask-effects.md) for the mask stack itself.

## What a track is

A **transform track** is one 3×3 matrix per source frame, stored in a digest-pinned file the
project owns:

```
<project folder>/.framepilot-derived/tracks/<key>/track.json
```

The mask stores only `{ key, sha256 }`. A two-minute track is 3 600 matrices, and a project file
is not the place for them; pinning the digest means a file changed outside FramePilot is caught
rather than silently rendered.

The track is applied **on top of** the mask's own animation, to the mask's control points
**before** they are flattened. That order matters: warping the rasterised image instead would
soften the edge the whole mask stack exists to keep exact, and the monitor and the export would
not agree. Tangents are warped at their absolute position and turned back into offsets, so a
perspective track bends a curve rather than dragging a straight copy of it around.

Geometry is in **display-corrected source pixels** — the same space the mask's own geometry uses
— so a track and the mask it drives never need a conversion between them. The worker measures in
the coded frame's normalized coordinates; the display correction (pixel aspect ratio and
rotation) is applied to the answer, once, in the host.

## The four methods

They are one measurement constrained four ways, not four trackers. The planar tracker fits a
homography from up to 120 RANSAC-filtered correspondences, so even a position-only track is
measured from the whole patch rather than from one pixel.

| Method                       | What the mask may do                       | Use it for                      |
| ---------------------------- | ------------------------------------------ | ------------------------------- |
| Position                     | translate                                  | a face, a logo on a flat move   |
| Position, scale and rotation | translate, scale uniformly, rotate         | a subject moving towards camera |
| Perspective                  | the full planar homography                 | a sign, a phone screen, a wall  |
| Shape                        | each vertex moves on its own measured path | something that bends            |

Constraining rather than running a weaker tracker has a second payoff: the **residual** between
the requested model and the measured one is an honest per-frame error. A `position` track on a
rotating subject still follows the subject's centre, and every frame whose rotation the model
cannot express lands on the review list instead of being quietly wrong.

A shape track rides `tracking.point` with the path's vertices as extra points, so the whole shape
costs one decode rather than one per vertex.

## Directions

Forward to the clip edge, backward to the clip start, both ways, or a single frame — each from
whatever frame the playhead is on.

Backward is not "forward, reversed". The tracker detects its features on the frame the mask was
drawn on, which for a backward run is the range's **last** frame, so the worker decodes the range
from the end. Decoders only stream forwards, so the reversed source decodes in bounded chunks and
hands each one back in reverse; it never opens outside the approved range.

Whatever the worker anchored to, the artifact is re-anchored (`H_i · H_ref⁻¹`) so the identity
sits on the reference frame. "Both ways" is therefore two measurements the host joins, each
keeping the accuracy of a short run.

## How a frame is measured, and what confidence means

Flow from the previous frame is only the tracker's **guess**. Each frame, the region the mask
covers on the frame it was drawn on is **registered** onto the current frame (ECC, which ignores
an overall exposure change), and the features are re-anchored on that plane, so error never
accumulates from frame to frame. A shape track does the same per vertex, with a small patch
around each one — a larger one where the vertex sits on something flat — and a vertex its patch
cannot confirm follows the vertices that were confirmed rather than its own flow.

**Confidence is a check, not a by-product of the fit.** The region is cut into cells, and each
textured cell is block-matched between the reference frame and the current one. A cell
_agrees_ (it is where the plane says), _contradicts_ (it clearly sits somewhere else) or is
_unseen_ (covered — including a flat stretch that has suddenly gained texture, which is
something passing in front). Confidence is zero at 80 % agreement and reaches the review floor
at 90 %; contradicting cells, and corners that an independent fit to the agreeing cells places
more than half a pixel away, pull it down further. A shape frame is as confident as its worst
vertex. Why: with part of a plane hidden, the visible part fits perfectly while the hidden
corners are extrapolated, and on real footage that extrapolation is off by pixels; only a
measure of how much of the plane is actually confirmed catches it.

**The reference learns (MK7.7).** The frame the mask was drawn on is what every other frame is
registered against, so its own flaws are in every frame: on dim footage at proxy compression its
coding noise alone moved a plane's corners by 0.46–0.71 px depending on which frame it was. A
plane's reference is therefore averaged with the first 8 frames that verify cleanly, each
rectified into it through its own verified registration — the reference keeps its geometry, and
loses most of its noise. Pixels of the plane that something hid on that frame are filled in from
the first frame that shows them cleanly.

**Shadows.** ECC models a lighting change as one gain and offset, and a shadow edge across the
plane is not one: least squares bends the plane to absorb it. When a plane does not verify
cleanly, a fit on images normalised by their own local contrast is offered as well, and the
check — which is locally normalised already — decides which one shows the plane.

## Review, and frames you can promise

Every tracked frame carries a measured confidence, penalised by the model residual. Ranges under
the floor land on the same review list as background removal — one list, not two panels that each
know half the problem.

### Fixing a flagged stretch

1. **Put the mask right on a bad frame.** On the monitor, a tracked mask's handles sit where the
   mask is drawn — its own geometry moved by the track — so you drag it onto the picture you see.
2. **If something is in front of it, box it** with **Exclude region** (`X`) on that same frame.
   Draw around the occluder as it is there; the tracker follows what the box covers from that
   frame on (a hand does not stay where it was), and leaves those pixels out of the fit and out
   of the confidence it reports.
3. **Re-track from constraints.**

Step 1 is one reversible edit (`correct_tracked_mask`): the frame becomes a constraint, and the
geometry you put on screen is stored relative to the track. The re-track then measures outwards
from each constraint in both directions, each direction stopping at the end of the first
low-confidence stretch it meets, so frames the track already had right are kept exactly as they
were. The constraints stay on the mask after the re-track, so the next one can use them again.
Every frame belongs to its nearest constraint, so it is always measured from the closest thing
you confirmed.

On the real-texture set this recovers every long partial occlusion it produces (4 of 4, one
adjustment and one box each; MK7.5 measured 0 of 5 without the box). **Lock this frame** still
exists for a frame that is already right.

### How a correction and the track combine

Both renderers draw a tracked mask as **`T(t) · G(t)`**: the mask's own animation `G`, then the
track `T` on its control points (`tracked_mask_path_at` in the export, `trackedMaskPathAt` in the
preview — the same two steps, pinned bit for bit by `tests/fixtures/mask-track/corrected.json`).

A correction is a keyframe of `G` **relative to the tracked motion**: the geometry `D` you put on
screen at frame `c` is stored as `K = T(c)⁻¹ · D`. It is held (hold keyframes) across the flagged
stretch it sits in — exactly the stretch the re-track re-measures — with your old animation
untouched on either side. The re-track does not restart at the identity on `c`; it continues from
the transform the track had there, `T'(f) = H(c → f) · T(c)`. So on `c`, `T'(c) · K = D`
exactly — a constraint frame is exact by construction, not by tolerance — and every other frame
of the stretch carries your correction with the measured motion.

A path can be corrected under any track. A rectangle or an ellipse under a **perspective** track
is not a rectangle on screen, so it has no rectangle to be the correction of: draw the mask as a
path to correct it, or track it with position, scale and rotation.

## Telling the tracker what to watch

Two monitor tools place hints for the next measurement:

| Tool           | Key | What it does                                                                           |
| -------------- | --- | -------------------------------------------------------------------------------------- |
| Feature point  | `T` | Click to add a point on texture the tracker should follow; click it again to remove it |
| Exclude region | `X` | Drag out a region the tracker must ignore — a hand passing in front, a reflection      |

They are editor state, not project state: they steer the next run and mean nothing once the track
exists. Both stay drawn whatever tool is active, because what the tracker will follow has to be
visible while you adjust the mask.

An excluded region remembers the frame it was drawn on, and the tracker follows its **content**
from that frame (it keeps moving at its last speed while it cannot be found), so draw it around
the occluder, not around the path it will take. A re-track from constraints gives each constraint
the regions drawn on its own frame. On a shape track, a vertex the occluder hides follows the
surface around the shape, registered with the occluder left out.

Seeing the tracker's **own** detected feature points before a run is not implemented: it would
need a capability the frozen pack roster does not have. Your points are additive to whatever the
tracker finds.

## Where things live

| Piece                                          | File                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Artifact format, frame lookup, point warp      | `packages/editor-core/src/mask-track.ts`                                                                           |
| Host policy: methods, residual, flagged ranges | `packages/editor-core/src/mask-track-solve.ts`                                                                     |
| Review list, constraints, re-track plan, merge | `packages/editor-core/src/mask-track-review.ts`                                                                    |
| Corrections relative to the track (MK7.7)      | `packages/editor-core/src/mask-track-correction.ts`, `correct_tracked_mask` in `mask-commands.ts`                  |
| Monitor handles on the drawn mask              | `apps/web-editor/src/components/preview/useMaskTrackArtifacts.ts`, `MaskCanvasTools.tsx`                           |
| Export reader and path warp                    | `engine/python/framepilot_engine/render/tracks.py`                                                                 |
| Monitor reader (loaded before a seek presents) | `apps/web-editor/src/preview/masks/track-source.ts`, `track-location.ts`, `preview/engine/layer-preview-engine.ts` |
| The job: staging, verification, atomic commit  | `apps/desktop/electron/capability-packs/track-job.ts`                                                              |
| The run: resolve, measure, join, commit        | `apps/desktop/electron/capability-packs/track-run.ts`                                                              |
| Panel                                          | `apps/web-editor/src/components/inspector/masks/MaskTracking.tsx`                                                  |
| Worker                                         | `workers/tracking-lite/src/framepilot_tracking_lite/`                                                              |
| Parity vectors (TS == Python, byte-exact)      | `tests/fixtures/mask-track/transforms.json`, `corrected.json`                                                      |
| Measured gates                                 | [`MK7-TRACKING-GATES.md`](../../plan/background-removal-ai/MK7-TRACKING-GATES.md)                                  |

## Refusals

Both renderers refuse the same tracked mask with the same sentence, in the same order — missing
file, then digest, then document, then method:

| Code                    | What the editor is told                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `track_missing`         | Tracking data is missing — track the mask again.                           |
| `track_digest_mismatch` | Tracking data was changed outside FramePilot — track the mask again.       |
| `track_unreadable`      | Tracking data is damaged — track the mask again.                           |
| `track_method_mismatch` | Tracking data was measured with a different method — track the mask again. |

A track on a matte, a key or a mask using the legacy blur feather is refused with its remedy
rather than silently ignored: those follow their own pixels, and a track warps control points.
