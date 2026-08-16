# ADR 0056 — Per-turn agent diffs (instant auto-apply, per-step review)

- **Status:** Accepted
- **Date:** 2026-07-13
- **Amends:** ADR 0042/0044 (conductor finalize semantics) and ADR 0033/0041 (sidebar
  event stream) — the streaming agent no longer emits one combined diff at finalize.

## Context

The streaming agent (`Orchestrator.streamAgent`) streamed `tool_call` and
`timeline_action` cards live per turn, but the only event carrying an **applyable
patch** — `diff` — was emitted once, at `finalize`, covering the whole run
(`assembleEdit(input.project, cumulativeOps, …)`). The sidebar's apply mode
(`auto`/`manual`, UI-only) reacts to diff nodes; with a single terminal diff, **auto
mode could not apply anything until the entire agent round completed**, even though
each turn's ops had already been validated and applied to the run's working project.
Users on auto mode watched mutation cards stream by with a frozen timeline.

## Decision

1. **One `diff` per successfully validated + applied turn.** `runTurn` emits the
   turn's already-assembled `EditResult` the moment the turn lands, tagged with two
   new optional `DiffEvent`/`DiffNode` fields: `scope: 'turn'` and a 1-based
   `turnIndex`. The Critic repair pass emits its applied ops the same way (one more
   turn-scoped diff). Non-agent paths (edit / recipe / planned-edit) keep their
   single untagged diff; absent `scope` means legacy single-proposal semantics.
2. **No combined diff at `finalize` or on the error `settle` path.** Every op is
   offered exactly **once**, at the turn where it landed. This is the dedup story:
   with no terminal combined diff there is nothing to double-apply, no consumer-side
   dedup logic, and an aborted/failed run's partial work is already represented by
   the per-turn diffs emitted before the interruption.
3. **UI:** auto mode's existing auto-apply effect applies each per-turn diff as it
   arrives (instant mid-run timeline updates); manual mode stacks per-turn review
   cards — each header shows a `Step N` badge from `turnIndex` — with the existing
   per-card Accept/Reject and batch Apply all / Reject all.
4. **Undo granularity: one undo step per turn** (each apply is its own
   `applyPatchChecked` history entry). Deliberate product decision — users can peel
   back individual agent actions; each patch is independently reversible.
5. **Resume:** a checkpoint replay re-applies kept ops to the working project but
   emits **no** diff for them — they were already offered by the interrupted run's
   per-turn diffs. Only the resumed run's new turns emit diffs.

## Consequences

- Auto mode edits the timeline step-by-step in real time; manual mode reviews the
  run as an ordered stack of steps instead of one opaque combined patch.
- The event schema change is additive (optional fields) — legacy consumers of
  untagged diffs are unaffected. Any external consumer that awaited exactly one
  diff per agent run must now fold `scope:'turn'` diffs (behavioral break, noted in
  CHANGELOG).
- Per-turn patches are assembled against the run's working project in sequence, so
  applying them in emit order reproduces the run exactly; out-of-order manual
  accepts may honestly fail `applyPatchChecked` re-validation (existing 'failed'
  card handling covers this).
- `FinalizeEffect.ops` remains — it still feeds the completion report.
