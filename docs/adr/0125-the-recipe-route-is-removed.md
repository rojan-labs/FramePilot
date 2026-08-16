# ADR 0125 — The recipe route is removed

- **Status:** Accepted
- **Date:** 2026-08-16
- **Supersedes / relates to:** ADR 0055 (model-routed commands), ADR 0081 (causal
  completion), plan/AI-ORCHESTRATION-REDESIGN.md §8.2 ("a recipe *is* a plan")

## Context

The redesign gave FramePilot a deterministic **recipe** path: seven promoted
slash-commands (`remove_silence`, `add_captions`, `improve_pacing`, `add_hook`,
`punch_in`, `export_reels`, `filler_cleanup`), each a pure function from params to plan
steps, compiled to the same Task DAG the planner produces and run with **zero model
calls**. On top of it sat *saved workflows*: "save this run as a recipe", a named
`RecipeRequest` that a future command could match by trigger text and replay for free.

The promise was that the system gets cheaper and more deterministic the more it is taught.

What actually happened is that the hard part was never the execution — it was the
**decision**. A template can only do the request it was written for, so something has to
judge whether this request is that request, and that judgement was wrong in the expensive
direction:

- The original keyword router hijacked any command that merely mentioned a template's
  topic plus an action word. "Add an **intro** with advanced keyframes" was routed to
  `add_hook`, which did none of the keyframe work and reported **"No changes were made…
  Instant · no AI needed"** — a success phrase over a request that was never read. ADR
  0055 replaced the router with a model classifier precisely because of this failure.
- The classifier made the call better, not sound. It still had to decide "does this fixed
  template fully satisfy this sentence?", and a partial match still ran the template.
- Saved workflows made it worse where they fired, because an exact trigger match bypassed
  classification entirely and ran the user's frozen params against a project that had
  moved on.

Meanwhile the agent loop got good enough to do all seven of those jobs from the actual
request, with the same validated operations, the same verification battery (ADR 0081's
causal completion, `critic.ts#critique`), and evidence it gathers itself.

So the recipe path stopped being a cheaper way to do the work and became a *second, worse*
way to decide what the work is.

## Decision

Remove the recipe route end to end:

- the `recipe` classification route, its prompt catalog, and its parsed fields;
- `compileRecipe`, `RECIPE_NAMES`, `RecipeName`/`RecipeRequest`, and the seven recipe
  synthesizers in `plan-compiler.ts`;
- `recipe-executor.ts` and `Orchestrator.streamRecipe`;
- the legacy keyword router (`kernel/router.ts`), whose only remaining purpose was
  producing recipe decisions;
- saved workflows: `workflow-memory.ts`, the "Save as recipe" menu item, and the
  Settings → Memory shelf;
- the `recipe` mode and `recipeRequest` payload from the IPC contract and the durable run
  protocol, and the `recipe` route from the editor-run lifecycle.

`recipe-leaves.ts` **stays**. Despite the name it is not recipe-specific: it is the
registry of deterministic `analysis`/`patch`/`verify` leaves that the surviving planner
path (`plan-driver.ts`) defaults to, and the shared `verify` leaf is what makes
verification parity between the planner and the agent a literal same-function-reference
claim rather than an aspiration.

## Consequences

### What changes

- Every command now reaches an execution path that reads the whole request: `chitchat`,
  `question` (read-only, and it can look — ADR 0096), `planned_edit`, or `edit`.
- A classification naming the removed route is rejected by the parser and falls back to
  `edit`, so a model working from a stale or cached contract cannot dispatch a route that
  no longer exists, and cannot end a request inert.
- Requests still carrying `recipeRequest` over IPC are a hard error rather than a silent
  drop: ignoring an instruction we will not follow is how a caller ends up believing work
  was requested that never was.

### Costs accepted

- **The zero-token path is gone.** "Remove the silences" now costs a model call. That is
  the honest price of reading the request instead of pattern-matching it, and the agent's
  own analysis tools (`analyze_silence`, …) are still deterministic and still cached
  per run.
- **Taught workflows are gone with no migration.** They were stored in `localStorage`
  under `framepilot.workflows` and are simply no longer read. Nothing is deleted from
  disk; nothing reads it. A stored workflow was a recipe name plus frozen params, and
  there is no recipe to replay it against — migrating it into a text prompt would be
  inventing an intent the user never wrote.
- **`summarizeUsage`'s "Instant · no AI needed" is now effectively unreachable.** The
  logic is kept because it is generic (`modelCalls === 0`) and correct, not because a
  route produces it today.
