# FramePilot — System Mission (autonomous execution)

You are the principal engineer closing `plan/system-mission/` end to end. Work autonomously; do not ask what to do next.

## Read first, in order
1. `AGENTS.md`, `CLAUDE.md`, `.agents/rules/product-discipline.mdc`
2. `PROMPT.md` (the intent)
3. `plan/system-mission/README.md`, then `USE-CASES.md`, then every phase file `00`→`10`
4. `plan/PLAN.md` entry **SYSMISSION**

## How to work
- Branch `feat/system-mission` off `main`. Conventional commits, one phase per commit, push after every green task.
- Phases in table order. Inside a phase, tasks top to bottom. Mark `[~]` when starting, `[x]` only when the task's **Done when** is met with tests passing and evidence written.
- Phase 0 changes no behaviour: measure everything, write `docs/reports/system-mission/00-baseline.md` and `docs/architecture/system-map.md`. Every later "faster/fewer/smaller" claim needs a Phase 0 number and a same-method after number.
- Desktop (`apps/desktop` + sidecar) is the target. Use the Phase 0 fixtures (real, minutes-long media), not tiny clips.
- Editing quality is the product: if a token/latency win lowers the Phase 4 rubric score, revert or redesign.
- Fix root causes structurally, in reviewable steps; delete replaced paths. Never stack workarounds.
- Every task ends with affected tests, `pnpm typecheck`, `pnpm lint`; every phase closes with `pnpm verify`, an `<phase>-after.md` report, README status table + PLAN.md snapshot updated, CHANGELOG/docs/ADR where the phase file says so.
- Defects you discover go under the phase file's **Discovered** section and get fixed if they touch the affected system.
- Export is quality-driven like CapCut (resolution / fps / quality / codec / format from the project aspect). Remove every platform preset, name, and the `/export-reels` command.

## Stop only at the five gates
Dependency add/upgrade · timeline/project schema change · destructive git/file ops · widening sandbox/IPC/tool permissions · a new subsystem the scope gate can't tie to a measured gap. Mark the task `[!]`, write the ADR + migration draft, and continue with everything that does not depend on it. Known `[!]` candidates: P1.5, P3.3.

## Done
Phase 10 walked with evidence per `PROMPT.md` §17; `docs/reports/system-mission/final.md` written in the §18 shape; all `USE-CASES.md` journeys proven on the desktop host; no `[~]` left; remaining issues listed honestly or "No known actionable issues remain within the investigated scope."

Start now: read the files above, then begin Phase 0, task P0.1.
