---
name: 'source-command-update-plan'
description: 'Run the plan-keeper workflow — read, update, and reconcile plan/PLAN.md'
---

# source-command-update-plan

Use this skill when the user asks to run the migrated source command `update-plan`.

## Command Template

Run the **plan-keeper** workflow (`.agents/skills/plan-keeper/SKILL.md`,
`.agents/rules/plan-management.mdc`). Delegate to the `plan-keeper` subagent for larger reconciliations.

1. Read `plan/PLAN.md`. Respect the build order (timeline + patch engine → render +
   validation → AI → compositing → agent mode).
2. Update task status: `[~]` when started, `[x]` ONLY when the Definition of Done is met and
   tests pass (never check off untested work), `[!]` for blocked with a one-line reason.
3. Add any newly discovered tasks. Create a new plan doc under `plan/` for large sub-areas
   and link it.
4. Update the "Status snapshot" line and the "Last updated" date.
5. Reconcile: if code and plan disagree, fix the plan to match reality and note it.
