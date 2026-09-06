# ADR 0173 — A reorder is one operation, not a delete and a rebuild

- **Status:** Accepted
- **Date:** 2026-09-05
- **Relates to:** ADR 0001 (reversible operations), ADR 0056 (compound-request
  atomicity vs instant-apply), ADR 0166 (the deleted wipe guard), ADR 0146 (the
  frame grid).

## Context

Four of six clean reorder runs in the `session6` golden baseline **destroyed the
editor's footage**. Asked to move the last clip to the front, the agent deleted
the sequence and then asked how to proceed — describing the damage it had just
done as the project's own state. Two of those runs went 5 clips → 1; the full
table and run ids are in `BASELINES.md` under `session6`.

Nothing caught it because **every individual operation was legal.** The cause is
structural and has two halves:

1. **There was no reorder primitive.** `move_clip` moves one clip to a start
   time, and clips on a track may not overlap. "Put the last clip first" therefore
   had no expressible route through the operation vocabulary except
   destroy-and-rebuild.
2. **Instant-apply commits the destroy before the rebuild is composed.** Any run
   that then stops — asks a question, hits a wall, times out — leaves the
   destruction applied and the repair unwritten.

## Decision

Add `reorder_clips` to the operation vocabulary: **given a track and an ordering,
recompute the starts in one patch.** No delete, no add.

- `clipIds` is a **permutation** of the track's clips, never a subset. A partial
  list leaves "where do the others go?" unanswerable, and answering it by guessing
  is the failure mode this exists to remove. Apply rejects a partial list and
  **names the omissions**, so the model can repair its own call rather than retry
  the same shape.
- Clips are butted **end to end from the earliest current start**, keeping each
  clip's own duration, source range and compositing. This closes gaps — the
  ripple-reorder every NLE performs. A reorder that preserved gaps would have to
  decide which gap belongs to which clip, and there is no non-arbitrary answer.
- When the caller knows the project fps (`ApplyContext`, threaded by
  `applyProjectPatch`), the layout is computed in the **frame domain**. Butting
  five clips in seconds accumulates float error into every boundary after the
  first, so the fourth cut lands off the grid even when all five source durations
  were on it.
- The inverse is `restore_clips`. A reorder rewrites the whole clip array, so the
  array is both the only honest inverse and a cheap one.

The **clip set is invariant** under this operation. That is the property that
matters: a run that stops immediately after a reorder has lost nothing, which is
exactly what the four failing runs could not say.

## Alternatives rejected

**Reinstate the wipe guard (ADR 0166).** A guard on "a delete that empties a
track" catches two of the five content-loss failures in the run and misses the
three 5→1 cases. It also re-introduces the reason 0166 deleted it: a full-track
delete is an ordinary operation, and the golden set disagrees with treating it as
an error. A guard narrows a bad route; it does not supply a good one.

**Make instant-apply transactional for compound requests (ADR 0056).** Still
worth deciding on its own merits, and it would have contained the damage. It
would not have produced the edit the user asked for — with no reorder primitive,
the atomic version of destroy-and-rebuild is still destroy-and-rebuild.

**A `move_clip` that ripples its neighbours.** Overloads one verb with two
meanings ("put this clip at 12s" and "put this clip third"), and the second is
the one that needs an ordering, not a time.

## Consequences

- The agent has a route to a reorder that cannot lose content, and `move_clip`'s
  description now says so in one clause.
- Cost: **+169 tokens per request** on the frozen token surfaces (`tool_schemas`
  7,027 → 7,196), measured through `langchain-session-parity`. All three goldens
  were regenerated in the same change.
- The professional `EditorCommand` layer (`editor-capabilities.ts`) does not yet
  expose a `reorder` intent, and the web editor has no reorder gesture. Both are
  deferred: the AI route is where the footage was being lost.
- **Unmeasured against a run.** This is a capability the agent did not have, not
  a tuning change, so its effect on the reorder cases needs a baseline to confirm.
  `reorder-last-first`'s floor is 1.00 against a 0.60 median, so the gate will
  flag it either way.
