# 0119. The evidence batch ceiling is a time budget

- Status: Accepted
- Date: 2026-08-14

## Context

Temporal review measures the picture and sound of an edit at the frames the edit changed.
The engine bounds a batch (`MAX_REQUESTS = 64`, `MAX_RENDERED_FRAMES`), and the client
bounds its patience (`DEFAULT_TIMEOUT_MS`). The two numbers were chosen independently, in
different languages, and never compared.

Measured on a reference sequence — 37 clips at 1080p cut from UHD sources, the ordinary
shape of a b-roll assembly:

| cost                                        | measured |
| ------------------------------------------- | -------- |
| compile the composition                     | ~33s     |
| one frame, sampled in ascending order       | ~313ms   |
| one 5-frame evidence window (seek + frames) | ~2.1s    |

A role-isolated audio request compiles its own composition, so a batch touching dialogue
and music pays the compile three times.

The arithmetic that follows was never true:

- The **default** plan (48 requests) costs 33 + 48×2.1 ≈ **134s** against a **120s** timeout.
  Not the worst case — the ordinary one. Review timed out as a matter of course on any
  project big enough to be worth reviewing.
- The **largest legal** batch (600 frames) costs ≈ **285s** against the same 120s. The engine
  advertised a maximum it could never deliver.

The user-visible result was that every edit on a real project came back "applied and
validated but NOT perceptually reviewed" — the fail-closed path of ADR 0118 firing
constantly, for a reason that had nothing to do with the edit.

Separately, frames were sampled by iterating the request `set`. Readers stream forwards
cheaply and seek backwards expensively: the same 60 frames measured 18.8s in ascending
order and 38.8s shuffled. CPython iterates a small-int set in ascending order only while
the values stay below the set's table size — which for a plan of this size means only while
the sequence is under about 35 seconds. Past that the ordering silently degrades and the
batch costs twice as much, with nothing in the code expressing that it ever mattered.

## Decision

The frame ceiling and the timeout are two halves of **one budget**, and neither may be
changed alone. Each carries the arithmetic and a pointer to the other:

- `MAX_RENDERED_FRAMES` = 400 (`engine/python/.../validation/temporal_evidence.py`) — a
  worst case of 3 compiles + 400 frames ≈ 224s.
- `DEFAULT_TIMEOUT_MS` = 300s (`packages/ai-sdk/src/temporal-evidence-client.ts`) — covers
  that worst case with headroom for a slower machine.

Frames are sampled with `sorted(visual_frames)`, so the cheap ordering is a property of the
code rather than an accident of the sequence's length.

## Consequences

Temporal review completes on the projects it was built for, so the "not perceptually
reviewed" warning goes back to meaning what ADR 0118 intended: the engine was genuinely
unreachable, not merely slower than an arbitrary number.

The budget is calibrated against one measured machine and one reference sequence. A much
slower machine, or a sequence with far heavier sources, can still exhaust 300s — that
failure stays fail-closed and is correct. What is no longer acceptable is a _default_ plan
exceeding the budget, which is the condition this ADR exists to prevent; the numbers above
are the check to re-run when either side is touched.

Lowering the ceiling from 600 to 400 frames narrows the largest batch a caller may request.
No caller reaches it: the planner's own cap is 64 requests, and at the 5-frame windows it
emits that is 320 frames.

Not taken here: removing the per-role recompile, which is the single largest remaining cost
and the reason the worst case needs three compiles. That is an engine change to the way
role isolation is built, and it belongs with its own measurement. See `plan/PLAN.md`.
