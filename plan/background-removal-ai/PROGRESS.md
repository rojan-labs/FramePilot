# Progress (resume state)

Read this first after a context reset. Updated after every commit.

- **PR:** #124, branch `plan/background-removal-ai`, worktree `../FramePilot-background-removal`. One PR; commits prefixed with task ids; no attribution trailers; no `git add -A`, no `git stash`.
- **Verification:** targeted test files locally; full suites run in CI on the PR head SHA.

## Current

- PX0 + PX1 — inventory, frame plan, parity vectors (render-debugger agent)
- MK1 — schema v22 mask stack, migration, ops, validator (timeline-engineer agent)
- BR0 — ONNX exports, per-EP parity, verify-stage recall, sizes (general-purpose agent)

## Done

- RD0.1 (9fd09d00): competitor re-check, `12` §E
- Setup: PR retitled and marked ready; `PROGRESS.md` and `MAINTAINER_ONLY_ACTIONS.md` created.

## Blocked (maintainer-only, see `MAINTAINER_ONLY_ACTIONS.md`)

- RD1.1–RD1.2, RD1.5–RD1.6, RD2.3–RD2.4, RD3 (MO-1..MO-7, MO-10)
- BR7.1 labels (MO-8); win32-x64 evidence (MO-9)

## Next

PX0 → PX1 → PX4 → PX2; MK1 → MK2; BR0; RD0.

## CI reds

- none recorded yet

## Gate numbers

- none measured yet
