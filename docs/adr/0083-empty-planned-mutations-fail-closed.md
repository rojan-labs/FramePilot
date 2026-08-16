# 0083. Empty planned mutations fail closed

- Status: Accepted
- Date: 2026-07-28

## Context

`propose_edit` accepted `{ "toolCalls": [] }` as a schema-valid result for a task whose
only purpose was to mutate the timeline. The graph then marked that task complete,
assembled a valid empty patch, passed deterministic verification over the unchanged
project, and persisted `completed_no_changes`. In the reported montage run this happened
for both montage placement and color grading, so the full task list appeared successful
even though no edit was proposed or applied.

Malformed proposals already received one bounded retry, but retries repeated the original
request without the rejected response or validation reason. The model therefore had no
evidence it needed to correct anything.

## Decision

A model-backed mutating task succeeds only when its validated tool calls produce at least
one typed timeline operation. An empty call list or zero-operation dispatch is a rejected
proposal, never task completion.

The driver initially retained the existing two-attempt ceiling. Before the second attempt,
it appends the bounded rejected response and exact trust-boundary reason to the original
request and asks for a grounded, schema-valid correction using the already-scoped tools. If
the second attempt remains empty, the mutation task fails. The scheduler does not dispatch
dependent patch assembly or verification, and the run terminates failed with the task label
and reason.

Legitimate deterministic recipes may still produce an empty patch when the requested
state already exists; this decision applies specifically to model-backed tasks that were
planned to create a mutation.

## Consequences

An explicit edit can no longer look successful after the model abstains. One transient or
correctable empty response gets a bounded recovery opportunity without graph-level
replanning. A genuinely impossible step ends honestly and preserves the unchanged project
instead of allowing downstream verification to certify work that never happened.

**Amended by [ADR 0084](0084-project-semantic-proposal-boundary.md):** the same fail-closed
rule remains, but the bounded ceiling is now three total attempts so a second, distinct
project-semantic rejection can also be corrected before the task fails.
