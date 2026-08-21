# 0085. Preserve multi-stage planned-edit continuity through final verification

- Status: Superseded by [ADR 0126](0126-one-mutating-ai-runtime.md) — the planned-edit
  execution route this decision governs was retired in the 9.5 convergence. The record is
  kept for history; its reasoning no longer describes a live code path.
- Date: 2026-07-28

## Context

A planned montage could assemble and verify a valid base cut, then ask EditProposer for
transitions, grading, and keyframes. That later proposer still received the original
project, not the validated in-run cut. Its prompt therefore omitted the newly created clip
ids required by the polish tools. Provider responses alternated between an empty call list
and explanatory prose; after the bounded retry budget, the late task failed and discarded
the already valid montage.

The planner could also end a graph on that late mutation. In that shape there was no final
assembly or verification covering all proposed operations. Verification used a shared
mutable `runEdit` value, which could select the wrong assembly when independent graph
branches completed concurrently.

## Decision

Every task derives an immutable working project from its validated ancestor assemblies.
Exact duplicate operations are removed when an aggregate assembly contains operations from
an earlier intermediate assembly. Downstream semantic indexes, tool contexts, analyses,
and identity catalogs use that projected project. The identity catalog includes clip ids in
addition to asset and track ids.

Plan compilation closes every model-mutation lifecycle. If all proposals are not covered by
an assembly with a downstream verification, the compiler appends a deterministic final
assembly and/or verification node. A final assembly combines earlier validated operations
with later proposal operations. Verification resolves its edit from the task's own
transitive ancestors rather than whichever assembly most recently updated process-local
state.

Structured proposer parsing accepts exact JSON, fenced JSON, or one bounded balanced JSON
object embedded in a harmless wrapper. The candidate must still satisfy the full response
schema and tool registry; arbitrary prose remains invalid.

If a refinement downstream of a validated and successfully verified checkpoint exhausts all
proposal attempts, the task settles as a visible warning with no new operations. The
compiler-owned final assembly and verification continue over the preserved valid edit. A
mutation with no verified ancestor checkpoint still fails closed.

## Consequences

Late transitions, grades, and keyframes can reference clips created earlier in the same run,
and every returned edit has one final validated and verified operation set. Provider
formatting noise is recoverable without weakening schema validation. A failed optional
refinement no longer destroys substantial valid work, while the warning and notification
make the omitted refinement explicit.

Projecting ancestor operations adds deterministic validation work before downstream tasks.
Conflicting branches fail rather than being merged speculatively. Partial completion is
allowed only after a validated and verified ancestor assembly exists; this deliberately
preserves the fail-closed boundary for runs that never produced a safe edit.
