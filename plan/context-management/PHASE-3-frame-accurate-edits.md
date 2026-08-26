# Phase 3 — The cut lands on the frame it was aimed at — `[!]` blocked on maintainer approval

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

## P3.1 — A frame grid in the schema — `[ ]` **schema change**

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

## P3.2 — The agent can name a frame — `[ ]`

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

---

## P3.3 — The vocabulary of a real cut — `[ ]`

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

---

## P3.4 — Preview and export agree, and it is measured — `[ ]`

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

## Why this phase is `[!]`

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
