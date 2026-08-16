# ADR 0043 — Tier-routing settings UI, promoted recipes, and the cost meter

- **Status:** Partially superseded by ADR 0078 (tier routing removed; recipes and cost meter retained)
- **Date:** 2026-07-07
- **Plan:** `plan/AI-ORCHESTRATION-REDESIGN.md` (§8.2 recipes, §19 cost) · `plan/PLAN.md` Phase K4.2–K4.3

## Context

Phase K3.3 introduced **model-tier routing** as an env-only seam
(`resolveTierRouting`, `FRAMEPILOT_TIER_{SMALL,MID,LARGE}_{PROVIDER,MODEL}`) and
K4.1 shipped the deterministic `CommandRouter` with two recipes
(`remove_silence`, `add_captions`). Three gaps remained before Phase K4 was
complete:

1. **Tier routing was invisible to users.** Retuning which model a tier uses —
   the primary cost/quality lever (§19.7) — required setting environment
   variables. A desktop user has no shell to export them into.
2. **Most professional-editing verbs still had no recipe**, so they took the LLM
   path even though they are deterministic (`improve_pacing`, `add_hook`,
   `punch_in`, `export_reels`).
3. **The cost meter (§19) did not exist.** The scheduler enforced task and token
   caps but had no dollar axis, and nothing priced a model call by its tier — so
   "reserve the frontier tier, the cost meter enforces the budget" was aspirational.

## Decision

### 1. Tier routing is a settings seam, configurable in the UI

`resolveTierRouting(overrides, defaults)` gains a first-class **settings** layer
that sits **above** the env layer: `in-app setting > env > compiled-in default`,
resolved independently per field (a model swap keeps the env/default provider; an
unrecognised provider is ignored, never a crash). `AiConfig.tierRouting` (fully
projected) and `AiConfigUpdate.tierRouting` (partial override) thread a per-tier
`{provider, model}` through **both** config stores — browser `localStorage` and
the desktop `ai-config.json` — each persisting only the user's overrides (so an
evolving default still applies) and projecting the full map via
`resolveTierRouting`. Settings → AI gains a **Model tiers** group: one `TierRow`
(provider `Select` + model input) per tier, writing through `useAiConfig.setTier`.

The value is **persisted and projected today but not yet consumed at dispatch** —
tier routing flows into a live run only once the router→recipe/plan path is wired
through the Conductor/driver (K5/K6). This is the same seam-first discipline used
for the router and scheduler: build the pure, tested seam ahead of its wiring.

### 2. Four more recipes, still zero-model

`plan-compiler.ts` promotes four slash-commands to deterministic `params → steps`
functions that compile to the same `TaskGraph` a Planner plan does:

- `improve_pacing` — two **parallel** analyses (silence via ffmpeg, pacing
  diagnosis pure) fan into `synth → patch → verify` (5 nodes). The parallel
  fan-in is the scheduler win.
- `add_hook` — `find_hook → restructure → patch → verify` (4 nodes, linear).
- `punch_in` — `synth-keyframes → patch → verify` (3 nodes), reusing the
  deterministic punch-in keyframe generation.
- `export_reels` — `export_video → verify` (2 nodes), a `render`-resource DAG
  with **no patch node** (an export is not an edit).

Each gains a `routeCommand` signature (topic + action regex + param extraction:
pacing aggressiveness, punch zoom `1.5x`, export preset 9:16/1:1/16:9). Ordering
matters where topics overlap — `punch_in` is checked before `improve_pacing` so
"punch in the slow parts" claims the dedicated recipe.

### 3. The cost meter prices tiers; the scheduler enforces dollars

A new pure `kernel/cost-meter.ts` owns **pricing and tallying only**:
`estimateUsd(tier, usage, prices?)` prices a call per million input/output
tokens; `recordCost` folds a call into an immutable `CostLedger` (tokens, USD,
calls — overall and per tier); `tierUsdShare` reports where the spend went (the
observable that shows routing is working). `DEFAULT_TIER_PRICING` keeps the
large≈15×small ratio that makes routing a real lever; the table is a settings
argument, not a constant.

The **Scheduler** owns **enforcement**: `Budget.maxUsd` +
`SchedulerState.usdSpent`, accrued through `onTaskCompleted({tokens, usd})`. The
driver bridges the two — it prices a completed model call via the meter, then
folds the spend into the scheduler, which stops dispatching new work once any cap
(tasks/tokens/USD) is reached while in-flight work drains. Pricing stays
pure/replayable (same recorded usage → same ledger).

## Consequences

- **Positive.** Users retune the cost lever without a shell. Six recipes now take
  the zero-token path. The cost meter closes §19's dollar axis with a clean
  pricing/enforcement split (cost-meter = brain, scheduler = teeth). All touched
  kernel modules stay at 100% coverage; ai-sdk 686 tests, web-editor 754, desktop
  182 green.
- **Deferred.** Tier routing, the promoted recipes, and the cost meter are pure
  seams **not yet dispatched through the Conductor** — that wiring (and threading
  the resolved tier routing + price table into live runs) is K5/K6. The
  per-tier price table is tier-based, not model-id-specific; a model-level table
  can layer on later if accuracy demands it.
  **Update (2026-07-10, plan P7.1):** the cost meter IS now dispatched on every
  live recipe/planned-edit run — `graph-executor.ts`'s `GraphRunResult.cost` folds
  through `scheduler.onTaskCompleted`, priced via this ADR's `estimateUsd`. See
  `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P7.1.
- **No schema change, no new dependency, no migration.**
