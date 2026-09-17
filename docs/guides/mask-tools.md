# Masking tools

How to draw and edit masks by hand, and where each piece lives (MK4). The preview side (how the
monitor rasterises the stack) is in [preview-masks.md](./preview-masks.md); decisions are in ADR 0178.

## Using them

Select a video or image clip, open **Inspector → Mask**. While that tab is open the program monitor
shows the mask toolbar and draws the clip's masks over the picture.

| Tool      | Key | Mouse                                                                                                             | Keyboard (focus the monitor canvas)                                                                     |
| --------- | --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Selection | V   | drag a mask to move it; drag points and tangents; click an edge to add a point; drag empty space to select points | arrows nudge 1 px, Shift+arrows 10 px; `[` `]` step through points; Delete removes points (or the mask) |
| Rectangle | R   | drag; Shift for a square, Alt from the centre                                                                     | Space sets a corner, arrows move, Space again draws                                                     |
| Ellipse   | E   | as Rectangle                                                                                                      | as Rectangle                                                                                            |
| Pen       | P   | click for corners, drag for smooth tangents, Shift for 45° segments, click the first point or Enter to close      | Space adds a point at the crosshair, Enter closes, Escape cancels                                       |
| Freehand  | F   | draw a closed stroke; it is fitted to a smooth path                                                               | —                                                                                                       |

On the selected mask: the transform box scales (Shift keeps the aspect, Alt from the centre) and
its top handle rotates (Shift in 15° steps); Alt on a tangent breaks a smooth pair; Cmd/Ctrl-click
a point converts corner ↔ smooth. The three knobs to the right of the shape set expansion, outer
feather and inner feather, with dashed guides at those distances. Snapping (toolbar magnet, Alt
inverts it) pulls to the picture's edges, centre and crop and to other masks' points. Zoom goes to
100–800% of source pixels, with a pixel grid from 400%; drag with Space held, the middle button or
the wheel to pan.

The Inspector lists the stack top first (drag or Alt+↑/↓ to reorder; colour, blend mode, invert,
visibility, lock, delete) and, for the selected mask, what it limits (the clip or one effect),
opacity, expansion, feathers, falloff and typed pixel geometry. Every animatable field has a
keyframe diamond with previous/next. **Apply to all keyframes** makes an edit shift that property
on every keyframe instead of keying the playhead. Copy/paste and duplicate masks, and save masks as
project presets, from the same tab. Animated masks get one lane each in the clip's keyframe lanes;
drag a marker to retime every keyframe at that instant.

Every gesture, field edit and lane drag is one undo step: a drag previews live and commits once on
release.

## Where things live

| Piece                                    | File                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Commands (shared with the agent)         | `packages/editor-core/src/mask-commands.ts` ([API](../api/mask-commands.md))                                                 |
| Gesture geometry, freehand fitting       | `packages/editor-core/src/mask-path-editing.ts`, `mask-curve-fit.ts`                                                         |
| Monitor overlay and toolbar              | `apps/web-editor/src/components/preview/MaskCanvasTools.tsx`                                                                 |
| Source px ↔ monitor mapping              | `apps/web-editor/src/components/preview/mask-monitor-space.ts` (from the frame plan)                                         |
| Shared tool state (selection, live drag) | `apps/web-editor/src/components/inspector/masks/useMaskTools.ts`                                                             |
| Inspector tab                            | `apps/web-editor/src/components/inspector/masks/` (`MaskPanel`, `MaskList`, `MaskProperties`, `MaskPresets`, `MaskTracking`) |
| Timeline lanes                           | `apps/web-editor/src/components/timeline/MaskKeyframeLane.tsx`                                                               |
| Flag                                     | `VITE_FRAMEPILOT_MASK_TOOLS` (`preview/mask-tools-flag.ts`): on in dev/test, off in production until RD3                     |

## Budgets (plan 06)

Pointer-to-paint is recorded by the monitor itself (`mask-tool-telemetry.ts`,
`window.__fpMaskToolTelemetry`), from the pointer event to the animation frame after the overlay
commit. The composited mask preview is re-rastered asynchronously, latest wins, and recorded as a
separate `composite` channel. Save time and file size are asserted by
`packages/timeline-schema/src/save-budget.perf.test.ts`. Numbers:
`plan/background-removal-ai/MK4-BUDGETS.md`.

Long path keyframe arrays (64+ vertices) are written to `project.fp.json` as `f64le:<base64>` (the
exact float64 bytes) instead of decimals; see ADR 0178's MK4 amendment.
