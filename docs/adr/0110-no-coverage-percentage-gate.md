# ADR 0110: No coverage-percentage gate

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

Since the first phase, the repo enforced **100% coverage on the core deterministic
modules** (PRD §16.1): timeline operations, the patch validator, AI tool schemas, and
render validation. The rule lived in two kinds of places — the working agreements
(`AGENTS.md` §5, `CLAUDE.md`, `.codex/AGENTS.md`, `.agents/rules/testing.mdc`, the agent
and skill files, the release checklists, the PR template) and as real gates:
`thresholds: { statements/branches/functions/lines: 100 }` in the Vitest configs of
`editor-core`, `ai-sdk`, and `mcp-server`.

The rule did its job while the engine was small and every module in those packages was
genuinely pure logic. It stopped paying for itself as the packages grew:

- `ai-sdk` is now ~34k LOC of orchestration. Holding the *whole package* to 100% meant
  the exclusion list (`providers/index.ts`, type-only modules, barrels, fixtures) became
  the real policy — the number said 100% while what it measured was negotiated.
- A hard threshold makes the **cheapest** way to go green a test that executes a line
  rather than one that proves a behavior. That is exactly the "vanity coverage" the same
  documents forbid — the gate and the intent pulled in opposite directions.
- Defensive branches (unreachable-by-construction guards, environment glue) had to be
  either contorted into tests or excluded, and exclusion is invisible in the report.

The invariants that actually protect this product are not coverage-shaped: every
operation is reversible and tests `apply` **and** `invert`; nothing unvalidated reaches
`apply`; no render change ships without a golden-test update; no schema change ships
without a migration. Those remain blocking.

## Decision

**There is no coverage percentage to hit, anywhere.** The `thresholds` blocks are removed
from the three Vitest configs, and the 100% rule is removed from the working agreements,
rules, skills, agent definitions, guides, runbooks, release checklists, and the PR
template. "No coverage drop" is likewise no longer a blocking rule.

Coverage is still **collected and reported** (`pnpm test:coverage`, `pnpm engine:test:cov`)
— as a diagnostic for finding untested behavior, not as a gate.

What replaces it, in the same documents: cover the core deterministic modules
**meaningfully** — every behavior branch and every user-reachable error path, exercised
through real workflows. `apply` + `invert` round-trips stay mandatory. Skipped tests still
need a linked issue.

## Consequences

- A PR can no longer be blocked by a percentage, so review carries the weight: the
  question at review time is "is the new behavior tested?", not "did the number hold?".
- Coverage on the previously-gated packages will drift below 100%. That is expected and
  is not, by itself, a regression signal.
- Historical records (`CHANGELOG.md`, earlier ADRs, `plan/PLAN.md`) still state that
  modules were at 100% coverage. Those are accurate as of when they were written and are
  deliberately left untouched; they no longer describe a standing requirement.
- The Vitest `coverage.exclude` lists are kept — without a threshold they only shape the
  report, and they still document which files carry no logic worth measuring.
