# Inspector Panel

The web editor inspector is a registry-driven property surface. It presents only the sections that can act on the current selection and keeps all edits on FramePilot's typed, validated, reversible patch path.

## Visual contract

The inspector uses one shared structure across every property type:

1. A sticky header identifies the surface and keeps copy, paste, apply, and reset actions available while scrolling.
2. A compact context card identifies the primary clip, track, timeline span, and source span.
3. Every property family appears as an icon-led disclosure card with persisted open or collapsed state.
4. Property rows share one label axis, control density, focus treatment, mixed-value behavior, and reset placement.
5. Narrow rails collapse metadata into a vertical layout and allow the action toolbar to wrap without clipping.

## Selection behavior

- A single clip shows the sections supported by that clip and track.
- A multi-selection edits the primary clip while whole-selection actions apply through one patch.
- Mixed values remain visible and editable.
- An effect-layer selection takes precedence over clip selection and opens the dedicated effect inspector.
- An empty selection shows a focused editor hint instead of inactive controls.

## Shapes

A selected shape (Elements → Shapes) gets a **Shape** section on the Basic tab: fill and stroke
on or off with colour and opacity, stroke width and style, its corners or arrow head, the caps of
a line's ends, and its box or ends. Adjust, Speed, Crop, Mask and Applied effects are not offered
for a shape: the export draws it from those settings alone, and they would do nothing to it.

## Stickers

A selected sticker (Elements → Stickers) gets a **Sticker** section: its picture and name, where it
comes from, and **Replace…**, which opens the Stickers tab to swap it for another while its
timing, position, size and animation stay. Its place, size and turn are the ordinary **Position &
size** section, as for a photo.

## Animation

A sticker, shape, title or picture on a graphics layer gets an **Animation** section on the Basic
tab: **In** and **Out** (a preset and a length each) and **Loop** (a preset, its speed and its
amount), each change one undo. "Animation…" on the clip's right-click menu opens it. A loop set
before the clip was lengthened offers **Re-apply**. A title's In and Out live here, not on the Text
tab. The Transition section does not show a graphic's own entrance, which this section edits.
See [Elements](./elements.md#animation-in-out-and-loop).

## Extension rules

New inspector sections belong in `components/inspector/registry.ts` and should use the shared `InspectorSection`, `InspectorRow`, `LabeledSelect`, and existing patch builders. Keep section ids stable because disclosure preferences are persisted by id. New controls must retain explicit accessible names and must never mutate timeline data directly.
