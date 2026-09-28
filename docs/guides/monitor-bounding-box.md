# The bounding box on the monitor

Select a clip, a still, a sticker, a box shape or a text overlay, on the timeline or by clicking it
on the program monitor, and it gets a bounding box: a thin blue frame with eight handles and a
rotation lollipop. The box is the same for every kind of layer
([ADR 0195](../adr/0195-one-bounding-box-for-every-layer.md)).

## Gestures

| Do this                                     | To                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Drag inside the box                         | Move it. A 3 px dead zone keeps a click a click. **Shift** locks the axis. **Alt** flips snapping for this drag (snapping is on by default). |
| Drag a corner handle                        | Resize it, keeping its proportions. **Shift** stretches it freely. **Alt** resizes about the centre.                                         |
| Drag an edge handle                         | Resize it along one side (proportions kept, as on a corner). **Shift** stretches that axis only.                                             |
| Drag the lollipop, or just outside a corner | Rotate it about its centre. **Shift** steps 15°.                                                                                             |
| Arrow keys on the focused box               | Nudge it 1 px. **Shift** nudges 10 px.                                                                                                       |
| Arrow keys on a focused corner              | Scale it 1%. **Shift** scales 10%.                                                                                                           |
| Arrow keys on the focused lollipop          | Rotate it 1°. **Shift** rotates 15°.                                                                                                         |
| The ↺ button beside the box                 | Reset the clip's transform.                                                                                                                  |

A layer can't be turned inside out: past the opposite handle it stops at 10 screen pixels. While
you drag, a readout shows the size or the angle, and the cursors turn with the box.

On a full-frame clip there's no room above the box, so the lollipop sits below it, or just inside
its top edge.

The box works the same at any monitor zoom. Its lines and handles stay the same size on screen,
and they reach past the frame's edge.

## What each layer stores

| Layer                  | Move                               | Resize                                                              | Shift-resize                                     | Rotate                |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ | --------------------- |
| Clip, still or sticker | `x`/`y` keyframes                  | `scale`                                                             | `scaleX`/`scaleY` (stretch)                      | `rotation`            |
| Text overlay           | its centre (`xPercent`/`yPercent`) | a corner: font size and wrap width; a side: the wrap width (reflow) | the clip's `scaleX`/`scaleY` (stretched letters) | the clip's `rotation` |
| Box shape              | its params                         | its size                                                            | its size, freely                                 | `rotation`            |

Every drag is **one** undo step, even when it changed both a text overlay's params and its clip
transform. Transform keyframes are written at time 0. A clip that already animates keeps its
other keyframes.

## Text overlays

Double-click a text overlay's box to type into it. While you type, the box is dashed and its
handles are gone. **Enter** or clicking away commits the edit, **Escape** cancels it, and
**Shift+Enter** adds a new line.

## Where it lives

- `apps/web-editor/src/preview/transform-box/geometry.ts` holds the pure math (`toProjectPoint`,
  `moveBox`, `resizeBox`, `rotateBox`, `resizeCursor`, `outsideRoom`).
- `apps/web-editor/src/preview/transform-box/adapters.ts` translates a box into each layer's
  model. `monitor.ts` holds the program monitor's side: the box from the frame plan, the live
  timeline, and `combinePatches`.
- `apps/web-editor/src/components/transform-box/TransformBox.tsx` is the UI component.
  `TransformChrome.tsx` is the unclipped layer it draws in.
