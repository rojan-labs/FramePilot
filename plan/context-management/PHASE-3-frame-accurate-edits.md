# Phase 3 — The cut lands on the frame it was aimed at — `[x]`

> **Ships:** every edit point on the timeline is a frame, the same frame in preview and in
> export, and the agent can name the frame it wants in the vocabulary an editor uses.
> **Does not ship:** new checks (Phase 4), retrieval (Phase 2), memory (Phase 5).
> **Depends on:** Phase 1 in spirit — a frame grid matters because the model is now precise
> enough to aim at a frame. Technically independent of Phases 1–2.
> **Schema:** **YES.** Requires a migration, an ADR, a `product-scope-reviewer` pass, and
> maintainer approval **before** implementation (`CLAUDE.md` §5). This is why the phase is
> marked `[!]`.

---

## 1. The gap

> **CORRECTION, 2026-08-26.** The paragraph below is wrong, and finding out how wrong is
> most of what P3.1 turned out to be. `packages/ai-sdk/src/frame-time.ts` **was** a
> complete frame grid — rational rates (23.976 → 24000/1001), an explicit rounding policy,
> and a per-operation `normalizeOperationTime` that already knew which fields are edit
> points and which are evidence — wired into `assembleEdit` before patch identity,
> validation, preview and render could disagree. The real gap was narrower and worse: **it
> ran only for edits the AI authored.** A UI patch reaches `applyUserPatch` and is
> validated and committed without ever touching it, so a human trim landed at 12.3874s
> while an AI trim landed on a frame. See ADR 0146. The rest of the section stands: the
> three tolerances are real, and preview/export agreement was never measured.

FramePilot's timeline has no frame grid.

Times are floating-point seconds throughout `packages/timeline-schema` and
`packages/editor-core`. There is no quantization step anywhere — no `snapToFrame`, no
`frameDuration`, no rounding to `1/fps` — at any layer. What exists instead is **three
different tolerances**, each absorbing float noise at a different scale:

| Constant                                   | Value  | Where                                     |
| ------------------------------------------ | ------ | ----------------------------------------- |
| `TIME_EPSILON`                             | `1e-6` | `editor-core/src/timeline-map.ts:54`      |
| `AUDIO_AUTOMATION_TIME_RESOLUTION_SECONDS` | `1e-3` | `editor-core/src/edit-value-contracts.ts` |
| `_CUT_ADJACENCY_TOLERANCE`                 | `1e-3` | `engine/python/…/render/compiler.py:399`  |

The compiler's comment says the quiet part: _"below any real edit boundary while still
absorbing float noise from time quantization."_ There is a tolerance for quantization
noise, but nothing that quantizes.

The consequence. A model asked to cut on the word _"but"_ reads the transcript and returns
`12.3874s`. On a 30 fps timeline that is 0.4 of a frame from any frame boundary. Nothing in
the stack decides which frame it means:

- The **preview** seeks an HTML video element, which lands on the decoder's nearest
  keyframe-relative frame.
- The **export** hands the float to MoviePy, which resolves it its own way.
- Nothing guarantees those two agree, and nothing measures whether they do.

This is `product-discipline.mdc` §2's _preview/export parity_ concern, sitting one layer
below where anyone has looked for it. It is also why "very precise edits" cannot be
delivered by better prompting: there is no frame for the model to be precise _about_.

A professional editor does not think in `12.3874s`. They think _frame 371_, and they think
_two frames before the hand lands_.

---

## P3.1 — A frame grid in the schema — `[x]` **no schema change needed — see below**

**Touches:** `packages/timeline-schema`, `packages/editor-core/src/operations.ts`,
`operation-contract.ts`. **Requires:** ADR + migration + maintainer approval.

The design decision to settle in the ADR, stated as the two honest options:

- **(a) Quantize at the boundary, keep seconds on the wire.** Every operation that sets a
  time snaps it to the project's frame grid inside `apply`, before validation. The schema
  is unchanged; the _contract_ changes. Cheapest, no migration of existing files, and a
  project opened in a different fps re-grids naturally. Costs: two clips authored at
  different fps can still disagree, and "what frame is this" stays a derived answer.
- **(b) Frames are the stored unit.** Times become integer frame counts against
  `project.fps`, with seconds derived. Unambiguous by construction, and it makes every
  downstream check exact. Costs: a real migration of every `project.fp.json`, an fps-change
  operation that must re-map every time, and a wide blast radius across the schema, the
  Python models, and every test fixture.

**Recommendation: (a).** It closes the actual failure — cut points that are not on frames —
without a migration whose risk exceeds the bug's. (b) is the theoretically clean answer and
is worth recording as the deferred alternative with the condition that would trigger it
(variable-frame-rate source support, or a second precision bug that (a) cannot reach).

Either way, the ADR must state which of the three tolerances above survives and why. Three
epsilons and no grid is the condition being ended; three epsilons and a grid is not better.

Whichever is chosen:

- **One quantization function, one home.** `editor-core` owns it; `timeline-schema` states
  the invariant; the Python compiler asserts it rather than re-implementing it. A second
  rounding rule on the Python side is the failure mode to design against — that is exactly
  how preview and export come to disagree.
- **Rounding is specified, not incidental.** Round-half-to-even, or floor, or nearest —
  named in the ADR and identical in both runtimes, with a TS↔Python parity test. The repo
  already has this pattern (`captionStyle.ts` ↔ `captions.py`).
- **Invert stays exact.** Every operation has `apply` and `invert` (`AGENTS.md`). A
  quantized apply must invert to the original state, not to the quantized one, or undo
  drifts. This is the single highest-risk detail in the phase and needs a property test.

---

## P3.2 — The agent can name a frame — `[x]`

**Touches:** `domain-tools/timeline.ts` (`map_time`, `get_mapped_transcript`,
`list_edit_boundaries` descriptors), `orchestrator.ts` (`summarizeReadResult`).
**No schema change.**

Reads report frames alongside seconds, so the model reasons in the unit the timeline
actually has:

- `map_time` returns `{ seconds, frame }` on both directions. It already exists precisely
  so the model does not do the arithmetic itself — _"Use this instead of doing the
  arithmetic; it accounts for trims, speed, and reuse"_ — and a frame number is the natural
  completion of that promise.
- `get_mapped_transcript` reports each word's frame span. Word-accurate captioning is
  frame-accurate captioning or it is neither.
- `list_edit_boundaries` reports each boundary's frame. It already models a cut as a
  **boundary** rather than an effect on a clip (that module's whole reason for existing);
  a boundary has a frame.

**Evidence.** A test that a cut requested at a word boundary lands on the frame
`get_mapped_transcript` reported for that word — the round trip closes.

**Shipped 2026-08-26.** Frames are added at the TOOL layer, where `ctx.project.fps` is
available — `editor-core`'s boundary list stays fps-agnostic, and the model-facing read is
what reports the grid.

- `map_time` returns `sequenceFrame` and `fps` on both pointed shapes, and `fps` on the
  whole map. Both pointed shapes also *gained a digest*: the one call whose entire job is
  "use this instead of doing the arithmetic yourself" was handing its answer back as a JSON
  preview the model had to parse.
- `get_mapped_transcript` reports `startFrame`/`endFrame` per word, and the digest leads
  with them (`f371–f398 (12.367–13.267s) but`).
- `list_edit_boundaries` reports `frame` and `maxTransitionFrames`, and the digest leads
  with the frame — an editor does not think "the cut at 0.5s", they think "the cut on
  frame 15", and a transition's ceiling is a frame count before it is a duration.

`frame-round-trip.test.ts` closes the loop through the real tools and the real patch
authority: the frame `get_mapped_transcript` reports for a word is the frame
`list_edit_boundaries` reports after a split aimed at it — **including when the model asks
in raw off-grid seconds**, which is the realistic case and the one the grid exists for.

---

## P3.3 — The vocabulary of a real cut — `[x]`

**Touches:** `packages/ai-sdk/skills/*.md` (bundled playbooks), tool descriptions.
**No new tools, no schema change.**

With a grid and frame-reporting reads, the craft instructions can finally say something
checkable. Today's playbooks can only advise in seconds, which is why the guidance stays
vague.

- **Cut on action** — the boundary sits on the frame the movement completes, not near it.
- **Cut on the word, not through it** — trims land on `get_mapped_transcript` word
  boundaries; the existing `edit-boundaries` handle logic already knows what footage a
  transition needs to overlap into.
- **Handles** — a dissolve needs frames on both sides. `listEditBoundaries` already
  computes `tailHandle`; state the requirement in frames so the model can check it before
  proposing rather than being rejected after.
- **J and L cuts** — audio leads or trails picture by a stated number of frames. The layer
  model is type-agnostic (ADR 0032) and already supports this; nothing says how.

This is the `editing-skills-expert` agent's territory. Ground every recipe in the real tool
registry and the real engine — a playbook that assumes a capability the tools do not have
is the failure mode that agent exists to prevent.

**Shipped 2026-08-26.** `cut-and-transition-grammar.md` gains a *Frames, not seconds*
section and `silence-and-filler-cutting.md` states its word-edge guard in frames. Every
recipe names a real field of a real read:

- **Cut on action** → the boundary's `frame`, moved with `professional_edit` `roll` and a
  `frames` count (a roll changes where the cut is without changing how long either shot
  runs, which is why it is the right primitive).
- **Cut on the word, not through it** → `startFrame`/`endFrame` from
  `get_mapped_transcript`; a cut strictly inside that span severs the word.
- **J and L cuts** → `professional_edit` `j_cut`/`l_cut`, which already take a positive
  `frames` magnitude. The skill states they need a live selection and the desktop app,
  because they do.
- **Handles — corrected.** The plan asks the skill to state the frames a dissolve needs
  on both sides. **This renderer needs none**: it ramps over the incoming clip's own first
  frames and borrows nothing from past the cut, so a dissolve never fails for want of
  footage (`edit-boundaries.ts` module note). Writing the recipe the plan asked for would
  have been the exact failure the `editing-skills-expert` exists to prevent — a playbook
  assuming a capability the engine does not have. What the handles actually tell you —
  whether the dissolve blends two shots or fades through black — is what the skill says,
  and the real ceiling is `maxTransitionFrames`.

---

## P3.4 — Preview and export agree, and it is measured — `[x]`

**Touches:** `apps/web-editor` preview seek path, `engine/python/…/render/compiler.py`,
a new golden-media test.

An invariant nobody can currently state a number for. Make it one:

- For a project with cuts at known frames, assert the exported file's cut frames match the
  requested frames **exactly** — via `frame_grab.py`, which already exists.
- Assert the preview's seek target for the same cut resolves to the same frame.
- Report the divergence in frames. Target: **0**.

Per `product-discipline.mdc`, a visual claim needs render-backed evidence and a long-form
claim cannot rest on tiny fixtures. Use a real recording of a minute or more at a real
frame rate, not a two-clip fixture.

**Shipped 2026-08-26. Divergence: 0 frames — with one measured exception, recorded rather
than papered over.**

`engine/python/tests/test_render_frame_accuracy.py` exports a two-shot timeline through the
real `export_video` pipeline and probes the exported FILE frame by frame across the cut.
`apps/web-editor/src/editor/preview-frame-parity.test.ts` asks the editor's own picture
selection the same question at the same frame indices. The two legs meet at
`secondsToFrame`, because after ADR 0146 there is exactly one grid.

- **At the delivery rate: 0 frames.** The cut in the file is on exactly the frame the
  editor named, and the preview shows that same shot on that same frame.
- **A resampling preset costs up to +1 output frame, never −1.** `pipeline.render` writes
  `fps=preset.fps or project.fps` and **every shipped preset sets `fps=30`** — so a 24fps
  project exported to Reels is resampled, and its frame boundaries are not boundaries of
  the file that comes out. 24fps frame 113 is 4.708333s, a quarter of the way *into* 30fps
  frame 141; measured, the export places the cut on the next whole output frame (142). A
  30fps container cannot carry a 24fps boundary, so this is a container limit rather than
  a grid failure — and the direction is the safe one: a cut a frame late shows an extra
  frame of the outgoing shot, where a cut a frame early clips the incoming action off its
  own first frame. Pinned by a test so that changing it is a decision.

**Outstanding, and not claimed:** the sources are synthetic (`lavfi` solid colours through
the real compiler and the real encoder). A camera original brings its own container
timebase and B-frames. `product-discipline.mdc` forbids supporting that claim with a
fixture, so it is not made — verifying against a camera file is real remaining work, listed
in `plan/PLAN.md` rather than quietly folded into this checkmark.

---

## Scope gate

- **User outcome.** "Cut right before she says _but_" produces a cut on that word's first
  frame — in the preview the editor is watching, and in the file they export.
- **Current gap.** No frame grid anywhere; three tolerances absorbing quantization noise
  from a stack that never quantizes; preview/export cut-point agreement never measured.
- **Minimum vertical slice.** P3.2 alone — reads report frames — is useful without any
  schema change and de-risks the rest by making the grid's absence visible in run logs
  before anything is migrated.
- **Reuse.** `timeline-map.ts` (built), `edit-boundaries.ts` (built), `map_time` (built),
  `frame_grab.py` (built), the TS↔Python parity-test pattern (established).
- **Deferred.** Variable frame rate source handling. Drop-frame timecode. Sub-frame audio
  editing (audio genuinely is sub-frame; the grid is a _picture_ edit-point grid and the
  ADR must say so). Option (b) above, with its trigger condition recorded.
- **Evidence.** P3.4's rendered before/after on a real recording; the invert property test;
  the TS↔Python quantization parity test; `pnpm verify`.

## What shipped — P3.1, 2026-08-26

**Option (a), and it needed no schema change and no migration** — because the grid already
existed and only had to reach the other authoring path. ADR 0146 records the decision, the
deferred (b) with its trigger, and what is deliberately not quantized.

- The grid moved to `packages/editor-core/src/frame-grid.ts`, unchanged in behaviour;
  `ai-sdk/frame-time.ts` is a re-export so no consumer moved.
- `commitProjectPatch` quantizes the patch **first**, then inverts, applies and records the
  quantized patch. Not inside `applyOperation`: the inverse is computed from the operation,
  so an apply that quantized privately would invert to a different state than it applied
  from — the phase's own highest-risk detail, avoided by construction rather than patched
  afterwards.
- `applyUserPatch` quantizes before validating, so the editor validates the edit it will
  commit. Quantization is idempotent (and returns the same object when nothing moved).
- **Rounding is named:** nearest frame, ties away from zero. Python's built-in `round` is
  banker's rounding and would disagree, so `frame_grid.py` uses `math.floor(x + 0.5)` and a
  test asserts that trap explicitly.
- **The Python engine asserts the grid, never re-implements it.**
  `engine/python/.../render/frame_grid.py` mirrors it, and
  `tests/test_frame_grid_parity.py` reads a fixture generated from the TypeScript source on
  every `editor-core` build — the `captionStyle.ts` ↔ `captions.py` pattern.

**Evidence.** `frame-grid.property.test.ts` over 6 frame rates × 12 seeds × 8 operations:
every applied edit point is on the grid, and undo restores the prior timeline. Two things
the property test found that the plan did not predict:

1. **Bitwise undo equality is not achievable, and asking for it was asking for the wrong
   thing.** A frame at 24fps is 1/24s, which has no exact binary representation; `trim_clip`
   shifts its source window by `newStart - oldStart`, and applying that delta and its
   negation lands one unit in the last place away — ~2e-15s, nine orders of magnitude below
   the smallest tolerance in the stack. The property is stated at `TIME_EPSILON` (1e-6),
   which is what catches drift that ACCUMULATES. This is also why `_CUT_ADJACENCY_TOLERANCE`
   survives the ADR rather than being deleted; its comment now says what it absorbs.
2. **UI transition presets were not frame-aligned and now are.** A "0.25s" fade is 7.5
   frames at 30fps and becomes 8; a 0.75s ramp is 22.5 and becomes 23. Four tests asserted
   the un-gridded figures and were updated with the reason. A ramp that is not a whole
   number of frames is a ramp the preview and the export can disagree about, which is the
   entire point of the phase.

## Why this phase was `[!]`

`CLAUDE.md` §5 requires a pause before _"changing the timeline/project schema (requires a
migration + doc + tests)"_ and before _"large rewrites or cross-cutting architectural
changes"_. P3.1 is both. The gate is:

1. `product-scope-reviewer` pass on this file — expected verdict `PROCEED` on option (a),
   `MAINTAINER DECISION` on option (b).
2. Maintainer chooses (a) or (b), recorded in the ADR.
3. ADR written and accepted before the first line of P3.1.

P3.2 and P3.3 need none of that and can proceed while the gate is open.

## Risks

| Risk                                       | Mitigation                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quantization breaks undo                   | The highest-risk detail in the phase. Invert must restore the pre-quantization state; property test over random op sequences, alongside the existing `operation-algebra.property.test.ts`. |
| TS and Python round differently            | One named rule, one parity test, Python asserts rather than re-implements. Precedent: `captionStyle.ts` ↔ `captions.py`.                                                                   |
| Existing projects shift by a frame on open | Option (a) has no migration; a project re-grids on the next edit, not on open. Option (b) does have one, which is a large part of why (a) is recommended.                                  |
| Scope creep into timecode/VFR              | Explicitly deferred above with a stated trigger.                                                                                                                                           |
