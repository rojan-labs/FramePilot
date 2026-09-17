# Mask commands

`compileMaskCommand` (`packages/editor-core/src/mask-commands.ts`) turns an editing intent on a
clip's mask stack into ONE validated, reversible patch. The monitor mask tools, the Inspector mask
panel, the timeline mask lanes and the agent's `add_mask` tool all compile these commands, so a
hand edit and an agent edit with the same intent produce the same operations (MK4.4). The web
editor's only entry point is `runMaskCommand(editor, command)` (`apps/web-editor/src/editor/mask-editing.ts`),
which stamps the timeline revision and commits through `applyPatchChecked`.

Every command carries `timelineRevision` and `clipId`, and optionally `createdBy`. Geometry is in
display-corrected source pixels and `sourceTime` in asset source seconds (ADR 0178).

| Command                                                             | Fields                                                       | Compiles to                                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draw_mask`                                                         | `geometry`, `sourceTime`, `name?`, `atTop?`                  | `add_mask` with the next free id, `Mask N` name and an unused overlay colour; a path's first keyframe sits at `sourceTime`                                                         |
| `set_mask_geometry`                                                 | `maskId`, `sourceTime`, `geometry`                           | rect/ellipse: `update_mask` for unanimated fields, a keyframe at the instant for animated ones; path: `set_mask_path` (replace the only shape, or key the instant)                 |
| `set_mask_properties`                                               | `maskId`, `sourceTime`, `changes`, `allKeyframes?`           | settings and unanimated scalars in one `update_mask`; animated scalars keyed at the instant, or with `allKeyframes` one `update_mask` whose `keyframeOffsets` shift every keyframe |
| `toggle_mask_keyframe`                                              | `maskId`, `property` (scalar or `path`), `sourceTime`        | add a keyframe with the current value, or remove the one at the instant (the last one leaving writes its value back as static)                                                     |
| `insert_mask_vertex`                                                | `maskId`, `segment`, `t`                                     | `insert_mask_vertex` (every path keyframe)                                                                                                                                         |
| `remove_mask_vertices`                                              | `maskId`, `vertices`                                         | `remove_mask_vertex` per point, highest first; refused below three points                                                                                                          |
| `move_mask_keyframes`                                               | `maskId`, `keyframeIds`, `deltaSeconds`                      | `move_mask_keyframe` per keyframe, in the direction of travel                                                                                                                      |
| `remove_mask`, `reorder_masks`, `set_mask_target`, `duplicate_mask` | as named                                                     | the operation of the same name (`duplicate_mask` → `add_mask` of a renamed copy below the original)                                                                                |
| `paste_masks`                                                       | `clipboard` (`assetId`, source size, `sourceStart`, `masks`) | `paste_masks`, rescaled to the clip's picture                                                                                                                                      |
| `save_mask_preset`                                                  | `name`, `maskIds`                                            | `save_mask_preset` (schema v23 `Timeline.maskPresets`); mattes are never saved                                                                                                     |
| `apply_mask_preset`                                                 | `presetId`                                                   | `paste_masks` from the preset                                                                                                                                                      |
| `remove_mask_preset`                                                | `presetId`                                                   | `remove_mask_preset`                                                                                                                                                               |

Rejections: `stale_timeline`, `missing_clip`, `missing_mask`, `needs_media_dimensions`,
`not_editable`, `too_few_vertices`, `nothing_to_change`, `invalid_patch` (validator message). The
web runner treats `nothing_to_change` (a click that moved nothing) as silent success.

## Geometry helpers

`mask-path-editing.ts` holds the pure gesture math (nearest point on a path, vertex/tangent hit
tests, smooth tangent mirroring, corner ↔ smooth conversion, 45° constraint, drag boxes, marquee,
snapping). `mask-curve-fit.ts` fits a closed freehand stroke with Schneider's algorithm.
`maskGeometryAt` / `maskPathVerticesAt` read a mask's shape at a source instant.
