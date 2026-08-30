# ADR 0159 — A finding the repair pass cannot clear gets one turn with the tools

**Status:** accepted
**Date:** 2026-08-29
**Schema:** unchanged (run working-state shape unchanged; one reducer field added)
**Related:** ADR 0022 (the deterministic Critic), ADR 0081 (causal completion),
plan/system-mission P4.3, ADR 0158 (the STATE block)

## Context

The verify stage ran the deterministic self-check, gave the runtime's narrow repair
proposer one shot at the findings, and then — if anything still failed — settled the run
as `failed` with the list. The baseline ledgers show what that costs: a 30-second montage
request that landed 27 seconds ended as a failure over a duration finding the model could
have closed with one `add_clip`, because the only correction step it had was a proposer
with no tool surface and no view of the briefing.

The stage machine already declared `verify → repair → verify`; nothing ever entered
`repair`.

## Decision

`onVerifyResult` routes a failed self-check on a run that **landed work** into one
findings-scoped model turn before it settles:

- Each failed check is recorded as its own FAIL verification row, so the briefing's
  VERIFIED section shows the findings verbatim; the run advances to `repair`; a
  `run_turn` effect follows with the stage set, so the stage policy scopes the tools.
- The turn's prompt carries one block (`agentVerifyFixBlock`): fix exactly the FAIL
  lines with the smallest edit, do not re-plan, do not read more footage, stop when done.
- The next verify returns `repair → verify`, marks the findings the turn cleared as
  cleared (`clearVerifications`, which only ever flips FAIL to PASS and keeps the original
  finding in the detail), and completes or settles as before.
- **Bound:** `MAX_VERIFY_FIX_TURNS = 1`. The runtime's repair pass is the first correction
  attempt; this is the second. A finding that survives both is one the run does not
  understand, and the editor sees the list rather than paying for a third guess. The fix
  turn is its own budget, outside `maxSteps`: the step cap bounds exploration, this
  bounds correction.
- Not opened when nothing landed (there is nothing to fix), when the run was cancelled,
  or when the failure is a plan-reconciliation gap rather than a deterministic finding.

## Consequences

- A run that fails only on a fixable deterministic finding now costs at most two more
  model calls (the fix turn and its re-verify's repair pass) instead of ending failed.
  The scripted-provider suites moved from 4 → 6 calls on the "repair pass" fixtures and
  say why inline.
- Completion still requires every verification row to pass (`stageEntryViolation` for
  `complete`); `clearVerifications` is the only path that changes a row, and only
  upward.
- Conductor tests pin: the routing, the cleared-and-completed path, the bound, and the
  nothing-landed exclusion. The measured effect on the scenario rubric is Phase 4's
  after-report.
