# ADR 0162 — A reference is measurements the run is graded on, not a mood

**Status:** accepted
**Date:** 2026-08-29
**Schema:** unchanged (`ReferenceProfile` travels with a turn; it is not project state)
**Related:** plan/system-mission Phase 3, P4.2, ADR 0159 (the bounded verify loop)

## Context

"Make it feel like this reel" was, until this work, a sentence. The editor attached a file,
the host analysed it, and the analysis produced two things — human-readable `constraints`
lines and the numeric measurements behind them. **Only the first was spent.** The lines
reached the model; the numbers reached nobody.

So nothing could settle whether the run had complied. A run that cut at 4.1 s against a
1.1 s reference was not wrong about anything checkable — the editor found out by watching.

## Decision

A profile is split at its natural seam and both halves are used.

- **`constraints` are what the model reads.** They are editor vocabulary — `Pacing: fast —
median shot 1.1s (most shots 0.7–1.9s)` — and the tile in the sidebar shows those exact
  lines, not a paraphrase of them, so what the editor is told and what the model is told
  cannot drift apart.
- **`references/directives.ts` is what the deterministic side reads.** Pure and model-free,
  it reduces the attached profiles to targets. The shot-length target goes into the run's
  acceptance criteria _and_ into a `shot_length_target` Critic check that runs in
  `wholeCutChecks` — so a run is told it is off the reference pace **while it can still
  re-trim**, not after.
- **Tolerance is the reference's own p10–p90 spread.** A reel running 0.6–2.4 s is stating
  the band it allows; inventing a fixed percentage would be inventing an opinion the
  reference did not express.
- **A reference that cannot drive anything says so, by name.** A logo is measured and then
  ignored, because nothing places an overlay from a reference file yet, and the context
  block states that under its own heading. A run that quietly drops a reference teaches the
  editor that references do not work.
- **It survives the turn that attached it.** A reference the run plans against becomes a
  committed decision with `source: reference`, `until: superseded`, carrying its measured
  line verbatim, so a later turn applies the profile without re-reading or re-measuring.
  The conductor is handed the _complete live set_ of attached tiles: a subject missing from
  that set means the editor removed it, and a constraint they deleted stops binding.

## Consequences

- Analysis is a sidecar job, not a model turn — attaching a reference costs no tokens, and
  the content-hash cache means attaching the same file again costs nothing at all.
- The measurement is what makes the loop closeable: because the target is a number, the
  Critic can check it, and because the Critic can check it, ADR 0159's bounded fix turn has
  something concrete to fix.
- Roles beyond pacing are **read but not yet acted on**. That is stated in the guide's
  Limits section rather than left for a user to discover, and it is the honest boundary of
  this decision: the contract is in place, the controllers behind it are not all built.
