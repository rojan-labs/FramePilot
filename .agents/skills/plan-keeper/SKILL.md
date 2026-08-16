# Skill: Plan Keeper

Read and maintain `plan/PLAN.md` (the single source of truth for execution) and any
sub-plans under `plan/`, while enforcing FramePilot's product-scope discipline.

Read `.agents/rules/product-discipline.mdc` and `.agents/rules/plan-management.mdc`
before changing plan scope.

## When to use

- Before starting any unit of work, and after finishing it.
- Whenever you discover new work, hit a blocker, or notice the plan drifting from reality.
- Before creating a large sub-plan or promoting adjacent professional-editor work into active scope.

## Rules / steps

1. **Read `plan/PLAN.md` first.** Note the current phase and the build order (timeline + patch engine → render + validation → AI → compositing → agent mode).
2. **Run the product scope gate for non-trivial feature/architecture work.** Record the user outcome, current gap, minimum vertical slice, existing systems to reuse, intentionally deferred scope, and evidence required for completion.
3. **Find or add your task.** If it isn't listed, add it as `[ ]` in the correct phase.
4. **Mark `[~]`** when you start; **`[x]`** only when the Definition of Done is met and the applicable verification passes. **Never check off untested or unverified work.** Use `[!]` for blocked, with a one-line reason.
5. **Do not equate infrastructure with a shipped capability.** A schema, worker, backend, tool, placeholder UI, hardcoded demo path, ADR, or plan is not enough to mark an editing capability complete.
6. **Add discovered tasks deliberately.** Record adjacent opportunities, but keep them deferred unless they are required for the current vertical slice or explicitly selected by the maintainer.
7. **Create new plan docs** under `plan/` only for justified large sub-areas and link them from `PLAN.md`. Every sub-plan must identify a near-term executable vertical slice.
8. **Keep plan detail proportional to risk and uncertainty.** Documentation volume is not implementation progress.
9. **Keep the snapshot current** - update the "Status snapshot" line and "Last updated" date.
10. **Reconcile** - if code state and the plan disagree, fix the plan to match reality and note it. Reopen a capability that was marked complete if its real UI/preview/render/AI path is not usable.
11. **Preserve maintainer decisions.** If the maintainer explicitly chose broader scope, record the rationale so later agents do not repeatedly reopen the decision.

## Legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

## Definition of done

- The plan reflects reality: task status is accurate, discovered work is scoped honestly,
  snapshot/date are current, and nothing unverified is checked off.
- Active scope is tied to a concrete product outcome or explicit maintainer decision.
- Large sub-plans lead to an executable vertical slice rather than becoming an end in themselves.
