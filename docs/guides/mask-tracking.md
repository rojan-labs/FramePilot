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

## Review, and frames you can promise

Every tracked frame carries a measured confidence, penalised by the model residual. Ranges under
the floor land on the same review list as background removal — one list, not two panels that each
know half the problem.

Fix the mask on a bad frame and **Lock this frame**. That instant becomes a constraint, and
**Re-track from constraints** measures outwards from each constraint in both directions, over
only the stretches still under the floor. The constraints stay on the mask after the re-track, so
the next one can use them again (they were dropped before E2E.3). Every frame belongs to its nearest constraint, so it is
always measured from the closest thing you confirmed.

A constraint frame is exact by construction, not by tolerance: the re-measured segment is
anchored **on** it, so its transform there is the identity and your corrected geometry is what
renders.

## Telling the tracker what to watch

Two monitor tools place hints for the next measurement:

| Tool           | Key | What it does                                                                           |
| -------------- | --- | -------------------------------------------------------------------------------------- |
| Feature point  | `T` | Click to add a point on texture the tracker should follow; click it again to remove it |
| Exclude region | `X` | Drag out a region the tracker must ignore — a hand passing in front, a reflection      |

They are editor state, not project state: they steer the next run and mean nothing once the track
exists. Both stay drawn whatever tool is active, because what the tracker will follow has to be
visible while you adjust the mask.

Seeing the tracker's **own** detected feature points before a run is not implemented: it would
need a capability the frozen pack roster does not have. Your points are additive to whatever the
tracker finds.

## Where things live

| Piece                                          | File                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Artifact format, frame lookup, point warp      | `packages/editor-core/src/mask-track.ts`                                                                           |
| Host policy: methods, residual, flagged ranges | `packages/editor-core/src/mask-track-solve.ts`                                                                     |
| Review list, constraints, re-track plan, merge | `packages/editor-core/src/mask-track-review.ts`                                                                    |
| Export reader and path warp                    | `engine/python/framepilot_engine/render/tracks.py`                                                                 |
| Monitor reader (loaded before a seek presents) | `apps/web-editor/src/preview/masks/track-source.ts`, `track-location.ts`, `preview/engine/layer-preview-engine.ts` |
| The job: staging, verification, atomic commit  | `apps/desktop/electron/capability-packs/track-job.ts`                                                              |
| The run: resolve, measure, join, commit        | `apps/desktop/electron/capability-packs/track-run.ts`                                                              |
| Panel                                          | `apps/web-editor/src/components/inspector/masks/MaskTracking.tsx`                                                  |
| Worker                                         | `workers/tracking-lite/src/framepilot_tracking_lite/`                                                              |
| Parity vectors (TS == Python, byte-exact)      | `tests/fixtures/mask-track/transforms.json`                                                                        |
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
