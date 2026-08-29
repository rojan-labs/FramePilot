# System mission — orchestration, context, editing quality, UX, performance, export

> **Sub-plan index of `plan/PLAN.md`** (parent entry **SYSMISSION**). Created 2026-08-29.
> Executes the brief in [`PROMPT.md`](../../PROMPT.md). Read `AGENTS.md`, `CLAUDE.md`,
> `plan/PLAN.md`, and `.agents/rules/product-discipline.mdc` before touching anything here.
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked (needs maintainer)
>
> **Status:** `[ ]` planning complete, nothing executed. Phase 0 is the first thing to run.

This directory is written so an agent can take it forward **without asking what to do
next**. Every phase file says what it ships, what it does not, what it depends on, which
files it touches, what evidence closes it, and where the maintainer gates are. Work the
phases in the order of the table; inside a phase, work tasks top to bottom.

---

## 0. What the codebase already has (do not rebuild these)

Verified 2026-08-29 against the tree. Each later phase builds on, promotes, or measures
these; none of them is to be reinvented.

| Capability | Where | State |
| --- | --- | --- |
| Single agent runtime: pure Conductor reducer + LangGraph shell | `packages/ai-sdk/src/kernel/conductor.ts`, `kernel/agent-graph.ts` | shipped (ADR 0102/0103) |
| Context tiering, budgeting, compaction, run briefing, invariants, token manifest | `kernel/context/*`, `kernel/briefing.ts`, `context-builder.ts` | shipped; 5 phases of `plan/context-management/` closed with before/after benchmark |
| Deterministic Critic proposer (+ advisory LLM judgment seam) | `kernel/proposers/critic.ts`, `src/critic.ts` | shipped |
| Domain controllers (audio, color, motion, timeline, tracking) | `packages/ai-sdk/src/controllers/*` | shipped — these are the de-facto "workers" |
| Stage policy, loop detector, commit ledger, evidence store, progress guards | `kernel/stage-policy.ts`, `kernel/loop-detector.ts`, `kernel/commit-ledger.ts`, `kernel/evidence-store.ts` | shipped (ADR 0149–0157) |
| Cost / turn metrics instrument | `kernel/cost/run-metrics.ts`, `cost-meter.ts`, `baseline-capture.ts` | shipped, pure; **not yet wired into a standing report** |
| Deterministic context benchmark | `packages/ai-sdk/scripts/context-benchmark.mjs` → `reports/context-benchmark-*.json` | shipped |
| Real-provider eval rig (Tier B–D) | `packages/ai-sdk/src/eval/foundation-real-eval.ts`, `pnpm eval:agent:foundation` | shipped; semantic grading **not** wired |
| Memory Store (project-level AI memory) | `packages/ai-sdk` memory store, persisted in project file (PRD §8.7) | shipped |
| TS↔Python tool mirror + MCP parity fixtures | `scripts/generate-tool-parity-fixture.mjs`, parity tests, `packages/mcp-server` | shipped |
| Composer attachment chips (image/document via paste or file) | `apps/web-editor/src/components/ai/Composer.tsx`, `ai/conversation.ts` | **UI only** — chips are never threaded into the orchestrator request |
| Frame images into the model | `orchestrator.ts` `images` on `HostToolOutcome` (from `get_frame`) | shipped — the only image path to the model today |
| Render job lifecycle + validation, cancel endpoint, preview/frame routes | `engine/python/framepilot_engine/render/pipeline.py`, `queue.py`, `service.py` `/render/*` | shipped; synchronous driver, no hardware encode |
| Platform export presets, hand-mirrored TS↔Python | `render/presets.py` `EXPORT_PRESETS`, `ExportDialog.tsx` `EXPORT_PRESETS` | shipped — **to be replaced** (Phase 7) |
| Desktop export client / hub / save | `apps/desktop/electron/render/export-*.ts` | shipped |
| Playwright e2e (25 specs, web-editor host) | `tests/e2e/specs/*` | shipped; no full AI journey, no desktop journey |
| Run log | `framepilot.runs.jsonl` (per-tool rows) | shipped |

## 1. Phases

| # | File | Ships | Depends on | Maintainer gate | State |
| --- | --- | --- | --- | --- | --- |
| 0 | [`00-BASELINE.md`](./00-BASELINE.md) | Numbers for every claim the mission will make; a system map | — | none | `[x]` 7/7 — every baseline measured and reported |
| 1 | [`01-ORCHESTRATION-AND-CONTEXT.md`](./01-ORCHESTRATION-AND-CONTEXT.md) | Fewer, purposeful model calls; structured state instead of prose; cross-turn decision memory | 0 | none unless a schema field is needed for persisted decisions (then `[!]`) | `[~]` 3/6 · 3 partial — all six scenarios measured, every one improved; read-cache/parallelism closed by evidence |
| 2 | [`02-PROMPT-AUDIT-AND-PARITY.md`](./02-PROMPT-AUDIT-AND-PARITY.md) | Audited prompts, one source of truth per prompt/tool/schema across hosts | 0 | none | `[x]` 6/6 — audit, parity and host differences closed |
| 3 | [`03-REFERENCE-MEDIA-CONTEXT.md`](./03-REFERENCE-MEDIA-CONTEXT.md) | Reference videos + images attached in the sidebar reach the model as analyzed, reusable structured context | 1 | **yes** — a persisted `references` field is a schema change | `[~]` 3/7 · 4 partial — profiles drive the plan and survive turns; the two e2e runs need a provider |
| 4 | [`04-EDITING-QUALITY-AND-VERIFICATION.md`](./04-EDITING-QUALITY-AND-VERIFICATION.md) | Semantic operations; bounded verify loop; a graded scenario suite | 1, 3 | none | `[x]` 5/5 — verify loop, score floor and CI gate; one semantic op shipped, seven refused with the measurement |
| 5 | [`05-WORKERS-AND-LIFECYCLE.md`](./05-WORKERS-AND-LIFECYCLE.md) | Specialization only where Phase 0/1 numbers earn it; typed contracts; lifecycle for every long-lived process | 1 | none | `[~]` 4/6 · 2 partial — registry, coalescing, typed contracts; the engine-kill e2e still does not pass |
| 6 | [`06-MEMORY-AND-RESOURCES.md`](./06-MEMORY-AND-RESOURCES.md) | Leak audit across renderer / main / sidecar / FFmpeg; fixes at the owner | 0 | none | `[~]` 6/7 · 1 partial — four real leaks fixed and the gate made provable; P6.1 needs the desktop harness |
| 7 | [`07-EXPORT.md`](./07-EXPORT.md) | CapCut-style quality/resolution export; platform presets removed; hardware encode; faster and cancellable | 0 | none (render request shape changes are engine-internal, not the project schema) | `[x]` 7/7 — CapCut export, 4K exports 4.2x faster, progress accuracy passing |
| 8 | [`08-UI-UX-AUDIT.md`](./08-UI-UX-AUDIT.md) | Interaction fixes against professional-tool standards; sidebar shows what the AI knows / does / changed / needs | 3, 7 | none | `[~]` 5/7 · 2 partial — every renderer-side finding closed; two await e2e legs and a schema decision |
| 9 | [`09-E2E-AND-REGRESSION.md`](./09-E2E-AND-REGRESSION.md) | Full desktop AI journey, failure paths, editing regression suite, efficiency gates in CI | 1–8 | none | `[~]` 4/7 · 3 partial — gates proven and wired; the provider-dependent rows are written but unrun |
| 10 | [`10-FINAL-VERIFICATION.md`](./10-FINAL-VERIFICATION.md) | Definition of Done walked with evidence; final report | 0–9 | none | `[~]` 3/4 · 1 blocked — DoD walked, reports written; P10.2 needs a human at the app |

[`USE-CASES.md`](./USE-CASES.md) lists every end-to-end user journey the mission must
prove, traces each through the system, and maps it to the phases and tests that cover it.
When a phase closes, update the matrix there.

## 2. Rules that bind every phase

1. **Desktop first.** Measure and test on `apps/desktop` with real camera files minutes
   long. `tests/e2e` runs against the web-editor host; Phase 9 adds a desktop journey.
   A browser-only gap may be deferred with a note; a desktop regression blocks the phase.
2. **Measure, then change.** No phase may claim "faster", "fewer", or "smaller" without a
   Phase 0 number and a same-method after number, committed under `docs/reports/`.
3. **Editing quality is the product.** A token or latency win that lowers the Phase 4
   scenario score is a regression and is reverted or redesigned.
4. **Structure over workaround, delivered in reviewable steps.** Replace a mechanism
   behind its existing contract; delete the old path in the same or the next commit;
   never leave two implementations of one policy.
5. **Maintainer decision (2026-08-29): all changes in this plan are pre-approved**, including
   the schema gates at P1.5 and P3.3 (still: write the ADR and the migration, keep Zod ↔
   Pydantic in sync, add drift tests). Dependency additions still run `pnpm license:scan`
   and are noted in the phase report. Recorded here per `CLAUDE.md` §5 so later agents do
   not re-open the question.
6. **The five ask-first gates** (`CLAUDE.md` §5) are the only places to stop: new or
   upgraded dependency; project/timeline schema change; destructive git/file operation;
   broadening the sandbox, IPC surface, or tool permissions; a new subsystem the scope
   gate cannot tie to a measured gap. Mark the task `[!]`, write the ADR draft and the
   migration plan, and continue with everything that does not depend on it.
7. **Every task ends with tests and docs.** Affected package tests, `pnpm typecheck`,
   `pnpm lint`; `pnpm verify` before a phase closes. User-facing change → `CHANGELOG.md`
   and a `docs/guides` update; decision → ADR (next number after 0157).
8. **Plan hygiene.** Mark `[~]` when starting a task, `[x]` only at Done-when; add
   discovered tasks to the phase file's §"Discovered" section; keep this README's status
   table and the PLAN.md **SYSMISSION** snapshot current.
9. **Logging.** Anything worth tracing uses `createLogger` / `logging.getLogger`
   (`AGENTS.md` §7); no `console.log`/`print`.

## 3. Branch and commits

Branch `feat/system-mission` off `main`. One phase may span many commits; one commit
never spans two phases. Prefixes: `feat(orchestration)`, `refactor(context)`,
`fix(prompts)`, `feat(ai-sidebar)`, `fix(runtime)`, `perf(export)`, `test(e2e)`,
`docs(mission)`. Push after every green task.

## 4. Evidence layout

```text
docs/architecture/system-map.md                  Phase 0 map (kept current thereafter)
docs/reports/system-mission/00-baseline.md       every Phase 0 number, with reproduce commands
docs/reports/system-mission/<phase>-after.md     same method, after numbers, per phase
reports/system-mission/*.json                    machine-diffable artifacts (benchmarks, metrics)
docs/reports/system-mission/final.md             Phase 10 report (PROMPT.md §18 shape)
```
