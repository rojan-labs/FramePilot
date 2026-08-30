# ADR 0166 — A refused legitimate edit costs more than a wipe

- **Status:** Accepted
- **Date:** 2026-08-30
- **Schema:** unchanged (runtime policy removal only — existing project files load and
  behave identically)
- **Supersedes the guard introduced by:** `plan/AI-EDIT-CONTINUITY-AND-MOTION.md` Part A
  (A2/A3), tightened by `plan/AI-TOOL-ENGINE-AUDIT-HARDENING.md`
- **Relates to:** ADR 0006 (reversible operations), ADR 0102 (the golden corpus),
  ADR 0147 (layered progress guards)

## Context

`packages/ai-sdk/src/wipe-guard.ts` was a deterministic backstop against one agent
failure loop: a run that found partially-edited state would `ripple_delete` a whole
track and rebuild from scratch, destroying prior accepted work. The guard snapshotted
run-start clip ids per track, and refused any call whose deletes covered every clip on a
multi-clip track (or a `remove_layer` on a populated one), unless the user's own prompt
matched a `FULL_RESET_INTENT` regex — the "non-trigger" allowlist for phrases like
"start over" or "clear the timeline".

That allowlist was the tell. Intent to clear a track is expressed in more ways than a
regex enumerates, and the guard's default on an unmatched phrase was to refuse. So a
user who genuinely wanted a track cleared got a refusal, and the run then spent requests
routing around a rule it had no way to satisfy — the mission baseline
(`docs/reports/system-mission/00-baseline.md`, row 9) measured exactly that: three
requests burned routing around the guard on a rebuild the user had asked for.

A guard that blocks legitimate edits is worse than the loop it prevents. The loop is
recoverable — the user undoes it. A refusal is not: the requested edit simply never
happens, and the user has no lever to authorize it beyond guessing the phrasing.

## Decision

**Remove the wipe guard entirely.** A delete that clears a track is an ordinary typed
timeline operation, validated and applied through the same path as any other.

We do not replace it with a softer version, a confirmation prompt, a threshold, or an
opt-out flag. Each of those re-creates the same problem — a rule that must guess intent
from prose — with more surface area.

## Consequences

**Reversibility is unaffected.** Undo was never the guard's job: every operation carries
its inverse through `invertProjectPatch`, and a full-track clear inverts back to the
exact prior tracks. This is pinned by a regression test in `orchestrator-stream.test.ts`
covering the multi-track, sole-track, and already-empty-track cases.

**The agent contract no longer promises a refusal.** `prompts.ts` kept its continuity
instruction — the given timeline is the user's work, continue from it — and dropped the
clause claiming a wipe "is rejected", which is now false. Instruction, not enforcement,
is the remaining protection against a gratuitous rebuild.

**The accepted risk.** A model that decides to start fresh on its own can now clear a
track, and the user's recourse is undo rather than prevention. We accept this: it is
visible, reversible, and cheap to correct, whereas the refusal it replaces was invisible
to the user and could not be corrected at all.

**Other progress guards are untouched.** The five layered run-stoppers (ADR 0147) read
per-turn facts, not delete shapes, and none of them depended on the wipe guard
short-circuiting first — the guard only ever made a call fail, which those guards
already handle as an ordinary rejected turn.

**Cost.** The shorter contract measures 45 fewer estimated input tokens per request
(22,412 → 22,367), read off the regenerated golden manifests.
