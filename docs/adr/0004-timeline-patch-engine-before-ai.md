# ADR 0004: Build the timeline + patch engine before the AI layer

- **Status:** Accepted
- **Date:** 2026-06-18

## Context

The single biggest engineering risk (PRD §23) is trying to build Premiere Pro, After
Effects, DaVinci Resolve, and Cursor all at once. The product's reliability thesis (PRD
§3) is that **AI edits must be concrete, reviewable, and reversible** — what changed, why,
before/after, diff, undo (PRD §3.2). That is only possible if the _editing primitives_
are themselves trustworthy: typed, validated, deterministic, and invertible.

If we built the AI layer first, AI would have to mutate the project somehow — and any
mutation path that isn't typed/validated/reversible becomes the path AI uses, making
"reviewable and reversible" impossible to guarantee after the fact.

## Decision

We will build the **timeline schema + patch engine first** (Phase 1, before any AI), with:

- a closed set of **typed operations**, each a pure `apply` plus an `invert` for undo;
- a **patch envelope** (`patchId`, `createdBy`, `reason`, `operations[]`) and a lifecycle
  state machine (proposed → validated → previewed → applied → reverted/failed);
- a **patch validator** (references, durations, layer order, assets, reversibility, …)
  held to 100% coverage;
- transactional apply, before/after **diffing**, and undo/redo via inverse operations.

The AI layer is then built _on top_ and is constrained to act **only** through tools that
return patches into this engine. See
[../architecture/timeline-and-patch-engine.md](../architecture/timeline-and-patch-engine.md).

## Consequences

- **Positive:** AI edits inherit the same safety as manual edits for free — validation,
  diff, preview, undo, history, crash recovery all work identically.
- **Positive:** the engine is fully testable with **no AI and no network**, so the
  foundation can reach 100% coverage before model behavior enters the picture.
- **Positive:** clean dependency direction — AI depends on the engine, never the reverse.
- **Negative:** delays the first visible "AI does something" demo; requires discipline to
  not bolt on shortcuts that bypass the engine (enforced by CI rule: "no unvalidated
  timeline operation reaches apply").

## Alternatives Considered

- **AI-first / prompt-to-render** — rejected: produces unreviewable, irreversible "magic"
  and contradicts PRD §3.2–§3.4.
- **Let AI write project JSON directly** — rejected: no validation surface, no diff, no
  guaranteed undo; this is exactly the failure mode the patch engine exists to prevent.
- **Build engine and AI in parallel** — rejected: the AI contract (tools return patches)
  isn't even definable until the patch engine exists.
