# AI masking tools

The `masking` tool domain lets the agent do what an editor does in the Inspector's Mask tab,
from a plain request: "blur her face", "remove the background", "put the title behind him",
"darken everything but the presenter". Spec:
[`plan/background-removal-ai/11-AI-MASKING.md`](../../plan/background-removal-ai/11-AI-MASKING.md).
Gates: [`06`](../../plan/background-removal-ai/06-PRECISION-AND-EVAL.md#ai-masking).

**Why it is built this way.** A mask the model places by guessing coordinates is wrong in a way
nobody notices until export, and a confident mask on the wrong person is the worst failure this
feature has. So the model never supplies a coordinate and never settles a tie:

1. **The model picks which and why; code makes the shape.** Every vertex, box and track comes from
   a detection, a segmentation, a track, the picture frame, or a number the editor typed.
2. **Resolve the target or ask.** Anything the resolver cannot settle goes to the editor.
3. **Same operations, same packs, same review list** as the manual path. The agent reports how
   many moments need a look and never says _verified_.
4. **Packs are consent.** A missing pack comes back as the signed install offer.

Desktop only. The tools are `hostUiOnly`: they run in Capability Pack workers and compile through
editor-core's TypeScript mask commands, so the Python sidecar does not mirror them and the
standalone MCP server does not serve them. The browser build declares the measured ones
unroutable, so they are never advertised there.

## Tools

| Tool                      | Kind               | What it does                                                                      | Compiles to                                                                                                     |
| ------------------------- | ------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `find_mask_targets`       | host-measured read | Ranked candidates for a description on one clip, and a status                     | —                                                                                                               |
| `create_mask`             | host-measured edit | Cut-out (matte) or fitted shape from one candidate; purpose, edge, optional track | `add_matte_mask` / `draw_mask`, `set_mask_properties`, `set_mask_target`, `apply_color_grade`, `set_mask_track` |
| `remove_background`       | host-measured edit | `create_mask` preset: main subject (or a candidate), cut-out                      | `add_matte_mask`                                                                                                |
| `track_mask`              | host-measured edit | Track an existing rectangle, ellipse or path                                      | `set_mask_track`                                                                                                |
| `refine_mask`             | in-process edit    | `edge`, `grow` (one step), `mode`, `invert` — by intent                           | `set_mask_properties`                                                                                           |
| `put_text_behind_subject` | in-process edit    | Title between subject and background; needs a matte first                         | `text_behind_subject`                                                                                           |
| `get_masks`               | read               | id, kind, what it limits, tracked, review state, flagged count                    | —                                                                                                               |
| `delete_mask`             | in-process edit    | Remove one mask                                                                   | `remove_mask`                                                                                                   |

Every edit goes through `compileMaskCommand`, the entry point the monitor tools and the Inspector
use, so an agent mask gets the same id, name, colour, validation and undo as a drawn one. A tool
call is one patch: `MaskCommandChain` compiles commands in sequence against a timeline that
advances after each.

**Host-measured** tools follow `track_subject_automatically`'s split. The model states an
objective; `apps/desktop/electron/ai/masking-executor.ts` measures in a pack worker; the
orchestrator validates the payload against `masking/contracts.ts` and builds the operations
(`maskingOpsFromMeasurement`). A payload that fails its schema, or answers a different clip or
candidate, is refused — never substituted.

## Intent, not numbers

`masking/intent-tables.ts` maps what the model says to numbers, scaled by the picture's smaller
side so 4K and 720p get the same look.

| Argument  | Values                             | Becomes                                                                               |
| --------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| `edge`    | `exact`, `soft`, `very_soft`       | Shape: outer feather 0 / 1% / 3%. Matte: `sharp` / `smooth` / `smooth` + finesse blur |
| `grow`    | `tighter`, `looser`                | ∓1% per call, on `expansionPx` (shape) or `edgeShiftPx` (matte)                       |
| `purpose` | `cutout`, `hide`, `effect`         | `hide` inverts and, for a shape, adds a 1.5% margin; `effect` retargets the mask      |
| `effect`  | `brighten`, `darken`, `desaturate` | A clip `color_grade` with fixed offsets, limited by the mask                          |

`blur_to_hide` and `grade_match_to` are accepted and **refused with a remedy**. A clip's picture
effects are `color_grade` and `lut` only (`render/frame_plan.py#picture_effects`); blur exists
only on an adjustment lane, whose masks are frame-space and cannot follow a track. A face blur
that slides off the face is a privacy failure, so there is no approximate version. A second
grade on a clip that already has one is refused for the same kind of reason: only one renders.

Shapes come from `masking/shape-fit.ts`: rectangle and ellipse from a box; bounding rectangle and
moment ellipse (it follows a lean) from a bitmap; and a closed Bezier path around the bitmap's
largest region within a vertex budget, by doubling the curve-fit tolerance until it fits.

## The geometry rule is enforced, not asked for

`masking/geometry-provenance.ts`. Builders that derive a shape from a source **attest** the
operations they produce (`candidate`, `measurement`, `frame`, `user_numbers`). `operationsForCall`
— the boundary the agent loop, the autonomous proposal compiler and the MCP session all cross —
refuses any `add_mask`, `add_effect_layer_mask`, `set_mask_path`, `paste_masks`,
`apply_mask_tracking`, or geometry-bearing `update_mask` / `add_mask_keyframe` nobody attested. The
two host-measured branches in the orchestrator run the same check. A new tool that passes the
model's numbers to a mask therefore fails closed without being added to a list. The attestation
is keyed on the operation object, so identical numbers built elsewhere are still unsourced.

`userShape` is the one argument that carries a box. It is admitted only when every number in it
appears in the editor's own request, as written or as a percentage (`ToolContext.userNumbers`).

## Jobs the agent may not start

Background removal is measured at hundreds of compute-seconds per footage-second on the CPU
provider (`packages/shared-types/src/matte-estimate.ts`, shared with the Inspector's estimate).
The Inspector asks before a job over ten minutes; the agent gets no way round that question. A
cut-out over the threshold returns `needs_editor_start` with the exact intent, and the sidebar's
`MatteStartInlineCard` starts the Inspector's own job — same store, jobs panel, `add_matte_mask`
commit and review list. On today's CPU numbers that is nearly every real clip; the threshold is
the Inspector's, so it moves when measured throughput does.

Two other panel policies are deliberately not the agent's. The executor hands the pack services
the **run's working project**, not the file on disk (the panel re-reads disk because a renderer
is not an authority; the saved revision would refuse every agent job as stale, and a mask being
tracked may exist only in the patch under construction). And the mask-track job itself is shared:
`capability-packs/mask-track-service.ts` is called by both the IPC handler and the executor.

## Failures

Every sentence the executor authors names the next move and carries no varying number, because a
refusal's text is the repeated-failure guard's key. `maskingFailureNoteEntries()` is walked by
the desktop failure-quality gate. `pack_missing` (Smart Mask, Tracking Lite, Subject Intelligence)
carries the signed proposal to `PackInstallInlineCard`.

## Not built

- `refine_mask` `add` / `remove` candidate (a matte re-run with include/exclude prompts).
- `blur_to_hide`, `grade_match_to` (no renderer; see above).
- MCP and Python mirrors (by design, see the top of this page).
