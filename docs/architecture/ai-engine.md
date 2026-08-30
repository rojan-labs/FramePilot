# AI Engine

The AI engine turns natural-language requests into **reviewable, reversible timeline
patches**. It sits _on top of_ the timeline & patch engine
([timeline-and-patch-engine.md](timeline-and-patch-engine.md)) and is built only after
that foundation exists (Phase 4, see [`../../plan/PLAN.md`](../../plan/PLAN.md)).

**The cardinal rule:** the AI may only edit through **registered, schema-validated
tools**, and those tools return **patches** — never direct mutations of the project
JSON (PRD §8.3–§8.4). This is what keeps AI edits as safe as manual ones.

Code lives in `packages/ai-sdk` (provider clients, orchestrator) and
`engine/python/.../ai_tools` (engine-side tools).

> **Orchestration runtime (2026-08-06, ADR 0102).** The agent loop is driven by a
> LangGraph `StateGraph` — `kernel/agent-graph.ts`, one named node per effect kind. The
> Conductor referred to throughout this document is the **pure reducer**, which is
> unchanged and still owns every run decision; the graph nodes call it. `runConductor` and
> `kernel/driver.ts` were deleted at M12 (ADR 0103).

> **Implementation status (2026-07-23).** All core modes, the streaming event model,
> provider resilience, host analysis, Conductor, recipes, task-graph scheduler,
> semantic index, checkpoints, questions, and Critic are implemented. The architecture
> review found that these are not yet one production runtime: desktop main,
> renderer-local recipes, and the planner/DAG path have different capabilities and
> control wiring. The consolidation target is
> [Orchestration Execution Engine](orchestration-execution-engine.md), the evidence is
> in the [architecture review](../reports/2026-07-23-orchestration-workspace-architecture-review.md),
> and delivery is tracked in
> [`plan/ORCHESTRATION-FOUNDATION-INITIATIVE.md`](../../plan/ORCHESTRATION-FOUNDATION-INITIATIVE.md).

---

## 1. Components (PRD §8.1)

```
AI Orchestrator ── chooses mode, builds context, calls tools, validates, returns diff
Tool Registry  ── the only surface the AI can act through (tools return patches)
Timeline Patch Engine ── applies/validates/diffs/reverts patches (see its own doc)
Context Builder ── assembles transcript, timeline, metadata, selection, platform
Memory Store   ── per-project memory (style, pacing, accepted/rejected edits)
Plan Generator ── produces structured multi-step edit plans
Patch Validator ── pre-apply safety gate (PRD §8.5)
Render Preview Worker ── fast low-res preview of a proposed/applied patch
Critic / Review Agent ── post-edit checks against the request (PRD §8.6)
```

---

## 2. Orchestrator modes (PRD §8.2)

The orchestrator selects one of six modes per request:

| Mode           | Purpose                                                                         | Mutates timeline?          | Renders?            |
| -------------- | ------------------------------------------------------------------------------- | -------------------------- | ------------------- |
| `chat`         | Q&A over the video/timeline ("why does this feel slow?")                        | No                         | No                  |
| `plan`         | Produce a structured edit plan, no mutation, no render                          | No                         | No                  |
| `edit`         | Cmd+K: turn a selection + prompt into a small reviewable patch                  | Via patch (after approval) | Preview             |
| `agent`        | Execute a multi-step goal (plan → approve → execute → verify)                   | Via patches                | Preview             |
| `autocomplete` | Suggest the next-best edit on triggers (playhead stop, selection, long silence) | Via patch (on accept)      | Optional            |
| `review`       | Run the Critic over the current/proposed state                                  | No                         | May render to check |

The sidebar's `auto` entry point first classifies the command into one of three routes:
`chitchat`, `question` (read-only, may still LOOK), and `edit`. **Every** project change —
simple, creative, multi-step, or analysis-dependent — takes the `edit` route into the agent.

There is exactly one mutating AI runtime (ADR 0126). Analysis-dependent work is not a
separate route: beat synchronization is the agent calling `detect_beats` and footage
analysis, reading the evidence, and then assembling `add_clip` operations that are validated
and returned as one reversible patch. The earlier `planned_edit` route ran that same work
through a second execution universe (intent parser → planner → task graph → scheduler); it
was retired after a parity harness showed it carried no unique capability, cost no fewer
model calls, and dispatched Planner-authored arguments to the host analysis engine without a
schema check. After tool
schema parsing, the complete typed operation batch is validated against the working
timeline, asset set, and folders before the proposal task may complete. Invalid references,
overlaps, or ranges receive bounded, actionable correction feedback; dependent assembly and
verification never run on a semantically invalid proposal. Assembly repeats validation as
defense in depth. See [ADR 0084](../adr/0084-project-semantic-proposal-boundary.md).

For multi-stage plans, each downstream task receives an immutable project projection built
from its validated ancestor assemblies. This makes in-run clip ids available to later
transition, grade, and keyframe proposals. Compilation repairs an incomplete model-authored
tail by adding final assembly and verification nodes that cover every mutation. If a later
refinement after a verified checkpoint exhausts its bounded proposal attempts, the task
emits a visible warning and the validated earlier edit still reaches final verification;
mutations without that checkpoint remain fail-closed. See
[ADR 0085](../adr/0085-multi-stage-planned-edit-continuity.md) (superseded for the retired
planned-edit route by [ADR 0126](../adr/0126-one-mutating-ai-runtime.md); its continuity
requirements now apply to the agent runtime).

The planner receives the exact effect kind/name pairs its driver can execute. If its
intent or graph is malformed or outside that bounded contract, auto mode carries the same
request, controls, cancellation signal, and accumulated usage into the general agent path
instead of ending with an inert planner error. Whole-project semantic slices are bounded
with deterministic beginning/middle/end sampling, so multi-hour timelines do not become
unbounded prompts or silently collapse to only the opening footage.

Orchestrator responsibilities (PRD §8.2): receive request → build context → choose mode
→ call planner → call tools → validate operations → return diff → trigger preview →
store learning log.

### Unified editor-run lifecycle

Every timeline-mutating host now enters through `streamEditorRun`, regardless of whether routing
selected single-shot `edit` or `agent` execution. The existing `AiEvent` stream remains the
UI/presentation contract. A separate optional lifecycle observer receives serialisable, strictly
sequenced stage events for understand → resolve → inspect → plan → compile → execute → verify →
review → finalize. Repair is the only legal re-entry stage.

During route convergence, `EditorRunLifecycleProjector` maps meaningful legacy events into that
side channel and records route-policy evidence for intervening stages. It never inserts lifecycle
records into the UI stream, so stage durability can evolve without changing conversation rendering
or golden-session output. Completed runs end in `finalize`; failed and cancelled runs settle their
active stage with a reason and do not fabricate finalization. Replaying the stage log through the
pure reducer must reconstruct the same terminal snapshot.

The observer is a transport seam, not durable storage by itself. Electron main binds it to the
existing authoritative run WAL as `run.editor_lifecycle`, ordered in the same per-run lane as
`run.stream_event`. Recovery validates the stage payload and advances the snapshot cursor without
injecting it into conversation rendering. The host waits for all queued stage writes before terminal
settlement. Desktop modes use this same main-process path; none has a renderer-local
execution exception. Browser edit, agent, and routed-auto mutations also always install the
lifecycle and temporal-review controls. If its sidecar is not
configured, the run ends failed with an explicitly unverified proposal for manual review rather
than bypassing the gate.

Desktop auto-commit requires a positive `verified` disposition on the diff. `unverified` and legacy
missing dispositions remain proposed even when the run was pre-authorized for auto-commit.
Browser-local durable lifecycle storage and MCP projection onto the same policy remain tracked work
in P1.1.

### Exact analysis handoff and loop recovery

Analysis results that directly determine edit points are executable inputs, not prose
summaries. In particular, `detect_beats` passes every observed onset to the agent in a
compact times-only digest. BPM is an average and must not be used to reconstruct missing
timestamps from a non-uniform grid.

Successful reads and analyses are memoized for the run. If a turn only repeats those
memoized calls and no edit has landed, the Conductor grants one action-recovery turn:
read/analysis descriptors are withheld, leaving mutation tools and `ask_user`. This
prevents another redundant tool cycle while preserving an honest escape when a real
creative decision is missing. A second failure converges normally; recovery is bounded.
See [ADR 0068](../adr/0068-action-recovery-after-cached-reads.md).

A refused call is remembered, and a call the run can PROVE will be refused again is not
made twice. Two records back this. First, the run's operation ledger records a change the
per-call validator refused as a `failed` operation with the validator's reason, so the
state briefing shows it under "FAILED — fix the cause, do not retry unchanged"; before
this, a per-call rejection returned zero operations out of band and was never written
down, so a run could accumulate hundreds of refused operations against a ledger of nothing
but successes. Second, the Conductor banks a `name:cause` key for every DETERMINISTIC
refusal — schema validation of the arguments, or the per-call validator probe — and a
later call that settles to a key already banked is replaced with an actionable refusal
naming the error and the ways out. The key is the CAUSE, not the arguments: the operation
locator (`op 12 of 63`) is stripped, because the same defect reported at a different
position is the same defect. Host, executor and transport failures are never banked —
those are transient, and a permanent block on one would refuse work that would have
succeeded. Any applied edit clears the banked keys, since a validator verdict describes
the arrangement it was shown.

The visible plan ledger is evidence-based: read-only turns can gather prerequisites but
cannot check off an edit step. A no-tool response cannot end a run while that committed
ledger still has pending work: the Conductor grants one bounded mutation-only continuation
focused on the first incomplete deliverable. Completion requires a validated applied patch,
a reconciled plan, and passing deterministic Critic checks. Explicit whole-output durations
in the creator's request become Critic acceptance criteria automatically. See
[ADR 0087](../adr/0087-objective-complete-agent-runs-and-stable-chat-surface.md).

### Live editor snapshot for read tools

The media bin and timeline render from the patch-engine-backed editor store. Project
persistence is asynchronous, so an app-level project prop can briefly lag behind a newly
imported asset that is already visible. Every AI turn therefore captures timeline, assets,
folders, markers, and transcript from the live editor store at submission time. Desktop
main re-validates that document and refreshes its in-memory authority only after the
project-id and optimistic-revision checks pass. Consequently `list_assets` observes the
same bin the user sees; it cannot silently fall back to an older empty persistence snapshot.

---

## 3. Tool registry contract (PRD §8.3)

The full contract and the table of every core tool are in
[../api/ai-tools.md](../api/ai-tools.md). Key invariants:

- The AI can **only** call registered tools — no arbitrary code, no shell, no direct file
  writes (PRD §18.2).
- Tool inputs are **schema-validated** before execution.
- **Read tools** return state (e.g. `get_timeline`, `get_transcript`,
  `get_selected_range`). `analyze_silence` and `detect_scenes` are **analysis** tools —
  ffmpeg-backed reads the engine sidecar executes — and both have shipped. The only tool
  still `available: false` is `generate_mask`, and not for want of a model: segmentation
  yields a bitmap while timeline masks steer by rectangle bounds.
- **Write tools** return typed **operations** that the orchestrator assembles into a
  **patch** (e.g. `trim_clip`, `delete_range`, `add_caption_layer`, `add_keyframes`),
  which then flows through validate → diff → preview → apply. The provider never returns
  a patch and tools never mutate the project directly — the orchestrator is the sole
  patch assembler (the structural enforcement of the tool boundary; see ADR 0012).
- Every write tool's operation must be **reversible** and **tested** (see
  [../guides/adding-a-timeline-operation.md](../guides/adding-a-timeline-operation.md)).

---

## 4. Context Builder

Before calling a provider, the Context Builder assembles only what the request needs
(token-budgeted by `FRAMEPILOT_AI_MAX_TOKENS`): transcript (word-level timestamps),
timeline state, clip metadata, current selected range, scene boundaries, audio waveform
summaries, frame analysis, and target platform. Keeping context construction explicit and
testable avoids the "the model saw something we can't reproduce" class of bugs.

Each streamed model request also emits a `context_usage` event. It carries the configured
context window and prompt occupancy: the exact request payload is estimated immediately
(including tool schemas), then replaced by the provider's real input-token count when
available. The event is append-only telemetry and never creates a conversation row. The
AI sidebar binds its composer figure to the first substantive request of the latest user
turn. That request can move from a local estimate to provider-reported usage, but later
classifier, planner, tool, and repair calls do not replace it. Aggregate run cost remains a
separate `usage` event because summing calls and measuring one stable request window are
different quantities.

The provider selected in Settings owns the complete request, including classification,
planning, composition, and bounded repair. Internal cost-class labels never select a
different provider or model. This keeps credentials, capability negotiation, cancellation,
and retry behavior stable across the run; see [ADR 0078](../adr/0078-context-visibility-and-provider-continuity.md).

### Model instruction hierarchy

Prompt assembly follows a responsibility hierarchy
([ADR 0077](../adr/0077-layered-prompt-and-editing-knowledge-architecture.md)):

1. A stable system prefix carries identity and the five non-negotiable editing
   invariants—no workflow or craft advice.
2. The project context and user request are followed by a mode contract that defines
   whether the turn answers, plans, edits, or runs autonomously.
3. Agent runs use a trailing instruction message whose run-stable head contains the
   execution contract, committed plan, and skill bodies loaded once and pinned for that
   run. The head is rebuilt only when the plan identity or loaded-skill ledger changes.
4. After that head, a stage-aware working-state briefing records established facts,
   decisions, applied work, failures, verification, blockers, and the next action. Any
   steering/recovery instruction and the bounded action log follow it.

This order lets a long run continue from its current stage instead of re-reading the
project after every tool result. The global agent contract still owns behavioral rails
whose failure could make an edit unsafe or falsely complete: continuity/no-restart,
evidence grounding, source↔sequence timing, tool recovery, dependency order, and
applied-versus-verified claims. Editing psychology, technique, heuristics, and quality
standards live in bundled skill modules; see
[Authoring skills](../guides/authoring-skills.md).

The working-state briefing is agent-only and is omitted until the run has established
state; chat and edit modes do not receive bundled skills unless their caller opts in.
The ordinary context budget covers the skills manifest, but pinned bodies sit in the
agent's trailing instruction and are bounded separately: at most eight bodies per run,
with every bundled module tested below 8,000 characters. These are context controls, not
dynamic tool permissions—a skill's `tools` frontmatter remains descriptive in v1.

---

## 5. Memory Store (PRD §8.7)

Per-project memory lets the agent learn within a project without any cloud state:

- target audience, brand style, caption style, preferred pacing, export platforms,
- previously **accepted** edits and previously **rejected** edits.

Example learned facts: "User prefers bold captions with yellow keyword highlight," "User
rejects aggressive zooms," "User wants a clean SaaS-demo style." Memory is stored in
`project.aiMemory` (local-first; see [overview.md](overview.md) §6).

---

## 6. Plan Generator

For `plan` and `agent` modes, the Plan Generator produces a structured, human-readable
edit plan (e.g. "use 00:08–00:13 as the hook; remove intro silence; add captions; add
zooms on UI clicks; add CTA"). In plan mode this is the _final_ output — **no mutation,
no render**. In agent mode the plan becomes the script the tool-calling loop executes,
step by step, each step producing a validated patch.

---

## 7. Critic / Review Agent (PRD §8.6)

After agent edits (and on demand in `review` mode), the Critic checks the result against
intent:

- did the output **match the user request**?
- does the **duration match the target**?
- are **captions aligned**?
- are overlays inside the **safe area**?
- is **audio clipping**?
- are there **black frames** or **missing assets**?
- are **export settings** correct?

The Critic consumes render-validation output ([render-engine.md](render-engine.md) §
render validation) and can recommend follow-up patches. Deterministic checks alone own
the correctness verdict. An optional model pass may add subjective observations about
hook, rhythm, or goal fit, but those observations are advisory and cannot turn an
unverified timeline or render into a pass.

---

## 8. Multi-provider clients

The provider layer abstracts three backends behind one interface (PRD env config; see
[ADR 0005](../adr/0005-multi-provider-ai-anthropic-nvidia.md)):

- **Anthropic (Claude)** — `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`. Calls the Messages
  API directly via `fetch` (no vendor SDK; see ADR 0012).
- **NVIDIA NIM** — OpenAI-compatible endpoint, `NVIDIA_API_KEY` / `NVIDIA_MODEL` /
  `NVIDIA_BASE_URL`. Calls `/chat/completions` directly via `fetch`.
- **mock** — deterministic canned **tool calls** (assembled into a patch by the
  orchestrator) for offline dev and tests (the default in `.env.example`).

Each provider returns tool calls, never a patch; `fetch` is injected so the adapters are
unit-tested offline.

The active provider is chosen by `FRAMEPILOT_AI_PROVIDER`. The mock provider is what lets
the AI layer be tested deterministically in CI without network access. See
[../guides/ai-providers.md](../guides/ai-providers.md) for configuration and for how to
add a new provider.
