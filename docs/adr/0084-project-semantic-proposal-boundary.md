# 0084. Validate model proposals against project semantics before assembly

- Status: Accepted; the EditProposer it validated was removed with the planned-edit route
  ([ADR 0126](0126-one-mutating-ai-runtime.md)). The principle — validate model proposals
  against project semantics before assembly — is upheld by the agent's tool-argument
  boundary, which is where it now lives.
- Date: 2026-07-28

## Context

EditProposer validated the JSON shape and Zod schema of each proposed tool call, then
converted those calls into typed operations. It did not validate the resulting operation
batch against the current project until a later `assemble_patch` task.

That gap accepted identifiers that were syntactically strings but semantically belonged to
the wrong namespace. In a reported montage run, `track_music_rise_up` and
`track_cinematic_nature_v1` were supplied as `assetId` values in fourteen `add_clip` calls.
Every call passed tool parsing, the proposal task completed, and only patch assembly found
the missing assets. The late failure discarded the graph's remaining work and summarized
the invalid result as though fourteen operations had been assembled.

The preceding empty-proposal recovery also consumed the run's only correction attempt, so
the model could not repair this distinct project-reference error.

## Decision

Every EditProposer request receives an exhaustive identity catalog with field-shaped,
separate `assets[].assetId` and `tracks[].trackId` namespaces. Tool and system guidance
state that these identifiers are not interchangeable.

After registry parsing and operation construction, the plan driver validates the entire
operation batch against the current timeline, asset set, and folders. A rejected batch is
not a completed model task. The bounded correction turn receives operation-addressable
validator messages, such as the exact unknown asset, before any dependent assembly or
verification task can run.

Model-backed mutation tasks have at most three proposal attempts: the initial proposal and
two local corrections. This is sufficient for two independent trust-boundary failures
(for example, empty output followed by an invalid reference) while remaining bounded and
without graph-level replanning. Assembly repeats project validation as defense in depth and
reports the actual validator issues if it still rejects a batch.

## Consequences

Track/asset identity confusion is prevented by grounded input and rejected deterministically
if it still occurs. Reference, overlap, range, and other project-semantic errors become
repairable at the step that proposed them rather than fatal after the graph advanced.

Every proposal attempt consumes provider time and tokens, so the extra correction increases
the worst-case cost of a persistently invalid model task. The ceiling remains fixed, all
attempts remain cost-accounted, and exhausted proposals fail before mutation. Patch assembly
continues to validate independently, preserving the existing safety invariant even when
operations originate outside EditProposer.

**Amended by [ADR 0085](0085-multi-stage-planned-edit-continuity.md):** later proposal
steps validate against an immutable projection of their validated ancestor assemblies, and
their identity catalog includes the clips created by those assemblies. An exhausted
post-verification refinement preserves the earlier validated edit as a visible warning; a
mutation without a verified ancestor checkpoint still fails closed.
