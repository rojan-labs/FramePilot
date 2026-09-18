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

## Target resolution

`find_mask_targets` answers "what does the editor mean?" with a ranked candidate list and one of
five statuses. The measuring is the host's (`masking-executor.ts`); everything that DECIDES is
pure and lives in `masking/target-resolution.ts`, where it is tested against the gates: ≥ 99% on
unambiguous requests, ≥ 97% asks on ambiguous ones, and **a confident wrong pick counts as a
failure, not an ask** — so every tie, every unverifiable class and every identity question asks.

| Status                 | When                                                                                                                         | What happens next                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `resolved`             | One candidate (or, for "all the faces", every one) is decisively meant                                                       | Pass `chosenCandidateIds` to `create_mask`              |
| `ambiguous_target`     | Several match and nothing separates them; a selector or re-ranker margin is thin; or an object's class cannot be vouched for | The editor picks in the sidebar                         |
| `needs_click`          | The target is outside the detector's vocabulary ("the sky", "the sign", a licence plate)                                     | The editor clicks it once; matte precision is identical |
| `needs_face_selection` | WHO matters ("everyone except the host")                                                                                     | The editor picks faces                                  |
| `no_candidates`        | Nothing of that class is on screen                                                                                           | The agent says so; it never offers something else       |

**How it ranks.** Detections are grouped into things that persist (greedy IoU across frames);
flicker seen on under 15% of the sampled frames is dropped. `score = grounding × agreement ×
persistence`, where grounding is the re-ranker's similarity when there is one and the detector's
confidence otherwise, agreement demotes (never removes) a candidate the shot ledger's
`subjectKind` disagrees with, and persistence is the share of sampled frames it was seen on. A
long clip is sampled in three 48-frame windows rather than detected on every frame.

**The score only ranks.** A decision needs one of: a single candidate of a class the detector can
vouch for; a positional selector ("on the left") whose winner leads by a tenth of the frame; a
size selector ("the main subject") whose winner is 1.5× the runner-up; or a re-ranker whose best
match is plausible (≥ 0.5) and 1.25× the runner-up.

**No text-grounding model** (MD-6). The vocabulary table (`masking/target-vocabulary.ts`) is that
decision written down, including the out-of-vocabulary list that makes "the sky" a designed
`needs_click` rather than a miss.

### Two limits of the shipped packs, and what the resolver does about them

- **Objects have no class.** Subject Intelligence reports every non-person COCO class as the one
  label `object` (`opencv_backend.py`). So "the red car" with one `object` on screen is still
  unverified — it may be a dog — and resolves to `ambiguous_target` with that one thumbnail.
- **SigLIP cannot score a crop.** `visual.embed` embeds a whole keyframe per shot; the worker
  protocol has no crop parameter, so the re-ranking MD-6 names has nothing to call. The executor
  takes a `rerank` evidence source and the resolver uses its margin when one is supplied (tested
  with a fake); the desktop supplies none, and the result says `reranker: "none"`.

Together these mean a described OBJECT always asks today. Faces and people resolve normally. The
unnecessary-asks gate (≤ 3% inside the vocabulary) will therefore fail for objects until the
packs change: either class names on detections, or a crop parameter on `visual.embed`. Both are
signed-pack releases and are not part of this work.

### Candidate ids

An id is a pure function of the measurement — asset, frame, label, and the box quantised to a
thousandth of the picture (`masking/candidate-id.ts`) — e.g. `f48_1a2b3c4d`. The agent log keeps
only the two freshest payloads, so an id used ten turns later must resolve with no payload: the
host re-detects the one frame the id names and reproduces it. Ids survive an app restart for the
same reason.

### Asking the editor

An ask is enforced by the tool, not left to the model's restraint. Every candidate a result lists
that was NOT chosen — every candidate of an ask, and the runners-up of a resolution — carries a
`pick.` prefix, and `create_mask` / `remove_background` accept a `pick.` id only when it appears
in the **editor's own messages** (`ToolContext.userPickedCandidateIds`, read from every user
message of the conversation). The check runs before the host is asked, so a guessed id costs no
pack job.

The sidebar's `MaskTargetPicker` renders on the `find_mask_targets` result itself: thumbnails
cropped in the renderer from the clip's own media (no new IPC, no thumbnail files), the label and
where it sits in frame. Picking sends an ordinary message — `For "the face" on clip shot, use
pick.f48_… (the face at the left).` — through the composer's own `runTurn`, once the run that
asked has ended. `needs_face_selection` collects several faces before sending; `needs_click`
points at the Inspector's Remove background subject tool.

What the model can recall later is deliberately narrow. The digest's FIRST line carries the
chosen id, because the state briefing keeps a result's head as the run's durable fact and the
agent log clears payloads after two turns. The evidence store keeps ids, labels and scores for
`recall_evidence` and drops the boxes (`maskTargetsForRecall`): the model never handles
coordinates.

### Identity ("everyone except the host")

WHO someone is cannot be read off a detection, so an identity request always resolves to
`needs_face_selection` and the editor picks the faces (several, then **Use selected**).

Recognising the same person across shots is biometric processing (plan 12 P15, MD-7), so:

- **Opt-in, per project, off by default.** The face picker shows the consent line where the
  question arises, not buried in settings. The state is a human-provenance field in the project
  brain (`fields`: `project.face_recognition_consent`); no model write can set it.
- **Local only.** Nothing about identity leaves the machine.
- **Deletable in one action.** "Delete identity data" removes every `person` row of the brain's
  `entities` table (the only face-derived vectors it keeps), the `person` refs on every shot, and
  `people` in every asset digest — in one transaction — and withdraws consent with them. Face
  counts and every other fact stay: "two faces" says nothing about who.
- **Unreadable is no consent.** `IdentityClient` returns `consent: false` for a timeout, a down
  engine or a malformed body; the executor reads it on every resolution and treats a rejected
  read as no consent.

Engine routes: `GET /brain/identity?projectId=`, `POST /brain/identity/consent`
`{projectId, consent}`, `POST /brain/identity/delete` `{projectId}`.

Two honest limits. The desktop supplies no identity source for the resolver, because no shipped
capability embeds a DETECTION crop (tier-1 face vectors are per shot and carry no boxes), so
consent does not yet save the editor a pick. And the shot ledger's own tier-1 clustering
(VU5.3, `_cluster_local_entities`) still runs at index time whatever the consent says — it
predates this work and belongs to another subsystem; whether it must also wait for consent is a
maintainer decision. Until then, deletion removes those clusters and a later index pass can
recreate them.

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

## Verification after apply

**Deterministic first (AM3.1).** Every host-measured edit returns a `mask_review` result:

| Field                         | Meaning                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `needsReview`, `flaggedCount` | Source-second ranges the pack or the tracker flagged, plus any the spot check added        |
| `frames`                      | For a cut-out: frames the pack vouched for and flagged                                     |
| `trackConfidence`             | For a track: frames measured, worst model residual in source pixels, flagged count         |
| `validator`                   | `valid` and any non-blocking warnings. An error would have refused the edit                |
| `spotCheck`                   | The one visual look, when it ran: `yes`, `unsure` or `not_run`, with the reason and frames |

There is deliberately no `verified` field. The sentence the model reads states the count and
forbids the word; `get_masks` reports `nothing flagged` / `needs a look`, never verified; and
`claimsMaskVerified(text)` exists so the AM5 eval can audit what the agent SAID for the
"Verification honesty" gate, not only what the tools returned.

**One look, where the numbers cannot decide (AM3.2).** `masking/spot-check.ts` asks the existing
vision-review route a single question — "is the masked region the {label}?" — at no more than
four frames (the middle of each flagged range first, then an even spread), against the project
WITH the mask applied. It runs only when something was flagged or the candidate scored under
0.8, and never when the editor picked the candidate or typed the shape: they said which thing,
and a model disagreeing is not evidence.

| Answer    | What happens                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yes`     | The mask lands. Recorded as a second opinion; it is not a review and the card does not show it as reassurance                                                             |
| `no`      | **The mask is never applied.** The call fails, telling the model to resolve again more specifically or ask the editor, and not to re-apply the same candidate             |
| `unsure`  | The mask lands, and the frames looked at go on its review list (`review_matte` / `review_mask_track`). An untracked shape has no list; the ranges are still in the result |
| `not_run` | No reviewer, a cloud reviewer without media-egress consent, or a cancelled run. A fact about the check, never an opinion about the mask                                   |

It uses the run's own reviewer (`AgentReviewControls.visionReview`, the same objects picture
verification uses), so there is no second reviewer to configure and no frame leaves the machine
without the consent that route already requires.

**The sidebar card (AM3.3).** `MaskReviewCard` renders on a landed `mask_review`: the count, and a
button that opens the Inspector's review list through the same `maskToolStore.requestReview` the
export dialog's "Review" uses. It shows the count whatever the model wrote.

## Kill switch (RD2.1)

`masking/feature-flag.ts`. The same mechanism as the compositor and mask-tools flags: one
variable, `on` or `off`, no flag framework; unset means **on** in development and test and **off**
in a packaged release until RD3 flips the default. A typo falls back to the build default, so it
cannot enable the tools in a release.

| Host                                             | Variable                     | Read                                                                            |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------- |
| Desktop (the orchestrator runs in Electron main) | `FRAMEPILOT_AI_MASKING`      | At runtime, per call — support can switch a shipped build off without a rebuild |
| Browser build                                    | `VITE_FRAMEPILOT_AI_MASKING` | Baked in by Vite                                                                |

Off adds every tool `domain-tools/masking.ts` registers to the host's `unroutableTools`, so no
run is offered them and a call by name is refused by scope. The `load_tools` domain index is
rebuilt from what is actually on offer (`domainIndexFor`), so `masking` stops promising
"remove backgrounds" when no offered tool can; with nothing unroutable the index is byte-identical
and the token goldens do not move. The two tools folded in from `tracking`
(`professional_tracking_mask`, `track_subject_automatically`) are **not** switched — a kill switch
for a new feature must not take an old one with it. Masks already in a project still preview,
export and edit by hand: the flag gates an agent capability, never a frame of output.

## Failures

Every sentence the executor authors names the next move and carries no varying number, because a
refusal's text is the repeated-failure guard's key. `maskingFailureNoteEntries()` is walked by
the desktop failure-quality gate. `pack_missing` (Smart Mask, Tracking Lite, Subject Intelligence)
carries the signed proposal to `PackInstallInlineCard`.

## Not built

- `create_shape_mask` and `mask_with_layer` are **registered unavailable**, deliberately. Their
  mask kinds (`linear`, `band`, `gradient`, `layer`) and the shape-preset path generators are in
  the schema, but neither renderer draws them yet (plan 07 **MK8** is open), so a tool that
  emitted them would make masks the preview and the export ignore. PRD §23: no AI capability
  ahead of its engine. The orchestrator refuses an unavailable tool by name.
- `follow_subject` for a **title or overlay** is refused with a remedy: a clip transform that
  follows a track needs `Clip.transformTrack`, an unapproved schema change (**MO-14**). The mask
  half works.
- `refine_mask` `add` / `remove` candidate (a matte re-run with include/exclude prompts).
- `blur_to_hide`, `grade_match_to` (no renderer; see above).
- MCP and Python mirrors (by design, see the top of this page).
