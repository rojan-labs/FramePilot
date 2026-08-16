# ADR 0055 — Model-routed command classification (`streamAuto`)

- **Status:** Accepted
- **Date:** 2026-07-13
- **Supersedes (for the sidebar's run path):** the keyword `routeCommand` classifier
  (`packages/ai-sdk/src/kernel/router.ts`, ADR/plan K4.1) as the *primary* router for
  Agent mode. `routeCommand` is retained only for the "save last run as a workflow"
  affordance, which needs a synchronous, offline recipe-shape check.

## Context

Every AI-sidebar command in Agent mode (the default) was routed by `routeCommand` — a
pure keyword classifier: `topic-regex × action-regex → recipe`, else question → chat,
else → plan. Zero tokens, but two structural failure modes that no additional regexes
could fix without becoming brittle:

1. **Greedy recipe hijack.** A command that merely *mentioned* a recipe's topic and an
   action word was force-routed to that recipe, even when the recipe could not do what
   was asked. Real report: *"hi, on the timeline, add a intro using advanced keyframes…"*
   matched `add_hook` (topic `intro` + action `add`). `add_hook` only relocates an
   existing clip, produced no ops, and the user saw **"No changes were made — I couldn't
   turn this into an applicable timeline edit · Instant · no AI needed."** The actual
   request (keyframes, professional polish) was never read.
2. **No small-talk route.** Anything that wasn't a recipe or a `?`-question fell through
   to full planning, so a bare **"hi"** triggered the whole agent/planner.

The user's directive was explicit: handle this intelligently, *not* by adding more
if/else, and cover all cases end to end.

## Decision — classify with one small model call, inside the orchestrator

A new `Orchestrator.streamAuto` is the model-routed entry point. It makes **one**
classification call (`command-classifier.ts`: a tight system prompt + a tiny project
header, JSON reply validated by Zod) that reads the *whole* command and returns one of
four routes, then delegates to the existing sub-stream:

| route      | delegates to     | editing? |
|------------|------------------|----------|
| `chitchat` | direct reply     | no       |
| `question` | `streamChat`     | no       |
| `recipe`   | `streamRecipe`   | yes      |
| `edit`     | `streamAgent`    | yes      |

The classifier only chooses `recipe` when a recipe *genuinely* satisfies the request;
anything novel/creative/multi-step (keyframes, color, graphics, "make it professional")
routes to `edit`. When unsure it prefers `edit` — the agent can do everything a recipe
can, never the reverse. This directly closes both failure modes: the keyframe-intro
request now runs the agent, and "hi" gets a one-line reply with **no planning**.

### Why in the orchestrator (not the React sidebar)

The classification needs the provider. Putting it in `streamAuto` means it runs wherever
each surface already has provider access — the browser orchestrator and the **desktop
main process** — so desktop (the #1 surface) gets it through the existing AI stream IPC by
adding one mode value (`auto`) to `AiStreamMode`. The main-process orchestrator already
carries the sidecar `executor` (`main.ts`), so an `auto` run that classifies to a recipe
runs it in-process exactly as the browser does locally. No new IPC method, no broadened
sandbox.

### The one retained deterministic path

A command whose exact normalized text matches a **taught workflow** still dispatches that
workflow's recipe with zero tokens (checked in the sidebar before `auto`). That is an
exact, user-defined trigger — not fuzzy keyword routing — so the user's saved params win
without a classification call, and the "get cheaper as taught" property (K5.2) survives.

### Honest end-of-run reporting

An `auto` turn does not know its editing-ness until the route is picked, so the sidebar
starts it non-editing and `runOutcome.foldTurnEvent` upgrades it when an `editing`/
`planning` status streams. `streamAuto` emits a definitive `editing` status before the
recipe/edit delegation, so an edit that ultimately applies nothing still gets the honest
"nothing changed" notice, while a chitchat/question turn (which only ever reaches
`thinking`) never shows a misleading one.

## Consequences

- **Cost:** every Agent-mode command now makes one small classification call (the chosen
  trade-off — "always classify" — over a zero-token keyword table). Taught workflows and
  the explicit Chat/Edit modes still bypass it.
- **Removed nicety:** the browser-only "try the planned-edit DAG first" probe for
  novel Agent commands is gone; `edit` routes straight to the robust agent loop.
  `streamPlannedEdit` remains for its explicit callers.
- `routeCommand` and the recipe/creative-phrase tables remain only for the
  save-as-workflow shape check; they are no longer the sidebar's live router.
