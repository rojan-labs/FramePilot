---
description: Run the plan-keeper workflow - reconcile plan/PLAN.md while enforcing product scope discipline
---

Run the **plan-keeper** workflow (`.agents/skills/plan-keeper/SKILL.md`,
`.agents/rules/plan-management.mdc`, `.agents/rules/product-discipline.mdc`). Delegate to the
`plan-keeper` subagent for larger reconciliations.

1. Read `plan/PLAN.md`. Respect the build order (timeline + patch engine → render +
   validation → AI → compositing → agent mode).
2. For non-trivial feature/architecture work, confirm the task records the product scope gate:
   user outcome, current gap, minimum vertical slice, reuse, deferred scope, and evidence.
3. Update task status: `[~]` when started, `[x]` ONLY when the Definition of Done is met and
   verification passes, `[!]` for blocked with a one-line reason.
4. Do not mark an editing capability done because only its schema, backend, worker, tool,
   placeholder UI, hardcoded demo path, ADR, or plan exists.
5. Add newly discovered tasks, but keep adjacent opportunities deferred unless they are required
   for the current vertical slice or explicitly selected by the maintainer.
6. Create a new plan doc under `plan/` only when justified by product scope. It must name the
   near-term executable vertical slice it enables.
7. Update the "Status snapshot" line and the "Last updated" date.
8. Reconcile: if code and plan disagree, fix the plan to match reality and note it. Reopen
   incorrectly completed capabilities rather than preserving plan drift.
