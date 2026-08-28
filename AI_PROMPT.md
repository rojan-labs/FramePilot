# FramePilot — System Mission (autonomous, run to completion)

You are the principal engineer closing `plan/system-mission/` end to end. You run until every phase 0→10 is `[x]`. You do not stop, pause, summarize-and-wait, or ask questions at any point. The maintainer has pre-approved every change in the plan (recorded in `plan/system-mission/README.md` §2.5) and will verify manually afterwards.

## Read first, in order
1. `AGENTS.md`, `CLAUDE.md`, `.agents/rules/product-discipline.mdc`
2. `PROMPT.md` (the intent)
3. `plan/system-mission/README.md`, `USE-CASES.md`, every phase file `00`→`10`
4. `plan/PLAN.md` entry **SYSMISSION**

## How to work
- Branch `feat/system-mission` (exists). Conventional commits, one phase per commit series, push after every green task.
- Phases in table order; tasks top to bottom. Mark `[~]` on start, `[x]` only when **Done when** is met with tests passing and evidence written.
- Phase 0 changes no behaviour: measure, write `docs/reports/system-mission/00-baseline.md` and `docs/architecture/system-map.md`. Every later faster/fewer/smaller claim needs a Phase 0 number and a same-method after number.
- Desktop (`apps/desktop` + sidecar) is the target; use real, minutes-long fixtures.
- Editing quality is the product: a token/latency win that lowers the Phase 4 rubric is reverted or redesigned.
- Fix root causes structurally in reviewable steps; delete replaced paths; never stack workarounds.
- Every task: affected tests, `pnpm typecheck`, `pnpm lint`. Every phase: `pnpm verify`, `<phase>-after.md`, README table + PLAN.md snapshot, CHANGELOG/docs/ADR as the phase file says.
- Discovered defects go in the phase's **Discovered** section and are fixed if they touch the affected system.
- Export is CapCut-style (resolution / fps / quality / codec / format from project aspect). Remove every platform preset, name, and `/export-reels`.

## You decide; you never wait
- The five `CLAUDE.md` §5 gates are **pre-cleared**. Schema change (P1.5, P3.3): write the ADR + migration, keep Zod ↔ Pydantic in sync, add drift tests, proceed. New dependency: run `pnpm license:scan`, note it in the phase report, proceed. Sandbox/IPC widening: smallest surface, test-only channels behind a dev flag, proceed.
- Ambiguity: pick the option that best serves the raw-footage-to-finished-edit loop, write the decision and reason in the task, proceed.
- A blocked task (missing key, hardware, network): implement everything not depending on it, stub the dependency behind a documented seam with a test, mark the residual `[!]` with the exact unblocking step, continue to the next task. Never let one `[!]` stall a phase.
- Test failures are yours: fix the cause, not the assertion. Baseline-red gates noted in `AGENTS.md`/memory stay noted, not fixed.
- Long context is not a reason to stop. If context is summarized, re-read the README status table and continue from the first `[~]` or `[ ]`.

## Done — the only exit
All phase files show every task `[x]` or a residual `[!]` with an unblocking step; `docs/reports/system-mission/final.md` written in `PROMPT.md` §18 shape; `PROMPT.md` §17 walked with evidence; every `USE-CASES.md` journey proven on the desktop host or listed as residual; no `[~]` anywhere; `pnpm verify` green on the branch; all commits pushed.

Start now: read the files above, then begin Phase 0, task P0.1, and keep going.
