# CLAUDE.md - Claude Code Working Rules for FramePilot

> **Read `AGENTS.md` first.** It holds the canonical shared rules (mission,
> architecture, setup/test commands, coverage, safety, code style, forbidden
> shortcuts, Definition of Done). This file adds Claude Code-specific working
> rules and pointers. Quality, **SECURITY**, **CORRECTNESS**, and **PRODUCT FOCUS**
> are the priority.

> **Current product focus: the DESKTOP app is #1, not the browser.** When a
> behavior, fix, or trade-off differs between the Electron desktop app
> (`apps/desktop` + the `fp-media://` protocol, sidecar-derived proxies,
> on-disk media) and the plain browser build, design, test, and optimize for
> the desktop path first. Browser-only gaps (e.g. no proxy generation without
> the sidecar) are acceptable to defer; desktop regressions are not. Reproduce
> performance work against desktop-scale media (real camera files, minutes
> long), not just tiny fixtures.

> **Product-scope rule:** before non-trivial feature, architecture, or plan expansion,
> read `.agents/rules/product-discipline.mdc`. Protect the raw-footage-to-finished-edit
> loop before adding professional-editor breadth or generalized infrastructure.

---

## 1. How to plan

1. **Read `plan/PLAN.md` before any work** - it is the source of truth for execution.
2. Identify the task. If it does not exist, add it. **Mark it `[~]` (in progress)**
   before you start editing code.
3. For non-trivial feature/architecture work, run the product scope gate from
   `.agents/rules/product-discipline.mdc` before designing the solution. State:
   - user outcome;
   - current workflow gap;
   - minimum end-to-end vertical slice;
   - existing systems to reuse;
   - explicitly deferred adjacent scope;
   - evidence required for completion.
4. Use the `product-scope-reviewer` subagent when work adds a subsystem, expands into a new
   editing domain, creates a large sub-plan or multiple ADRs, adds a runtime/provider/worker
   boundary, or crosses several architecture layers before the user value is proven.
5. Use a planning approach for non-trivial work: state the steps, the affected
   packages, the tests you will add, and the patch/validate/render flow you will follow.
6. **Honor the build order:** timeline + patch engine → render + validation → AI
   layer → compositing → agent mode. **Do not build AI features before the engine
   they depend on exists and is tested.** (PRD §23.)
7. Create a large sub-plan only when the scope gate justifies it and the plan leads to a
   near-term executable vertical slice. Documentation volume is not implementation progress.

See `.agents/skills/plan-keeper/SKILL.md`, `.agents/rules/plan-management.mdc`, and
`.agents/rules/product-discipline.mdc`.

---

## 2. How to edit

- **Every video edit is a typed timeline operation** in `packages/editor-core`, with
  both `apply` and `invert`, validated before apply. The AI layer produces **patches**,
  never raw `project.fp.json` mutations.
- **Finish before expanding.** A schema, worker, backend, tool, ADR, or plan is not a shipped
  editing capability. If applicable, complete the user entry → target resolution → operation/tool
  → validation → preview → render/export → undo → error-state → test path.
- **Prefer reuse over new infrastructure.** Do not create a framework, runtime, store, protocol,
  capability pack, plugin system, provider layer, or generalized abstraction for hypothetical
  future use. Generalize only when current requirements demonstrate concrete consumers,
  repeated duplication, or the maintainer explicitly requests it.
- **Small, reviewable changes.** Prefer a focused vertical slice over a sweeping refactor.
- **No large unreviewed rewrites.** If a change touches many files or rewrites a
  module, stop and propose the plan first; split into reviewable pieces.
- **Do not bundle unrelated subsystems into one PR.** One PR should have one coherent product
  or reliability goal.
- Respect the **render-vs-preview** rule: MoviePy = render engine only; UI preview
  uses HTML video / canvas / proxy media.
- **Log properly, don't `console.log`/`print`.** New or touched modules that do
  anything worth tracing use the shared scoped logger (AGENTS.md §7: `createLogger`
  from `@framepilot/shared-types` in TS, `logging.getLogger` in Python) - high-signal
  events via `log.action(...)`, everything else via `debug`/`warn`/`error`.
- Keep `timeline-schema` (Zod) and the Python Pydantic schemas in sync; **no schema
  change without a migration**.
- **Environment variables have one source of truth.** Whenever a new env var is
  added, renamed, or removed anywhere in the codebase (TS `process.env.*`,
  Python `os.environ`/`os.getenv`, Electron main-process reads, etc.), update
  root **`.env.example`** and **`turbo.json`**'s `globalEnv` array in the same
  change - plus `apps/web-editor/.env.example` if the var is web-editor/Vite-
  specific (`VITE_*`). Group new entries near related vars; don't reorder
  existing ones. A var in one file but not the other is a bug.

---

## 3. How to run tests

Use the commands in `AGENTS.md` §4. **After each edit, run the affected tests**:

- TS: `pnpm test` (or the affected package's test), `pnpm typecheck`, `pnpm lint`.
- Python: `pnpm engine:test`, `pnpm engine:lint`, `pnpm engine:typecheck`.
- Before declaring done: `pnpm verify`; add/extend e2e for critical flows.
- Cover core deterministic modules **meaningfully** (behavior + error paths);
  no coverage percentage to hit, and no vanity coverage.
- For major AI/editing capability claims, verify the actual timeline outcome. For visual/audio
  claims, include render-backed or deterministic evidence appropriate to the claim.
- Do not use tiny fixtures alone to support a long-form performance claim.

---

## 4. Learning log / project memory

- Project-level AI memory (style, pacing, accepted/rejected edits) lives in the
  **Memory Store** (`packages/ai-sdk`, persisted in the project file) - see PRD §8.7.
  Do not invent a parallel store.
- For repo-level lessons (gotchas, decisions), record them where they belong:
  an **ADR** in `docs/adr/` for decisions, a guide in `docs/guides/` for how-tos,
  and check off / annotate `plan/PLAN.md`. Keep this file (`CLAUDE.md`) updated if a
  working rule itself changes.

---

## 5. When to ASK before acting

Pause and ask the user/maintainer before:

- **Adding/upgrading any dependency** (run `pnpm license:scan`; flag license risk).
- **Changing the timeline/project schema** (requires a migration + doc + tests).
- **Any destructive or irreversible operation** on files or git history.
- **Broadening the path sandbox**, IPC surface, or agent tool permissions.
- Large rewrites or cross-cutting architectural changes.
- Introducing a new subsystem, runtime, store, protocol, generalized provider/plugin layer,
  or professional editing domain when the product-scope review cannot tie it to a current
  workflow or measured gap.

If the maintainer explicitly chooses broader scope, record that decision in the relevant
plan/ADR/PR so later agents do not silently undo it.

---

## 6. Avoiding large unreviewed rewrites

- Default to the smallest change that satisfies the task and its tests.
- Prefer a complete narrow vertical slice over a broad backend-only foundation.
- If you find you must touch many files, split into a sequence of reviewable patches
  and surface the plan in `plan/PLAN.md` first.
- Never reformat unrelated code in the same change.
- Prefer deleting or consolidating obsolete paths over maintaining parallel implementations.

---

## 7. Plan & docs obligations (do these every task)

- **Plan:** mark `[~]` when starting, `[x]` only when the Definition of Done is met
  and tests pass; add discovered tasks; keep the snapshot/date current.
- **Scope:** do not mark a capability complete when only its backend, schema, worker, tool,
  placeholder UI, hardcoded demo path, ADR, or plan exists.
- **Docs:** update `docs/` (guide/API/ADR as appropriate) and `CHANGELOG.md` for any
  user-facing change. Document **WHY**. Keep design documentation proportional to the
  decision and tied to executable work. See `.agents/rules/documentation.mdc` and
  `.agents/skills/docs-maintainer/SKILL.md`.

---

## 8. Subagents

Specialized subagents are maintained in `.agents/agents/claude/` and exposed to
Claude Code through the `.claude/agents` adapter:
`timeline-engineer`, `render-debugger`, `ai-tooling-engineer`, `mcp-engineer`,
`lead-prompt-engineer`, `security-reviewer`, `qa-e2e`, `performance-monitor`,
`performance-optimizer`, `product-scope-reviewer`, `plan-keeper`, `docs-maintainer`,
`changelog-maintainer`, `editing-skills-expert`. Delegate to the matching one
for focused work.

Use `product-scope-reviewer` before major scope expansion. It is read-only and should return
`PROCEED`, `SHRINK`, `DEFER`, or `MAINTAINER DECISION` with the minimum vertical slice and
required evidence.

## 9. Slash commands

FramePilot task commands (PRD §22) are maintained in `.agents/commands/` and
exposed through the `.claude/commands` adapter. Editing commands follow the
**patch → validate → preview/review as appropriate → deterministic evidence** flow and update
plan/docs:

`/plan-edit`, `/create-short`, `/remove-silence`, `/add-captions`, `/improve-pacing`,
`/add-hook`, `/export-reels`, `/debug-render`, `/write-tests`, `/review-timeline-patch`,
`/review-product-scope`, plus `/update-plan` and `/update-docs`.

## 10. Pointers

- Shared rules: **`AGENTS.md`** (canonical).
- Product discipline: **`.agents/rules/product-discipline.mdc`** (always-on scope gate).
- Workflows: **`.agents/skills/*/SKILL.md`**.
- Rules: **`.agents/rules/*.mdc`** (apply to Claude too as project conventions).
- Claude adapters: **`.claude/agents`** and **`.claude/commands`** reference
  canonical `.agents` assets.
- Spec: **`PRD.md`** · Plan: **`plan/PLAN.md`** · Docs: **`docs/`**.
