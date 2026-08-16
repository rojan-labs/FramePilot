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

## Extension rules

New inspector sections belong in `components/inspector/registry.ts` and should use the shared `InspectorSection`, `InspectorRow`, `LabeledSelect`, and existing patch builders. Keep section ids stable because disclosure preferences are persisted by id. New controls must retain explicit accessible names and must never mutate timeline data directly.
