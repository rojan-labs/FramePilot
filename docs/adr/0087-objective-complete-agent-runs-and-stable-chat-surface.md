# 0087. Require objective-complete agent runs and keep chat state stable

- Status: Accepted
- Date: 2026-07-30

## Context

An agent could apply a valid partial edit, return a turn with no tool calls, and move
straight to verification while committed plan steps were still pending. Verification then
treated a reconciled operation ledger as sufficient even when the deterministic Critic had
failed an explicit acceptance condition, such as a requested 30-second deliverable ending
at six seconds. This produced a success-shaped summary for unfinished work.

The sidebar also presented one mutable run status in its header and selected the latest
internal model call for its context meter. During a multi-call turn, classifier, planning,
execution, and repair requests have deliberately different prompt sizes, so the meter
appeared to lose and regain context. Switching from AI to Inspector unmounted the sidebar,
detaching its renderer-side conversation and run state even though the durable runtime
continued.

## Decision

The conductor treats a no-tool response as completion only when the committed plan has no
unfinished step. When work remains, it issues one bounded, mutation-only recovery turn
focused on the first incomplete deliverable. A second actionless response cannot loop; it
continues to verification and fails honestly if the ledger or acceptance checks remain
incomplete. Verification requires all three conditions: deterministic checks pass, the
committed plan reconciles, and at least one traceable operation succeeded. Explicit
whole-deliverable durations in creator language are derived into Critic acceptance criteria
when the caller did not supply a duration option.

Every reasoning node retains its own immutable event id and settlement state. Live run
activity is rendered beside the composer, not as a header-wide state. The context meter is
owned by the first substantive request of the latest user turn: the estimate may settle to
provider-reported usage for that same request, but later internal calls do not replace it.
The AI sidebar remains mounted while Inspector or Transcript is selected, so its active
conversation, draft, scroll state, and stream attachment remain alive.

Model capability lookup first honors an exact qualified id, then accepts a unique
slash-insensitive basename. `zhipuai/glm-5v-turbo` and the configured
`glm-5v-turbo` therefore share the models.dev limits: 200,000 context tokens and 131,072
output tokens.

## Consequences

Partial valid patches remain reviewable, but an unfinished objective cannot claim that all
checks passed. Large edits get one focused opportunity to continue instead of silently
dropping the remaining plan, while the bounded retry prevents infinite agent loops.

The context figure no longer jumps between internal orchestration prompts, panel navigation
does not interrupt an active chat, and activity is attached to the place where the creator
can stop or steer the run. Keeping the sidebar mounted costs a small amount of dormant React
state while another right-rail panel is visible; this is intentional because run continuity
is more important than reclaiming that component state.
