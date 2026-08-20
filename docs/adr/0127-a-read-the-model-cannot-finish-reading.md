# ADR 0127 — A read the model cannot finish reading

**Status:** accepted
**Date:** 2026-08-19
**Supersedes:** nothing. Extends the read-digest discipline established for
`list_assets`, `detect_beats` and `load_skill` in `orchestrator.ts#summarizeReadResult`.

## Context

A real montage-refinement run stalled without producing a patch. The request was ordinary:

> "can you do more precise montage cuts and use at least of 45 clips, dont keep the clips
> from the starting offset, check the indexing and trim the clips properly and place
> properly"

The project held 41 video clips over 0–21.867s, one music bed 0–19.749s, and 40 caption
cues. The run loaded `beat-synced-editing`, read `get_timeline_map`, listed assets,
recalled `ev_1`, detected beats — and then re-derived the same reading of the request in
three consecutive turns without editing anything. The maintainer's verdict was
"it's hallucinating a lot more on even simple things."

It was not hallucinating. It was reasoning about data it had never been given.

**"Don't keep the clips from the starting offset" is a question about `sourceStart`** — where
in the asset each clip begins reading. Three surfaces could have answered it, and none did:

- the context block renders clips as `clipId[start–end s]` (`context-builder.ts`
  `renderTrackClips`) — sequence times only;
- `get_timeline`'s digest renders `id asset=X start–end s` (`orchestrator.ts` `clipLine`) —
  sequence times only;
- `get_timeline_map`, `map_time`, `get_clips` and `get_clip` — the only reads that carry
  source in/out — had **no entry in the digest table**, so each fell through to
  `previewJson(value, ANALYSIS_PREVIEW_MAX)`: a blind 1200-escaped-character slice ending
  in a bare `…`. A 42-span timeline map serialises to ~8.8 KB, a 50-row `get_clips` page to
  ~12 KB. The model received roughly four records of forty-two, with nothing telling it how
  many were missing.

`recall_evidence` could not rescue it either. `EvidenceStore.recall` split its payload on
newlines to apply the query filter; `JSON.stringify` emits none, so an object payload was
one single "line" — a query either matched the whole blob (returning the same truncated
head, clipped at 4,000 chars ≈ 18 spans) or matched nothing at all. (The record-aware filter
this ADR introduced still left two holes, both closed by ADR 0128: the query was matched as
one literal substring rather than by word, and there was no way to page past the 4,000-char
recall budget.)

So the model did the only thing left: it read the millisecond suffix of the clip ids
(`clip__layer_video_main_asset_cropped_search_464`) and tried to work out whether it meant
a source offset or a sequence time. It encodes the **timeline start** (`deriveClipId` in
`editor-core/operations.ts`), so that is a trap, not a hint. The visible churn the
maintainer read as hallucination is a model repeatedly failing to obtain a number and
repeatedly re-deriving what it should do about that.

Two capability-honesty defects compounded it in the same turn:

- `summarizeVisualStatus` told the run to "look at a specific moment with `get_frame`"
  regardless of whether the run's model can read an image. `Orchestrator#agentTools`
  withholds every `vision`-capability descriptor from a text-only model, and
  `agentModeInstruction` already gates its own get_frame paragraph on the same predicate.
  This one line did not, so a sightless run was told to use a tool absent from its list.
- `beat-synced-editing` and `footage-intelligence` advertised `index_media` in the skill
  manifest. It is registered — and in `IMPLICIT_ONLY_TOOL_NAMES`, withheld from every
  model-facing scope, because indexing is lifecycle work the app drives.
  `validateSkillTools` tested for _registration_, which `index_media` passes.

## Decision

**A read that carries information the run was asked to act on is bounded by whole records,
never by characters.** The digest table gets `get_clips`, `get_timeline_map` and
`map_time`, rendering each record as `id asset=… track=… seq a–b s src c–d s [×speed]`
through the existing `boundedRecords` helper — every id and both time pairs intact, with an
explicit "N more … narrow by" tail instead of an ellipsis. No new abstraction: this is the
shape `list_assets` and `detect_beats` already use.

**A recall filters by record when the payload is a list.** `EvidenceStore.recall` now
descends into a bare array, or into the single array-valued property of a wrapper object
(`{ spans, duration, revision }`, `{ clips, total, hasMore }`). Two array properties keep
the line split: there is no unambiguous answer to what a record is, and guessing would
silently drop half a payload.

**Advice about a tool is conditioned on whether the run has that tool.**
`summarizeVisualStatus` takes a required `canSeeFrames` — required, not defaulted, so a new
call site has to decide rather than inherit whichever answer happened to be safe. The
desktop stream threads it from `Orchestrator#canSeeFrames()`, the same `supportsVision`
predicate that filters the tool list, so the prompt and the tool list cannot disagree.

**A skill advertises only tools the model can select.** `validateSkillTools` now drops
implicit-only and unavailable names as well as unregistered ones, and a bundled-skills test
asserts every advertised tool appears in the ordinary model-facing scope.

**Tool descriptions state what they cannot do.** `trim_clip` moves both edges together and
cannot change where in the asset a clip reads from while holding its timeline span; the
only path an autonomous run has for that is `delete_clip` + `add_clip` with a new
`sourceStart` (`professional_edit`'s `slip` needs a live selection and the clip's asset
loaded in the source monitor, which an agent run does not have). `get_timeline_map` now
says it returns every clip and points at `get_clips` for a window.

## Consequences

- Token cost rises where these reads are used, by design: a 42-clip map is ~2.5 KB of
  digest instead of ~1.2 KB of truncated JSON. `READ_DIGEST_MAX_ITEMS` (300) still bounds
  it, and past that the tail names the paginated alternative.
- Five frozen golden corpora and one snapshot were regenerated. Every divergence was a
  token estimate — the two longer tool descriptions and the smaller skill manifest. No
  event, operation or status changed.
- `summarizeVisualStatus`'s signature is a breaking change for callers outside this repo's
  desktop path. There are none today.

## Second run, 2026-08-19: four more, and one of them was hiding the others

A second run of the same request (deepseek-v4-pro, 6 model calls, 102,314 tokens, $0.98,
13m14s, cancelled at review) produced a full 46-clip montage on a new track — and its
transcript settles what the first run could only suggest. Reasoning time per turn ran
13.7s → 50.4s → 120.6s → 151.9s → **391.1s** → 62.4s, with 33,666 output tokens in the
fifth call. Every one of those turns opens by re-deriving the same five-point reading of
the request. Four defects, in the order they compound:

**1. The run's memory recorded what it had DONE, never what it had LEARNED.** Every
in-process read returned `summary: desc` — its own descriptor — and `distil` built the
fact from that, so `ESTABLISHED — do not gather again` read:

```
- Reading the beat synced editing playbook → Reading the beat synced editing playbook
- Reading the timeline → Reading the timeline
- Browsing the media bin → Browsing the media bin
```

Three restatements of three verbs. The digest that belonged there was being computed one
line away for the action log. Reads now carry a `finding` (the digest's head line) that
`distil` records instead, and a digest whose head line was one arbitrary track's clip list
gets a real head (`5 tracks, 87 clips: …`). A fact that only restates its own label is now
dropped rather than recorded, because an absent fact shows the gap while a restatement
teaches the run that its memory is noise.

**2. `isSemanticLoop` had been disabled in production, and defect 1 was hiding it.** The
Conductor computed `stageAdvanced = staged !== state.working` — an object comparison
against a `state.working` the fact fold had _already replaced_. So it read true on any turn
that recorded a fact, and false on a turn that advanced a stage while recording none: very
nearly the inverse of its name. Since `isSemanticLoop` treats advancing as proof the run is
not circling, a re-orienting run — which records a fact every turn — could never be caught.
It appeared to work only because the facts were byte-identical duplicates that `recordFact`
deduplicates into a no-op. Fixing defect 1 made every fact distinct and turned the detector
off completely, which is how it was found. It now compares the stage.

**3. The recovery turn removed the one tool its own instruction told the model to use.**
`agentTools('action-recovery')` returned `kind === 'mutate' || kind === 'ask'`, so
`recall_evidence` — a `read` — was withheld, while `ACTION RECOVERY` said to work from
evidence already gathered and `recall_evidence`'s own description says "use this instead of
re-running the read". The model looked for it, reasoned "recall_evidence is referenced in
the system prompt but it's not in my available tools. That's a problem for getting the full
asset list", and then **inferred the asset durations it needed from the millisecond suffixes
of clip ids**, placing 46 clips against guessed bounds. Recall now survives the recovery
turn; nothing else read-shaped does.

**4. The briefing printed the editor's request back under four headings.** The conductor
seeds `objective.outcome`, its single acceptance criterion, the committed plan's single
decision, and the run's single objective all from `userPrompt` at construction, so the
briefing said the same 200-character sentence five times — as WHAT DONE LOOKS LIKE, as
DECIDED, as OBJECTIVES 0/1, as DO THIS NOW (`Continue analyze: <the whole request>`), and
as the request itself. Repetition is the mild cost; the real one is that DECIDED listing the
request asserts something was decided when nothing was, and OBJECTIVES restates the request
as a checkbox no tool can tick. Those echoes are now suppressed, and `defaultActionFor`
falls through to the per-stage instruction it already had ("finish the analysis the plan
depends on") instead of naming an objective that is the request verbatim.

Suppressing the echoes is not the same as interpreting the request — that still needs a
seam for the model to write an interpretation, below.

## What this ADR does NOT fix

Recorded so a later reader does not mistake an open problem for a closed one.

- **The interpretation slot still holds an echo, not an interpretation.** (The briefing no
  longer _renders_ the echo four times; the underlying state is unchanged.)
  **Partly closed by ADR 0128:** the seed is now marked `objective.provisional` and
  `setObjective` lets the first real interpretation replace a placeholder, so the slot is no
  longer permanently occupied — but no production caller writes an interpretation yet, so the
  run's derived reading is still not durable. ADR 0128 also stops a bare "continue" from
  overwriting the objective with the nudge itself.
  `conductor.ts` writes the objective from `userPrompt.trim()` — as both the outcome and
  the single acceptance criterion — at run construction, and `setObjective` is
  idempotent by design ("re-interpreting the request mid-run is exactly the drift this
  module exists to prevent"). So the briefing's "WHAT DONE LOOKS LIKE" is the raw request
  text, `isInterpreted()` is true before the first turn, and no turn can ever replace it —
  the opposite of what `working-state.ts` documents ("the objective's outcome and
  acceptance criteria are written by the first turn"). The run's actual reading of the
  request — the montage ends at 19.749s to match the bed, ≥45 clips over that span means a
  ~0.44s average, visual search is unavailable so cut placement is beat- and scene-driven —
  is never durable, so it is re-derived every turn. This is the direct cause of the
  observed churn and of the fact that neither the 2.1s video-over-audio overrun nor the
  clip-length arithmetic was ever surfaced to the editor.
- **The decision-recording seam is unwired.** `addDecision`, `commitDecision`,
  `reviseDecision`, `recordObjective` and `setBlocker` have no production callers. The
  briefing's "DECIDED — keep unless the stated trigger fires" is populated only from plan
  step labels, and "BLOCKED" never. A model that has just worked out a constraint has
  nowhere to put it.
- **`stage-policy.ts#planningExhausted` is dead.** Its docstring claims it expresses the
  research budget "as a STAGE change so the closure is durable instead of lasting a single
  turn". It has no caller; only `conductor.ts#researchBudgetSpent` — the same predicate,
  duplicated — runs, and it withholds reconnaissance for one turn at
  `RESEARCH_BUDGET_TURNS = 8`. The rail exists and would have fired; eight turns of pure
  gathering is generous, and the durable version does not exist.
- **Beat-grid boundary enforcement remains unwired** (already tracked as the Phase-1
  follow-up in `plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md`). `kernel/beat-grid/
beat-alignment.ts` has no production caller, so even with correct evidence an off-grid
  montage boundary is neither snapped nor rejected.

Each of these changes run semantics and belongs in its own reviewed slice.
