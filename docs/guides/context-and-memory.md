# Context and memory

How FramePilot decides what the AI sees on each request, what it remembers between
requests, and how to read the context meter when the number moves.

See also: [ADR 0075](../adr/0075-durable-run-working-state.md) (durable run memory),
[ADR 0078](../adr/0078-context-visibility-and-provider-continuity.md) (context visibility),
[ADR 0080](../adr/0080-context-manifest-and-memory-separation.md) (the manifest),
[ADR 0146](../adr/0146-one-frame-grid-for-every-edit.md) (the frame grid), and
`plan/context-management/` (the programme that connected all of this, with its
before/after measurements in `reports/context-benchmark-*.txt`).

---

## The seven things that are not the same thing

The single most common misreading is treating all of these as one number. They have
different lifetimes and different owners.

| Concept                   | Lives in                                                | Lifetime           |
| ------------------------- | ------------------------------------------------------- | ------------------ |
| Conversation history      | The append-only `AiEvent` log                           | The conversation   |
| Current request prompt    | The `AiCompletionRequest` sent to the provider          | One call           |
| Provider context capacity | `providers/model-capabilities.ts`                       | The selected model |
| Durable run memory        | `kernel/working-state.ts` (ADR 0075)                    | One editing run    |
| Project memory            | The project file (`memory-store.ts`, the sidecar brain) | The project        |
| Tool-result storage       | `kernel/evidence-store.ts`, referenced by handle        | The run            |
| Remaining capacity        | Derived: limit − input − reserved output                | One call           |

**Only the second and the last change per request.** When the meter moves, the durable
run memory, the project memory and the evidence store are untouched.

---

## Reading the context readout

The composer shows one string next to Send — `17K/1M`: what this request occupies, over
the model's window. Hovering it (or tabbing to it) opens a tooltip with the rest.

```text
17K of 1M tokens, estimated
855K still available · 128K reserved for the reply
Older history was summarized 4 requests ago.

This is the context in the current AI request. It moves as FramePilot retrieves project
information or compresses older conversation history — your project memory and committed
decisions stay saved.
```

- **The figure** — `estimated` until the provider reports a real count; `reported`
  afterwards. FramePilot never shows a local estimate as an exact figure.
- **Still available** — capacity minus input minus the reserved reply. The reply
  reservation is held back from the prompt, which is why the two do not simply subtract.
- **Summarized** — shown only when compaction has actually happened, in this request or
  an earlier one. Silence means history has never been compressed in this chat.

### Why the number moves

It is supposed to. A request may include a large tool result that the next one replaces
with a summary; a skill may load for one stage and not the next; the budgeter may trim the
transcript to fit. None of that touches memory — not the durable run memory, not the
project memory, not the evidence store — which is what the tooltip's closing line says.

If you want the exact cause, the development build adds an inspector to the same tooltip
that diffs the two most recent requests section by section: which sections were added,
removed, grew or shrank, and what that adds up to.

---

## What the model actually sees

Two things drive whether the next turn continues or starts over.

**The state briefing** (`kernel/briefing.ts`) is the run's memory of itself, rendered for
the model: what done looks like, the current stage, what is established (_do not gather
again_), what was decided (_keep unless the stated trigger fires_), what was applied
(_do not repeat_), what failed (_do not retry unchanged_), and the one next action. It is
built from distilled conclusions, not payloads — a read produces a one-line fact plus an
evidence handle, so the briefing stays flat in project duration.

**The assembled context** (`context-builder.ts`) is the project material for this request:
timeline slice, media bin, source media, transcript slice, footage map, selection, pinned
entities, project memory, skills manifest. The **media bin** digest is present even when
every asset is already on the timeline: the timeline slice describes the trimmed CLIP, and
the bin is the only block that states each asset's SOURCE duration. Deleting it once
everything was placed cost more in repeated `list_assets` calls than the ~15 tokens per
asset it saved. Tiers are dropped lowest-priority-first to fit the budget, and the drop
is reported rather than silent — **to the model as well as to the UI**, as a
`NOT IN THIS PROMPT` block naming each missing tier and the call that returns it. A model
that does not know the transcript was dropped reasons as though the project has no
dialogue, which is not a smaller answer but a wrong one.

### How big the slice is

The timeline and transcript slices are **allocated from the room the budget leaves**, not
capped by a constant (`allocateGroundingSlice`). The old constants — 12 clips per layer,
600 words — are now floors, so coverage can only ever go up, and a small-window model
behaves exactly as it did. Each tier is guaranteed half the remaining room and hands back
whatever it does not need, in both directions, so a project with no dialogue does not
reserve half the prompt for a transcript tier that will not spend it.

The budget itself comes from the model actually selected (`resolveContextBudget`), minus
the prompt cost the assembler cannot see: tool schemas (~17,500 tokens on a planning turn),
the mode instruction, and any pinned skill playbooks. Both halves matter — before this,
every request trimmed against one hardcoded 190,000-token window, which was 159,000 tokens
more room than a small local model has.

### Which part of the slice

On footage too long to fit, `context-retrieval.ts` decides _which_ part, with a declared
precedence: **pinned entities** (never ranked away) → **the selection as a bias, not a
boundary** → **the request's own scope**. A global request ("find the strongest moments")
fills its room evenly across the whole timeline; a local one ("tighten this") fills outward
from the selection. A selection no longer walls the model off from the recording it was
asked about, and the ranker may reorder within the room but may never show less than the
budget alone would have.

### Prompt-cache stability

`AssembledContext.split` divides the assembled user content where it stops being stable for
the run. **Only the timeline summary varies per turn** — it renders from the mutating
working copy. The transcript, footage map, visual status, memory tiers and skills manifest
are fixed for the run's duration, so the agent loop puts them ABOVE its cache boundary.
Anything stable that sits after something volatile is re-billed at full price every turn.

### Revision awareness

An applied patch invalidates only `timeline_dependent` knowledge. The transcript, the beat
map, the footage map and the source durations are `revision_independent` — a cut cannot
change what was said or where the beats are — so they survive every edit. This is what
stops a run re-deriving its whole reconnaissance each time an edit lands.

Within `timeline_dependent`, the store asks WHICH operations landed
(`kernel/evidence-store.ts`). A patch changes the **picture** (how a rendered frame looks),
the **structure** (the track/clip listing), or both; `get_frame` evidence rests on the
picture alone. So adding an empty track no longer discards a rendered frame that cannot
have changed, while it does discard the track listing. Any operation type the store does
not recognise — including a new one in `editor-core` — invalidates everything, deliberately:
a stale frame presented as the current edit is worse than a re-render.

---

## What crosses the run boundary

A new run for the same conversation and project is seeded from the previous run's ledger
(`carryForwardWorkingState`), so a follow-up does not re-learn the footage.

**Carried:** `revision_independent` facts and **committed** decisions.
**Not carried:** the objective, plan, stage, next action, blockers, verifications and
operations — they belong to the run that made them, and inheriting them is how a run ends
up executing the previous turn's plan.
**Not carried, and worth knowing why:** evidence handles. A handle addresses the previous
run's `EvidenceStore`, which is in-memory and per-run, so the payload is gone; carrying an
address that cannot be dereferenced is the failure `clearedWithHandle` exists to prevent.
Carried facts therefore arrive uncited and say so, prefixed `(from an earlier session)`.

Nothing crosses unless the conversation **and** the project both match. On desktop the
host supplies the previous ledger via `RunCoordinator.latestWorkingStateFor`; the browser
build has no run store, so nothing is inherited there — an honest gap, like proxies.

## What the editor can teach

`remember_preference` writes `preferredPacing`, `captionStyle`, `brandStyle`,
`targetAudience` and `exportPlatforms` into the project's AI memory, which is injected into
every turn under "Project memory (honour these preferences)". The key set is **closed on
purpose**: `aiMemory` round-trips through `project.fp.json` and feeds that block, so a
free-text memory tool would make it an unbounded, model-authored prompt-injection surface
that grows every turn. Writes go through the patch path (`set_ai_memory`) and are
reversible like any other edit.

## Pre-request invariants

Before each agent turn, `kernel/context/invariants.ts` checks that the request still knows
what it is doing:

| Invariant          | Required when                          | Recovery                                          |
| ------------------ | -------------------------------------- | ------------------------------------------------- |
| `objective`        | Past the `interpret` stage             | The creator's raw request stands in               |
| `next_action`      | Past `interpret`, before `complete`    | Derived from the stage and outstanding objectives |
| `project_revision` | Always                                 | Clamped back to the run's base                    |
| `committed_work`   | Executing (`apply`/`enhance`/`repair`) | **None** — reported as a warning                  |

Recovery is deterministic: no model call, no guess. `committed_work` is deliberately not
recoverable — inventing a plan would have the run execute against something nobody chose.

---

## Adding a model to the capability table

`packages/ai-sdk/src/providers/model-capabilities.ts` maps a model id to its context
window and output cap. Add an entry when a provider ships a model FramePilot is likely to
be pointed at:

```ts
'claude-opus-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
```

Matching is exact first, then longest prefix (so a dated snapshot inherits its base
model), then the provider's floor. An unknown id is not an error — it falls back to the
floor and the UI labels the capacity `assumed`. Prefer under-promising: a smaller assumed
window makes the budgeter trim early (a shorter prompt), while an over-promised one makes
it overflow the provider (a rejected request).

---

## Tests to run when changing any of this

```bash
pnpm --filter @framepilot/ai-sdk test    # includes kernel/context/continuity.test.ts
pnpm --filter @framepilot/web-editor test
```

`kernel/context/continuity.test.ts` is the regression suite for the failure this
architecture exists to prevent: it walks a montage run through many turns, an applied
edit, a reload, a model switch and forced compaction, and asserts on the briefing and the
manifest — the two things the model and the creator actually see. Changing compaction,
revision invalidation or the briefing without updating it means the guard is gone.

The frozen agent golden (`kernel/streamAgent-golden.test.ts`) captures the full event
stream including manifests; a deliberate change to context accounting will move it, and
the diff is worth reading rather than reflexively updating.
