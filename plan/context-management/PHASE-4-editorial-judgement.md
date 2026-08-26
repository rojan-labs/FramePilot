# Phase 4 — The agent reviews its own cut the way an editor does — `[x]`

> **Ships:** the critic checks continuity and craft, not just arithmetic — and the repair
> pass can actually fix what it finds.
> **Does not ship:** new editing capabilities. Every check must be fixable with a tool that
> already exists, or be honestly gated.
> **Depends on:** Phase 3 (continuity checks measure distances between cut points; without
> a frame grid those distances are float noise and the checks fire on rounding) and
> Phase 1 (a check on material the model cannot see is a check on nothing).
> **Schema/deps:** none.

---

## 1. The gap

`packages/ai-sdk/src/critic.ts` is a real self-review pass with fourteen checks:

```
audio_clipping · black_frames · caption_alignment · color_grade · crop
duration_target · export_settings · missing_assets · picture_present
reframe_coverage · request_match · safe_area · shot_count · speed
temporal_evidence · treatment_coverage · vision_review
```

Read that list as an editor. Every one of them answers _"is the deliverable well-formed?"_
— the right length, the right aspect, no missing media, no clipping, nothing black. Not one
of them answers _"is this a good cut?"_

The checks a professional editor actually runs on a first pass are absent:

- Is that a **jump cut**?
- Does the audio **breathe** across the cut, or does it slam?
- Is there **dead air** at the head or the tail?
- Did I cut **through a word**?
- Do the shot lengths have a **rhythm**, or is everything 4.2 seconds?
- Did I cut **on the action** or a beat late?

And only three checks are repairable at all: `FIXABLE_CHECKS = { duration_target,
request_match, audio_clipping }` (`orchestrator.ts`). The rest report and stop.

The structure to extend is already right — checks are typed by `CheckId`, they carry
`pass | warn | fail | skipped`, render-gated ones are honestly excluded rather than
stubbed. Phase 4 adds the editorial ones.

---

## P4.1 — Continuity checks — `[x]`

**Touches:** `packages/ai-sdk/src/critic.ts`.
**Reads from:** `editor-core/src/edit-boundaries.ts` (built),
`kernel/semantic-index` (built), `get_mapped_transcript` (built).

Every check below must be computable from state the run already holds. Anything needing a
render is `skipped` with a reason, exactly as `black_frames` is today.

| Check            | Fails when                                                                                               | Computed from                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `jump_cut`       | two adjacent clips come from the same asset at near-identical source times — the same shot cut to itself | `listEditBoundaries` + clip `assetId`/`sourceStart`                        |
| `word_severed`   | a cut lands inside a word's frame span rather than between words                                         | `get_mapped_transcript` word spans + boundary frames                       |
| `dead_air`       | silence longer than a stated threshold at the head or tail of the sequence                               | `analyze_silence` results, already in the evidence store                   |
| `audio_slam`     | every boundary is a hard butt cut on both picture and audio, with no J/L handles anywhere                | boundary list + per-layer clip spans                                       |
| `shot_rhythm`    | shot lengths have near-zero variance across the sequence — machine-cut pacing                            | clip durations                                                             |
| `handle_starved` | a transition sits at a boundary without the source frames it needs to overlap                            | `listEditBoundaries` already computes `tailHandle` — surface it as a check |

`jump_cut`, `word_severed` and `handle_starved` are the highest-value three; the others can
follow. Each needs a threshold that is **stated and defensible**, not tuned until the
fixture passes — and stated in **frames** (Phase 3), because "0.1 seconds" means different
things at 24 and 60 fps.

---

## P4.2 — Repair that can actually repair — `[x]`

**Touches:** `orchestrator.ts` (`FIXABLE_CHECKS`, the repair pass).

A check the agent cannot act on trains it to ignore the critic. Each new check joins
`FIXABLE_CHECKS` only when an existing tool can address it, and the repair instruction says
**which tool and what to change** — not "improve the pacing".

| Check            | Repair                                                        | Tool                                          |
| ---------------- | ------------------------------------------------------------- | --------------------------------------------- |
| `jump_cut`       | insert a cutaway, or extend one side past the match           | `add_stock` / `trim_clip`                     |
| `word_severed`   | move the boundary to the nearest word edge                    | `trim_clip` / `split_clip`                    |
| `dead_air`       | ripple-delete the head/tail silence                           | `ripple_delete`                               |
| `handle_starved` | shorten the transition, or move it to a boundary with handles | `add_transition` / `professional_edit`        |
| `audio_slam`     | offset the audio boundary by N frames                         | `professional_edit` (roll/slip already exist) |
| `shot_rhythm`    | **not repairable** — report only                              | —                                             |

Note the last row. `shot_rhythm` is diagnostic; pretending it is fixable would produce
random re-trimming that satisfies a variance metric and looks worse. Say so in the check's
detail text.

> **Reuse note.** Roll, slip, slide and insert already exist in `professional-commands.ts`
> and are reachable from the AI layer — they have no UI, so they are AI-only today. Phase 4
> is where they earn their keep: they are exactly the operations a repair pass needs.

---

## P4.3 — The critic sees what the run saw — `[x]`

**Touches:** `critic.ts`, `kernel/evidence-store.ts` (built), `kernel/briefing.ts` (built).

A continuity check needs the same footage knowledge the planning turns had. Route the
critic through the run's evidence store and briefing rather than re-reading the project —
the facts are already distilled and the payloads are already filed under handles.

This is also a context-management change, and it is why Phase 4 belongs in this plan rather
than in a separate editing-quality one: **the critic is another consumer of the run's
context, and it currently gets a thinner view than the planner did.** A run that could see
the whole transcript while planning and only the timeline while reviewing will approve cuts
it would have rejected.

**Evidence.** A run where a check fires on evidence gathered eight turns earlier, with the
handle cited in the check's detail.

---

## Scope gate

- **User outcome.** The first cut the agent hands back has no jump cuts, no words cut in
  half, and no dead air — because it checked, found them, and fixed them before the editor
  ever saw it.
- **Current gap.** Fourteen checks, none editorial; three repairable.
- **Minimum vertical slice.** `jump_cut` + `word_severed`, both fixable, both computable
  from state the run already holds. Two checks, two repairs, measurable on a real
  recording.
- **Reuse.** `critic.ts` (built), `edit-boundaries.ts` (built, `tailHandle` already
  computed), `professional-commands.ts` roll/slip/slide (built, AI-only), the evidence
  store and briefing (built), `analyze_silence` (built).
- **Deferred.** Eyeline and screen-direction continuity — needs reliable visual
  understanding and would be a `vision_review` extension, not a deterministic check.
  Anything requiring a render beyond what `black_frames` already gates. Music-to-cut
  alignment (the beat grid exists; scoring against it is a separate question).
- **Evidence.** Before/after on a real 5–15 minute recording, **rendered**, showing checks
  firing and repairs landing. Per `product-discipline.mdc`, a fixture alone does not
  support this claim.

## Risks

| Risk                                   | Mitigation                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A false-firing check makes edits worse | Every check ships `warn` before it ships `fail`; a check is promoted only after it has been observed correct on real runs. `warn` informs the model; `fail` triggers repair. |
| Thresholds tuned to fixtures           | Stated in frames with a written rationale in the check's detail text; reviewed as part of the check, not discovered later.                                                   |
| Repair loops                           | The existing repair pass is already bounded (`FIXABLE_CHECKS`, blast-radius caps, the Conductor's stall guard). New checks inherit those bounds; none of them is relaxed.    |
| Checks drift from what tools can do    | Every fixable check names its tool in P4.2's table; a check whose tool is removed becomes report-only in the same change.                                                    |

---

## What shipped — 2026-08-26

Six editorial checks, running on every review rather than behind a flag; `critique` goes
from 12 checks to 18. Every threshold is stated in **frames** with a written rationale in
its own constant, every check is computable from state the run already holds, and every
one either names the tool that fixes it or says plainly that it is diagnostic.

| Check            | Ships as | Repairable via                       |
| ---------------- | -------- | ------------------------------------ |
| `jump_cut`       | `warn`   | not yet — see promotion rule below   |
| `word_severed`   | `fail`   | `trim_clip` / `split_clip`           |
| `dead_air`       | `warn`   | not yet                              |
| `transition_fit` | `fail`   | `add_transition`                     |
| `audio_slam`     | `warn`   | honestly gated (see below)           |
| `shot_rhythm`    | `warn`   | never — diagnostic by design         |

**Two checks ship as `fail` and join `FIXABLE_CHECKS`; four ship as `warn`.** The phase's
own risk rule is that a check ships `warn` before it ships `fail`, and it is kept — with
two exceptions where the finding is not a matter of taste: a cut inside a word is a defect
whoever is looking, and a transition longer than its boundary is a factual mismatch between
what the run told the editor and what the timeline holds. The other four wait for real-run
observation; promotion is a one-line change.

**Three corrections to what the plan specified:**

- **`handle_starved` does not exist here, and was not written.** The plan's check assumes a
  dissolve needs source frames on both sides to overlap into. **This renderer needs none** —
  it ramps over the incoming clip's own first frames and borrows nothing from past the cut
  (`edit-boundaries.ts` module note). A check for a condition the engine cannot produce
  would fire on nothing and teach the model a rule that is false here. What replaces it is
  `transition_fit`, which catches something real: a boundary carries at most half its
  shorter shot, and an over-long request is **silently shortened** rather than refused — so
  the run describes a half-second dissolve the timeline never had.
- **`word_severed` cannot be computed from the mapped transcript**, which is the obvious
  approach and the wrong one. `mapTranscript` has already RESOLVED every straddle by the
  time it answers: a word the cut ran through is either dropped or attributed to one side,
  so a severed word is precisely the word that no longer straddles anything. Asking the
  mapped view finds nothing, every time. The check compares clips' **source** in/out points
  against the source transcript instead, scoped by `TranscriptWord.assetId` so a two-camera
  project does not report camera A's words as cut by camera B's edges.
- **`audio_slam` is report-only, and says so in its own detail text.** Its repair is
  `professional_edit` j_cut/l_cut, which needs a live editor selection and the desktop app;
  a repair pass has neither, so promoting it would send the agent at a tool that must refuse
  it. `shot_rhythm` is report-only for the reason the plan already gave, and its detail says
  **"DIAGNOSTIC ONLY: do not re-trim to change this number."**

**P4.3.** `critiqueOptions` now takes the run's `EvidenceStore` and `measuredSilences`
reads the most recent `analyze_silence` payload out of it — only that source, and only its
`ranges`, because a store scan that guessed at shapes would be a second undeclared contract
with every analysis tool. `dead_air` cites the handle inline, so a finding points at
`ev_1` rather than asserting a number from nowhere. Evidence is a **sharpening, not a
dependency**: the check always answers from the mapped transcript, and with nothing gathered
it must not invent a handle — asserted both ways.

**Evidence.** `critic-editorial.test.ts` (22 cases) covers each check's fire, its
non-fire, and its honest `skipped`; `critic-evidence.test.ts` runs a real two-turn agent
run and asserts the finding cites the handle the run filed two turns earlier. One live bug
found on the way: `checkTransitionFit` iterated `clip.effects` unguarded and turned an
entire agent run's report into `clip.effects is not iterable` on a fixture that omitted it
— the Critic is what runs when an edit has already gone wrong, so it is the last thing that
may crash.
