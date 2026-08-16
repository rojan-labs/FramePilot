# Codex working agreements - FramePilot

> Read the root **`/AGENTS.md`** first. It is the canonical shared rule set
> (mission, architecture, commands, coverage, safety, code style, product focus,
> Definition of Done).
> This file is the short Codex-specific checklist.
> Codex subagents are maintained in **`.agents/agents/codex/`** and exposed through
> the **`.codex/agents`** adapter.

## Always

- **Read `.agents/rules/product-discipline.mdc` before non-trivial feature,
  architecture, or plan expansion.** Protect the raw-footage-to-finished-edit loop
  before adding professional-editor breadth or generalized infrastructure.
- For major scope expansion, use the `product-scope-reviewer` agent and identify:
  user outcome, current gap, minimum vertical slice, reuse, deferred scope, and evidence.
- **Run the affected tests after every edit.** Before declaring done: `pnpm verify`
  (typecheck + lint + test + engine:test) and add e2e for critical flows.
- **Update tests with any behavior change.** Cover the core deterministic modules
  meaningfully (timeline ops, patch validator, AI tool schemas, render validation) -
  behavior and error paths, not a coverage percentage. No vanity coverage.
- **Update `plan/PLAN.md`** (mark `[~]`→`[x]` only when tested; add discovered tasks)
  and **`docs/` + `CHANGELOG.md`** as required by the shared rules.
- Prefer **small vertical slices** over broad backend-only foundations or large rewrites.
  Conventional Commits.
- Judge major AI/editing work by the resulting timeline and rendered output, not the
  number of tools, agents, plans, abstractions, or infrastructure pieces added.

## Never

- ❌ Bypass, skip, or delete a failing test to go green.
- ❌ Change the timeline/project schema without a **migration** + version bump + docs.
- ❌ Add a dependency without a **license check** (`pnpm license:scan`).
- ❌ Let the AI mutate `project.fp.json` directly. AI edits via registered,
  schema-validated tools and returns **reversible patches**.
- ❌ Let an unvalidated timeline operation reach apply, or a render skip validation.
- ❌ Use MoviePy for the UI preview (render engine = Python; preview = HTML/canvas/proxy).
- ❌ Run arbitrary shell from the in-app agent runtime; commit secrets/media.
- ❌ Mark a schema, worker, backend, tool, placeholder UI, hardcoded demo path, ADR,
  or plan as a shipped editing capability by itself.
- ❌ Build speculative frameworks, runtimes, stores, plugin systems, provider layers,
  or generalized abstractions without a current concrete consumer or explicit maintainer decision.
- ❌ Bundle several unrelated subsystems into one mega-PR when reviewable vertical slices are possible.

## Product scope gate

Before implementation of a non-trivial feature or architecture change, answer:

1. What concrete user outcome improves?
2. What current workflow is blocked, weak, slow, unreliable, or impossible?
3. What is the smallest end-to-end implementation that proves value?
4. Which existing operations, schemas, tools, render paths, analysis, UI, and storage can be reused?
5. What adjacent scope is intentionally deferred?
6. What test, fixture, timeline result, render, or measurement proves completion?

If those answers are weak, shrink or defer the work rather than expanding architecture.
Security, data-loss prevention, correctness regressions, severe performance regressions, and
release blockers may take priority, but should remain focused.

## Flow for any AI video edit

model reasons/selects tools → schema validation → typed patch → deterministic validation →
host-authoritative apply policy → visible timeline result → render/evidence review as needed →
user can inspect and undo.

Do not reintroduce perceptual review as a mandatory write gate when deterministic validation
already authorizes a safe patch. Review can run as a reader and surface findings while the host
retains the single mutation authority.
