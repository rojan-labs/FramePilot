# Masking tools

How to draw and edit masks by hand, and where each piece lives (MK4). The preview side (how the
monitor rasterises the stack) is in [preview-masks.md](./preview-masks.md); decisions are in ADR 0178.

## Using them

Select a video or image clip, open **Inspector → Mask**. While that tab is open the program monitor
shows the mask toolbar and draws the clip's masks over the picture.

| Tool      | Key | Mouse                                                                                                                                                                       | Keyboard (focus the monitor canvas)                                                                     |
| --------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Selection | V   | drag a mask to move it; drag points and tangents; click an edge to add a point; drag empty space to select points                                                           | arrows nudge 1 px, Shift+arrows 10 px; `[` `]` step through points; Delete removes points (or the mask) |
| Rectangle | R   | drag; Shift for a square, Alt from the centre                                                                                                                               | Space sets a corner, arrows move, Space again draws                                                     |
| Ellipse   | E   | as Rectangle                                                                                                                                                                | as Rectangle                                                                                            |
| Pen       | P   | click for corners, drag for smooth tangents, Shift for 45° segments, click the first point or Enter to close                                                                | Space adds a point at the crosshair, Enter closes, Escape cancels                                       |
| Freehand  | F   | draw a closed stroke; it is fitted to a smooth path                                                                                                                         | —                                                                                                       |
| Split     | S   | press where the line goes and drag along it (a click lays it level; Shift in 15° steps)                                                                                     | Space sets the start, arrows move, Space again places                                                   |
| Mirror    | M   | as Split; the band starts a quarter of the picture's smaller side wide                                                                                                      | as Split                                                                                                |
| Gradient  | G   | drag from where it is opaque to where it is clear; Alt-drag for a radial gradient                                                                                           | as Split (Alt with the second Space for radial)                                                         |
| Shapes    | H   | pick Heart, Star, Polygon, Speech bubble, Arrow or Rounded frame beside the toolbar (points/sides for star and polygon), then drag a box; Shift square, Alt from the centre | as Rectangle                                                                                            |

On the selected mask: the transform box scales (Shift keeps the aspect, Alt from the centre) and
its top handle rotates (Shift in 15° steps); Alt on a tangent breaks a smooth pair; Cmd/Ctrl-click
a point converts corner ↔ smooth. The three knobs to the right of the shape set expansion, outer
feather and inner feather, with dashed guides at those distances. Snapping (toolbar magnet, Alt
inverts it) pulls to the picture's edges, centre and crop and to other masks' points. Zoom goes to
100–800% of source pixels, with a pixel grid from 400%; drag with Space held, the middle button or
the wheel to pan.

A split, mirror band or gradient (MK8.1) has no box. Selected, a split shows a round handle on the
line (move), a square one along it (angle, Shift in 15° steps) and a knob on the cut-away side
(softness, with dashed bounds); a band adds square handles on both edges (width); a gradient shows
its start and end (drag either, or the axis to move both). Click a line to select its mask; arrows
nudge it; Delete removes it. The Inspector types the same fields in pixels and degrees, and a
gradient's Shape (linear/radial) and Curve.

A shape preset (MK8.3) is not a mask kind: it inserts ordinary path masks
(`packages/editor-core/src/mask-shape-presets.ts`) that are edited, keyframed and tracked like any
drawn path. A rounded frame is two paths, the outer one added and the inner one subtracted,
because one path with a hole would need a bridge the feather would show.

**Track matte / text as a mask (MK8.2).** In the Mask tab, **Track matte** lists the clips on other
video tracks that play while this one does (a title shows as its text) and each whole video track;
pick one and a channel (Alpha, Luma, or either inverted) and **Use as mask**. The source then stops
being drawn: it is this clip's matte — "video inside text" is a title above a clip, used as the
clip's Alpha matte. The selected track matte shows its source and channel, and Shrink/grow, Soften,
Clean black/white and Denoise instead of expansion and feathers (its edge is its source's).

**Limiting an effect.** A mask can limit one of the clip's effects instead of cutting the clip: a
grade, a LUT, or the clip **blur** (Inspector → **Effects** → **Add blur**; its strength is a share
of the picture's smaller side, 4% by default). **Add mask** on an effect's row arms the drawing
tool for that effect. A blur limited to a tracked mask is a face or plate blur that stays put
(`editor-core/clip-blur.ts`, `render/clip_blur.py`).

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

## Keying a colour (MK6.1)

A `key` mask has no shape to draw, so its tools live in the Inspector's Mask tab instead of on the
monitor toolbar: a model (hue/saturation/luma, RGB channels, luma, or sampled colours), a range
per channel with its own softness, despill, and shadow retention.

**Eyedropper.** Pressing it arms the monitor; the next click on the picture samples that pixel and
turns it into a key. What the sample becomes depends on the model — a `3d` key collects the colour
itself, a range model gets ranges centred on it, wide enough to be a starting point. **Shift-click
adds** a colour rather than replacing: a backing with a hot spot and a shadow is keyable in three
clicks, and adding widens the existing range rather than stacking a second one on the same channel
(two ranges on one channel would intersect, which is the opposite of "also include this").

The alpha is **how much the pixel matches**, like every other kind's alpha is "inside the shape".
To cut a subject out of a green screen, select the green and switch the mask's Invert on — the same
control a shape mask uses.
