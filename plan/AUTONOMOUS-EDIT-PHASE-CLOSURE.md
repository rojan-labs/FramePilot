# Autonomous Edit Phase Closure Ledger

> Branch: `plan/autonomous-edit-phase0-diagnosis`
>
> Policy: implementation is completed phase by phase. CI, repository-wide checks,
> desktop execution, and release evidence remain deferred until the user explicitly
> requests the verification pass.
>
> Status legend: `IMPLEMENTED`, `ACTIVE`, `NOT STARTED`, `VERIFICATION DEFERRED`.

## Phase 0: Reproduce and diagnose

**Implementation status:** `IMPLEMENTED`

Repository contracts, provider behavior, current tool surfaces, evidence requirements,
root-cause buckets, cache identity, conflict decisions, and the real-media baseline
protocol are documented in `AUTONOMOUS-EDIT-PHASE0-EVIDENCE.md`.

**Verification status:** `VERIFICATION DEFERRED`

The exact local Electron run with the user's real media cannot be executed through the
GitHub connector. It remains a release gate and must not be represented as completed.

## Phase 1: Repair the core edit path

**Implementation status:** `IMPLEMENTED`

Closed implementation scope:

- canonical rational frame-rate conversion and frame snapping at patch assembly;
- explicit source/sequence time mapping and first-class visual evidence;
- conservative half-open frame ranges for words, silence, shots, and visual events;
- safe speech-gap and nearest legal cut-boundary selection;
- transactional normalize, plan, evidence, propose, validate, correct, apply, render,
  verify, reconcile, rollback, complete flow;
- revision checks, cancellation, idempotency, grouped inverse rollback, and no-op failure;
- at most two bounded correction attempts with exact validation/completion issues;
- deterministic golden acceptance for duration, overlaps, retained words, caption timing,
  transition handles, preview/render revision parity, visual evidence, and grouped Undo;
- focused regression specifications for frame-time, evidence, runtime, completion, and
  golden-fixture behavior.

Primary implementation files:

- `packages/ai-sdk/src/frame-time.ts`
- `packages/ai-sdk/src/edit-evidence.ts`
- `packages/ai-sdk/src/media-evidence.ts`
- `packages/ai-sdk/src/completion-gate.ts`
- `packages/ai-sdk/src/autonomous-edit-runtime.ts`
- `packages/ai-sdk/src/autonomous-edit-golden.ts`
- `packages/ai-sdk/src/assemble.ts`

**Verification status:** `VERIFICATION DEFERRED`

The new tests are committed as executable specifications but have not been run. The
real five-intent desktop fixture, preview, render, audio continuity, and one-click Undo
must be exercised during the later verification pass.

## Phase 2: Consolidate the tool surface

**Implementation status:** `ACTIVE`

## Phase 3: Deterministic probe and timestamp queries

**Implementation status:** `NOT STARTED`

## Phase 4: TwelveLabs facade and automatic understanding

**Implementation status:** `ACTIVE`

## Phase 5: Universal persistent caching

**Implementation status:** `ACTIVE`

## Phase 6: Provider narrowing and caption-setting migration

**Implementation status:** `ACTIVE`

## Phase 7: Orchestration accuracy and recovery

**Implementation status:** `ACTIVE`

## Phase 8: AI sidebar transparency and ask-user UX

**Implementation status:** `ACTIVE`

## Phase 9: Verification, ADRs, guides, and release evidence

**Implementation status:** `NOT STARTED`

This phase intentionally remains last and includes the deferred CI and runtime checks.
