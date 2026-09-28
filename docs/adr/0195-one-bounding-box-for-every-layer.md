# ADR 0195 — One bounding box for every layer on the monitor

- **Status:** Accepted.
- **Date:** 2026-09-28
- **Decided by:** maintainer request (2026-09-28): "a production-ready, highly polished Bounding
  Box (Transform Control Overlay)" with Figma/Premiere-grade handles, uniform scaling by default
  and Shift for freeform, rotation about the centre, correct mapping at any zoom, UI state kept
  apart from the data model, and no inversion flipping.
- **Relates to:** ADR 0180 (the program monitor composites every timeline), ADR 0190 (shapes are
  drawn by the engine), ADR 0191 (an element is an overlay), ADR 0194 (text overlays take the
  caption typography), plan/PLAN.md "Text panel" (BB1–BB3).

## Context

The monitor had three separate sets of on-canvas controls:

- `PreviewTransform` for pictures. It did uniform scale only, because the transform model had one
  `scale`. It had corner handles but no edge handles.
- The shape editor's own handles.
- A text overlay's move-only drag.

Each had its own pointer math, its own zoom handling and its own idea of what a gesture writes.
They drew inside `.preview-frame`, which clips its content (`overflow: hidden`) and is scaled by
the monitor zoom (a CSS `scale()`). As a result:

- A full-frame clip's corner handles and rotation handle were cut off.
- At 200% every rule and handle doubled in size.
- The browser monitor dropped a clip's rotation entirely.

## Decision

1. **Geometry is pure and lives in project pixels.**
   - `preview/transform-box/geometry.ts` defines a `Box`: centre, unrotated size and anticlockwise
     degrees.
   - The pointer maps through the frame element's measured rect (`toProjectPoint`), so a gesture
     is the same at any zoom or panel size.
   - `resizeBox` works in the box's own turned frame. The anchor is the opposite handle, or the
     centre with Alt. Aspect is kept unless Shift is held.
   - It clamps at a minimum size of 10 screen pixels, so a layer never turns inside out.
   - `moveBox` snaps the turned box's extent. `rotateBox` unwraps the angle and steps 15° with
     Shift.
2. **The component owns UI state only.**
   - `TransformBox` holds the pointer, the gesture and the live box, and speaks only in `Box`es.
   - A move waits for a 3 px threshold, so a click stays a click. Handles act from the first
     pixel.
   - Pointer moves are coalesced to one per animation frame. The release commits once.
   - Cursors follow the box's rotation, and the rotate cursor is a custom curved arrow. Arrow keys
     nudge, scale and rotate.
3. **Adapters translate a box into the model.** `preview/transform-box/adapters.ts` maps a gesture
   to what each layer stores:
   - **A picture:** time-0 transform keyframes. A uniform resize writes `scale`; a Shift resize
     writes `scaleX`/`scaleY`; the centre's travel writes `x`/`y`.
   - **A text overlay:** a corner scales the font size and wrap width together, a side reflows
     the wrap width, and Shift stretches the letters through the clip transform.
   - **A box shape:** its params plus rotation.

   The model never learns about pointers, and the component never learns about keyframes.

4. **Non-uniform stretch is in the transform model.** `scaleX`/`scaleY` keyframes multiply the
   uniform `scale` (identity 1), about the centre and before rotation, in the export, the frame
   plan and both monitors. This is what makes Shift-resize real rather than a preview trick, and
   it supersedes `PreviewTransform`'s "uniform scale only" rule, which existed because the render
   could not stretch.
5. **The chrome draws in its own layer.** `TransformChromeLayer` is an unclipped, unscaled sibling
   of the frame, kept on the frame's on-screen rect as it zooms, pans and resizes. The box portals
   into it (`TransformChromeContext`). Handles reach past the frame's edge and stay 1.5 px / 8 px at
   any zoom.
6. **Controls outside the box go where there is room.** A full-frame layer leaves no room above
   it, and the monitor stage clips what would sit there. So the box measures the room its clipping
   ancestors leave along its own turned axis (`outsideRoom`), and places the controls to match:
   - The lollipop sits above the box, else below it, else just inside the top edge.
   - The size readout sits below the box, else inside its bottom edge.

   The placement is re-measured only between gestures, so a control never jumps under the
   pointer.

7. **Live and committed use one path.** While dragging, the desktop monitor previews through the
   layer engine's coalesced live-present path with the edit applied to a scratch timeline. The
   release applies ONE patch: `combinePatches` joins a text overlay's params edit and its
   transform edit, so one gesture is one undo step.

## Consequences

- `PreviewTransform` and its CSS are deleted. Pictures, stickers, text overlays and box shapes use
  one control. Segment shapes (lines, arrows) keep their end handles, now stretch-aware.
- The browser monitor now draws a clip's rotation and stretch.
- Clips that were never stretched gain no identity `scaleX`/`scaleY` keyframes: pose recording
  and the box write stretch only for a clip that is stretched or already carries it.
- e2e selectors moved to the box's accessible names: the group `Transform selected clip`, the
  slider `Resize handle se`, and `Rotate clip`.
