# ADR 0022 — Phase 7: full agent mode & the Critic

- **Status:** Accepted
- **Date:** 2026-06-26
- **Phase:** 7 — Full Agent Mode & Critic (PRD §7.4, §8.6)
- **Relates to:** ADR 0012 (AI layer / orchestrator), ADR 0013–0014 (web editor), the
  patch engine (Phase 1) and render validation (Phase 2.3)

## Context

Through Phase 6, the AI layer (ADR 0012) implemented `chat`, `plan`, `edit`, and
`autocomplete`. The orchestrator's `agent` and `review` modes were explicit
**Phase 7 stubs** that threw — deliberately, so we did not build autonomous editing
before the engine it depends on (timeline ops, patch validator, render validation)
existed and was tested. That engine is now complete, so Phase 7 builds the two
remaining modes on top of it:

- **Agent mode (PRD §7.4):** execute a multi-step editing goal — plan, call tools,
  verify, produce a timeline diff, log every action.
- **Critic / Review agent (PRD §8.6):** after the agent edits, check the result
  against the request, duration target, caption alignment, safe area, audio
  clipping, black frames, missing assets, and export settings.

Two hard constraints shaped the design:

1. **The five invariants still hold.** The AI never produces a raw mutation; every
   edit is a registered tool call → typed `Operation` → validated, reversible
   `Patch`. Agent mode must not become a back door around the tool boundary.
2. **A reviewer must be trustworthy and reproducible.** The same project must always
   yield the same verdict, and a misbehaving model must not be able to talk the
   Critic into approving a broken edit.

## Decision

### 1. The Critic is pure, deterministic, and LLM-free (`packages/ai-sdk/critic.ts`)

`critique(project, options) → CritiqueReport` runs a fixed battery of the eight
PRD §8.6 checks, each a small single-responsibility function over the timeline:

| Check               | How                                                                     |
| ------------------- | ----------------------------------------------------------------------- | ------------------------- | -------------------------------- |
| `request_match`     | Did the run produce applied changes? (`producedChanges`)                |
| `duration_target`   | `                                                                       | timelineDuration − target | ` within tolerance (default ±2s) |
| `caption_alignment` | Captions sit within the **content** duration (video/audio), not past it |
| `safe_area`         | Positioned (normalized x/y) overlays/captions stay inside a 10% inset   |
| `audio_clipping`    | From the render validator (skipped without a render)                    |
| `black_frames`      | From the render validator (skipped without a render)                    |
| `missing_assets`    | Every clip references a known asset or an engine sentinel               |
| `export_settings`   | Aspect/orientation suits the target platform                            |

Each check reports `pass` / `warn` / `fail` / `skipped`; the report's `ok` is false
only on a `fail` (warnings inform, they don't block). **Black-frame and audio-clipping
detection genuinely need pixels and samples** that only the Python render engine can
produce — so the Critic accepts an optional `RenderValidationInput` (the result of the
existing `validate_render` pass on an auto preview render) and reports `skipped` when
no render was run rather than fabricating a pass. This keeps the build-order honesty
rule (no faked capability) and the render-vs-preview rule (the Critic does not render;
the host does and feeds the result in).

### 2. Agent mode is a tool-calling loop on the orchestrator (the sole assembler)

`Orchestrator.agent(input, options) → AgentRun` runs a bounded loop:

1. Build per-turn context from the **working** project (so the model sees the
   evolving state) plus an agent instruction and the running action log.
2. Ask the provider for tool calls. Each turn's calls are classified:
   - **read** → executed, the result fed back into the next turn's context (log);
   - **action** (`render_preview`/`export_video`) → logged as a request only — the
     orchestrator never renders;
   - **mutate** → turned into typed `Operation`s via the existing `operationsFor`
     gate, assembled into a validated patch, and applied to a **working copy**.
3. The loop terminates when the model stops calling tools, when a turn makes **no
   progress** (an invalid edit, or a repeated patch id — the model going in circles),
   or at a step cap (default 8, a safety backstop).
4. The run returns: the ordered **step log** (PRD "log all actions"), a **combined**
   `EditResult` (all applied operations bundled into one patch, diffed against the
   original timeline), and a **self-check** `CritiqueReport`.

Crucially, the run is **not auto-applied**. It is reviewable; the human approves it
(AGENTS.md invariant 4). Because the whole run commits as a single reversible patch,
applying it is **one-click-revertible** — a single Undo reverts the entire agent edit.

A problem inside the loop (unknown/unavailable/invalid-args/validator rejection) is
**recovered** — logged and fed back — rather than thrown, so one bad tool call never
aborts the whole run. (Contrast `edit` mode, which still throws so a single Cmd+K
surfaces the error directly.)

### 3. `review` mode wraps the Critic (`Orchestrator.review`)

`review(input, options) → { text, report }` runs the deterministic Critic over the
project as-is and returns a human-readable block plus the structured report. It needs
no model call.

### 4. Project-memory learning + style presets

- **Learning:** agent runs read project memory through the existing context builder
  (so previously **rejected** edits are surfaced and avoided), and Apply/Reject record
  the combined patch via `recordAccepted`/`recordRejected` — no new store.
- **Style presets (`packages/ai-sdk/style-presets.ts`):** named, deterministic
  bundles (Clean SaaS demo, High-energy Reel, Talking-head explainer). `applyStylePreset`
  seeds the existing `ProjectMemory` preferences + export platform (no schema change)
  and pre-fills the agent goal.

### 5. Web editor (`apps/web-editor`)

The AI panel's Agent mode is now live: a **style-preset** selector, a **Run agent**
action, and an **agent-run review** showing the goal, the self-check report (per-check
badges), a collapsible step log, and the combined edit with **Apply all** / **Reject**.
Apply commits the single combined patch through the same `useEditor`
validate→apply→record path, so Undo reverts the whole run.

Agent mode runs the loop **locally in the renderer** via the offline `mock` provider
(no network, works in the sandbox). Driving agent mode through a real provider over
IPC — mirroring the existing chat/plan/edit channels — is a Phase 8 follow-up; it is
deliberately not added here to avoid broadening the desktop IPC surface (CLAUDE.md §5).

## Consequences

- **No schema change, no migration, no new dependency.** Everything sits on the
  existing tool registry, patch engine, memory field, and render validator.
- The orchestrator remains the **sole** patch assembler; agent mode reuses the same
  `operationsFor` → `assembleEdit` gate as `edit`.
- The Critic is reusable standalone (a "review this edit" affordance) because it is a
  pure function, not an LLM prompt.
- `critic.ts` and `style-presets.ts` are at 100% coverage; the orchestrator stays at
  100%. `agent.ts` is type-only (excluded from coverage like the other type modules).

## Deferred (tracked in `plan/PLAN.md` Phase 8)

- **Agent mode over IPC with a real provider** (the loop runs locally with the mock today).
- **Auto preview render inside the web Review UX** — gated on the renderer→engine
  export/preview channel; the Critic already consumes a `validate_render` result when
  one is supplied.
- **Richer request-match** (semantic match of result to the natural-language request)
  would need an LLM judge; the deterministic heuristic ships now.
