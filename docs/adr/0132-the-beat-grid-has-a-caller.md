# ADR 0132 — The beat grid has a caller

**Status:** accepted
**Date:** 2026-08-21
**Closes:** the "beat-grid boundary enforcement is unwired" follow-up ADR 0126 opened and
`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` carried out of Phase 1.

## Context

`kernel/beat-grid/beat-alignment.ts` is a complete, carefully-designed, fully-tested
editorial guarantee: every interior picture cut in a beat-backed montage lands on a detected
onset, near-misses are snapped rather than rejected, audio and caption boundaries are exempt,
and the sequence's outer edges are exempt only where the grid has nothing to say.

It had **zero callers**.

Its only caller was the planned-edit graph driver, retired by the Phase-1 convergence
(ADR 0126). From that point the agent — which absorbed beat-synced montage work — could call
`detect_beats`, receive 300 exact onsets, and then place `add_clip` boundaries anywhere at
all, with nothing checking one against the other. The module was retained rather than deleted
precisely so this could be closed by wiring rather than re-derivation, and its own header
named the choke point and the blocker:

> The choke point is `Orchestrator#applyAgentTurn` […] What is missing is the run's beat
> evidence: the raw `detect_beats` payload must be threaded through `applyAgentTurn`'s
> arguments rather than held on the Orchestrator instance, which serves concurrent runs.

## Decision

Wire it exactly there, gated on evidence the agent chose to gather.

**The gate is the agent's own decision.** The rule engages if and only if this run called
`detect_beats`. There is no beat-sync mode, no flag, no user-visible toggle, and no
classifier deciding that a request "is rhythmic". The model decides that the music matters by
electing to analyze it; the runtime then guarantees the frame-accuracy that decision implies.
A run that never asks about the music pays one `undefined` check and is otherwise untouched —
which is asserted by a test, because it is the property that makes this an execution
guarantee rather than a hardcoded technique.

This is the roadmap's governing split, applied literally: **the runtime controls execution
and safety, the model controls editorial strategy.** Aligning 300 onsets against clip
boundaries is frame arithmetic, and a model doing it in its head gets it wrong in exactly the
way ADR 0076's two-timebases rule already documents.

**The payload is threaded per run, as prescribed.** `HostCallContext` gains a `beatEvidence`
box, populated when a `detect_beats` call settles and read by `applyAgentTurn` through its own
arguments. Not a field on the Orchestrator, which serves concurrent runs. The repair pass is
held to the same grid — a repair that places off-grid cuts is the same defect as a turn that
does.

**The project grid is resolved before delegating.** `alignBeatBackedBoundaries` can recover a
grid from a proposal that places the music itself, but not from music placed on an _earlier_
turn — it would report the asset as absent and reject a perfectly good cut. A new narrow
`beatGridFor(project, rawBeats)` exposes the semantic index's existing `deriveBeats`, which
translates the analyzed asset's onsets through the clips already on the timeline. Narrow
deliberately: building the whole `SemanticTimelineIndex` here would compute scenes, silences,
music, transitions, loudness and chapters on every turn of a beat-backed run to read one array
off the end of it.

## Why the payload does not come from the evidence store

The obvious source was `HostCallContext.evidence`, which already holds every read keyed by
call and survives invalidation correctly (`detect_beats` is classified `revision_independent`,
so a cut does not evict it).

It does not work: **analysis results are never put in the evidence store.** Only read-tool
results and `measure_color` are. `detect_beats` returns its payload as the tool outcome, the
orchestrator renders it into the model's action log as an exact-onset digest, and the
structured data is then dropped. Storing analysis results there would change memo behaviour,
evidence handles, and briefing facts for every analysis tool — a much larger change than this
gap warrants. The per-run box is the smaller, prescribed answer.

Recorded because "why not just use the evidence store" is the first question any later reader
will ask.

## Consequences

A beat-backed montage is now frame-accurate against the onsets the agent measured, and a cut
that cannot be made accurate is rejected with the nearest legal onset named — which is what a
correction turn actually needs. Nothing changes for any run that does not analyze beats.

**Evidence.** `beat-grid-wiring.test.ts` drives real `streamAgent` runs against a project
whose music bed is already placed, with a host executor returning a real 120bpm onset grid:

- near-miss boundaries (two frames off) are **snapped** onto real onsets;
- badly off-grid boundaries (eight frames off) are **rejected**, the message names the
  nearest detected onset, and the cut never reaches the timeline;
- with `detect_beats` never called, the identical off-grid cuts apply untouched.

Mutation-tested: forcing the gate to return early fails the first two and leaves the third
passing, which is the correct signature for this change. 3114 ai-sdk tests pass.

`beat-alignment.test.ts` continues to cover the rule itself; this file covers only the wiring,
which is the part that was missing.

## Limitations

The rule governs `add_clip`, `trim_clip` and `split_clip` boundaries on picture tracks. A
montage assembled by other means (`move_clip`, ripple operations) is not held to the grid.
That matches the module's original scope and was not widened here; widening it should follow
a real run that demonstrates the gap, not speculation.
