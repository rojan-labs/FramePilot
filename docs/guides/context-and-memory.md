# Context and memory

How FramePilot decides what the AI sees on each request, what it remembers between
requests, and how to read the context meter when the number moves.

See also: [ADR 0075](../adr/0075-durable-run-working-state.md) (durable run memory),
[ADR 0078](../adr/0078-context-visibility-and-provider-continuity.md) (context visibility),
[ADR 0080](../adr/0080-context-manifest-and-memory-separation.md) (the manifest).

---

## The seven things that are not the same thing

The single most common misreading is treating all of these as one number. They have
different lifetimes and different owners.

| Concept | Lives in | Lifetime |
| --- | --- | --- |
| Conversation history | The append-only `AiEvent` log | The conversation |
| Current request prompt | The `AiCompletionRequest` sent to the provider | One call |
| Provider context capacity | `providers/model-capabilities.ts` | The selected model |
| Durable run memory | `kernel/working-state.ts` (ADR 0075) | One editing run |
| Project memory | The project file (`memory-store.ts`, the sidecar brain) | The project |
| Tool-result storage | `kernel/evidence-store.ts`, referenced by handle | The run |
| Remaining capacity | Derived: limit − input − reserved output | One call |

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
the model: what done looks like, the current stage, what is established (*do not gather
again*), what was decided (*keep unless the stated trigger fires*), what was applied
(*do not repeat*), what failed (*do not retry unchanged*), and the one next action. It is
built from distilled conclusions, not payloads — a read produces a one-line fact plus an
evidence handle, so the briefing stays flat in project duration.

**The assembled context** (`context-builder.ts`) is the project material for this request:
timeline slice, transcript slice, footage map, selection, pinned entities, project memory,
skills manifest. Tiers are dropped lowest-priority-first to fit the budget, and the drop
is reported rather than silent.

### Revision awareness

An applied patch invalidates only `timeline_dependent` knowledge. The transcript, the beat
map, the footage map and the source durations are `revision_independent` — a cut cannot
change what was said or where the beats are — so they survive every edit. This is what
stops a run re-deriving its whole reconnaissance each time an edit lands.

---

## Pre-request invariants

Before each agent turn, `kernel/context/invariants.ts` checks that the request still knows
what it is doing:

| Invariant | Required when | Recovery |
| --- | --- | --- |
| `objective` | Past the `interpret` stage | The creator's raw request stands in |
| `next_action` | Past `interpret`, before `complete` | Derived from the stage and outstanding objectives |
| `project_revision` | Always | Clamped back to the run's base |
| `committed_work` | Executing (`apply`/`enhance`/`repair`) | **None** — reported as a warning |

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
