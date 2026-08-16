# FramePilot — AI Orchestration Architecture (First-Principles Redesign)

> **2026-07-27 supersession:** ADR 0078 removes model-tier provider dispatch. The
> `small`/`mid`/`large` labels retained by this design are budgeting/telemetry metadata;
> one host-selected provider owns the full request.

> **Status:** **Accepted / graduated to [ADR 0044](../docs/adr/0044-orchestration-kernel.md)
> (2026-07-08).** Phases K0–K6 complete; this document is retained as the detailed design
> record. Remaining work is build-order-gated live recipe leaf-executors (see the Definition
> of Done), not kernel architecture. Authored as a from-scratch rethink of the AI
> orchestration engine — *not* an incremental patch of `orchestrator.ts`.
>
> **Audience:** whoever builds "the Cursor of professional video editing."
>
> **One-sentence thesis:** *Demote the LLM from controller to advisor.* Make the
> control plane a **deterministic reducer** (an OS-style kernel that owns a task
> graph, a scheduler, and an append-only event log), push every non-deterministic
> model call to the leaves as **cached, replaceable proposals**, and execute those
> proposals as **typed effects** with parallelism, cancellation, and replay. The
> application state — never the model — is the source of truth.

---

## 0. TL;DR for the impatient

The current engine (`packages/ai-sdk/src/orchestrator.ts`) is already good on the
axes most teams get wrong: event-sourced UI (`events.ts`), typed reversible patches
(`editor-core`), a disciplined typed tool registry, a host-executor seam, context
budgeting, checkpoints. **Do not throw those away.** The single structural flaw is
that `streamAgent` is a ~400-line imperative `for` loop in which the model is planner
**and** scheduler **and** executor, all sequential. That one decision cascades into
every symptom the vision doc complains about: no parallelism, tokens that grow per
turn, fake "running" states, ad-hoc recovery, and a system that *feels* like chatting
with an LLM instead of collaborating with an engine.

The redesign replaces that loop with a **four-plane kernel**:

```
DECISION   →  proposers (LLM as pure, cached advice): IntentParser · Planner · EditProposer · Critic
CONTROL    →  the Conductor: a deterministic reducer owning Task DAG + Scheduler + run state machine
EXECUTION  →  the Effect Runtime: model calls · host tools · deterministic analyses · patch apply/validate
DATA       →  Project doc · Semantic Timeline Index · append-only Event Log (source of truth)
```

Everything the user asked for — reversible, inspectable, resumable, cancellable,
deterministic — falls out of this structure instead of being bolted on.

**Coverage map** (the 25 requested deliverables → sections here): 1▸§3 · 2▸§4 ·
3▸§12,§13 · 4▸§13 · 5▸§21 · 6▸§6 · 7▸§8 · 8▸§9 · 9▸§10 · 10▸§8.3 · 11▸§14 · 12▸§8.2
· 13▸§16 · 14▸§16 · 15▸§16 · 16▸§12 · 17▸§17 · 18▸§18 · 19▸§19 · 20▸§18 · 21▸§19 ·
22▸§20 · 23▸§22 · 24▸§23 · 25▸§24. Plus multi-agent §6, self-critique §25, execution
plan §26.

---

## 1. First principles: how would the best teams build this?

Before proposing anything, steal the strongest single idea from each discipline, then
synthesize. The point is not to copy any one of them — it is to notice they all
converge on *separating the control plane from the intelligence*.

| Who | Their hardest-won idea | What we take |
|---|---|---|
| **Cursor** | Perceived latency is the product. Speculative, streamed, apply-as-you-go; the model proposes a *diff* the human accepts, never mutates directly. | Diff-as-the-unit; stream from real work boundaries; never block on a monolithic response. |
| **Anthropic** | Tools are typed contracts; agents are loops with *bounded* context; the model is a policy, not a database. Compaction over memory. | Tool registry as contract; bounded, reconstructed context every turn; never trust the model to "remember." |
| **OpenAI** | Structured outputs + function calling: force the model to emit *validated JSON intents*, not prose to be parsed. | Proposers return schema-validated structs, not free text. |
| **Adobe / Resolve** | The timeline is a deterministic document model; every operation is invertible; render is a separate, sandboxed engine. Non-destructive editing is sacred. | Keep `editor-core` patch/invert; render-vs-preview wall stays absolute. |
| **Linear** | The app is a **reducer over a synced event log**. UI = f(state); optimistic + reconciled; offline-first. Speed is architectural, not tuned in. | Event log is the backbone (you already have `events.ts` — elevate it to *the* WAL). |
| **Figma multiplayer** | A single authoritative document with a mutation stream; clients are views; conflicts resolve deterministically. | One document, many views; a future CRDT seam without a rewrite. |
| **Distributed-systems eng.** | Idempotency, at-least-once effects with dedup, backpressure, saga/compensation for rollback, checkpoints as log offsets. | Effect runtime with idempotency keys; DAG scheduler with backpressure; saga-style rollback. |
| **OS architect** | Kernel vs. user space. A scheduler owns concurrency; syscalls are the only privileged boundary; processes are supervised and killable. | The Conductor is the kernel; tool/effect execution is the syscall boundary; runs are supervised, cancellable "processes." |

**Synthesis.** Every one of these separates *deciding what to do* from *doing it*, and
none of them lets the smart-but-nondeterministic component (the model) hold the control
loop. FramePilot's current loop violates that. The redesign restores the separation.

---

## 2. Why not just "a better agent loop"?

Because the loop is the wrong *shape*, not the wrong *tuning*. A sequential loop:

- **Cannot parallelize.** "Analyze silence on the A-roll" and "detect beats on the
  music" are independent, but the loop runs them one model-turn at a time.
- **Grows tokens with time.** Each turn re-ships an action log (`compactAgentLog`
  helps, but the whole strategy is "re-prompt the world every step").
- **Makes the model the scheduler.** Order, retries, and stop-conditions are decided
  by an LLM sampling tokens — the definition of non-deterministic control flow.
- **Fakes progress.** "running → done" straddles a synchronous call (RC2 in
  `AGENT-NATIVE-UX.md`); the seam fixed the *symptom* (await host tools) but the loop
  is still the disease.

You can't tune your way out of a topology problem. You change the topology.

---

## 3. Design tenets (the invariants the whole system is judged against)

1. **The control plane is a pure function.** `state' = reduce(state, event)`. No I/O,
   no clock, no randomness in the kernel. (Directly extends the discipline already in
   `events.ts`, which is pure and held to 100% coverage.)
2. **The model never holds state and never holds the loop.** Proposers are
   `f(bounded_context) → validated_struct`. Stateless, cacheable, swappable with a
   deterministic mock.
3. **Application state is the source of truth.** The Project document +
   Event Log. The model's outputs are *proposals folded into the log*, never the
   record of record.
4. **Every mutation is a validated, invertible patch.** Unchanged from `editor-core`.
   The AI emits operations; the kernel assembles→validates→(proposes)→applies.
5. **Effects are data.** A model call, a host analysis, a render are *descriptions*
   the Effect Runtime interprets. Deciding an effect and running it are different
   layers. (Elm/Effect-TS discipline.)
6. **Determinism is a property of the control plane, not the model.** We make runs
   *replayable* by recording each proposal in the log; replaying the log reproduces
   the exact run without re-calling the model (§18).
7. **Recipe-first, model-fallback.** Most professional-editing verbs ("remove
   silence," "add captions," "punch in on the speaker") are deterministic programs.
   Reach for the LLM only for genuine ambiguity or open composition. This is the
   biggest single win for latency, cost, and determinism.
8. **One policy across surfaces.** Browser, desktop (Electron), and MCP drive the
   *same* kernel through the *same* command/event interface. No orchestration logic
   forks per host.

---

## 4. Overall architecture (ASCII)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│                                   HOST SURFACES                                      │
│   Web editor (React)      Desktop (Electron main+renderer)      MCP server            │
│        │  commands ▲ events        │  commands ▲ events            │  commands ▲ events│
└────────┼──────────┼────────────────┼──────────┼───────────────────┼──────────┼───────┘
         ▼          │                ▼          │                   ▼          │
┌────────────────────────────────────────────────────────────────────────────────────┐
│  SESSION GATEWAY  (per-project; transport-agnostic: in-proc | IPC | HTTP/SSE)        │
│  • accepts Commands  • streams Events (AiEvent, unchanged shape)  • one per project   │
└───────────────────────────────────┬──────────────────────────────────────────────────┘
                                     ▼
╔══════════════════════════ CONTROL PLANE — THE CONDUCTOR ══════════════════════════════╗
║  Pure reducer + supervised run state machine. NO I/O. Deterministic. 100% covered.     ║
║                                                                                        ║
║   Command ─► [Router] ─► recipe?  ── yes ─► [Plan Compiler] ─┐                          ║
║                 │        (deterministic skill)               │                          ║
║                 └─ no ─► emit IntentParse effect ─► Intent ─► [Plan Compiler]           ║
║                                                              ▼                          ║
║                                             ┌──────────── Task DAG ───────────┐         ║
║                                             │ nodes: typed Tasks w/ deps,     │         ║
║                                             │ budget, retry, resource-class   │         ║
║                                             └───────────────┬─────────────────┘         ║
║                                                             ▼                          ║
║                                         ┌────────── Scheduler ──────────┐               ║
║                                         │ topological · parallel ·      │               ║
║                                         │ priority · backpressure ·     │               ║
║                                         │ per-resource concurrency caps │               ║
║                                         └───────┬───────────────┬───────┘               ║
║                                                 │ dispatch      │ fold result            ║
║                                                 ▼               ▲                        ║
╚═════════════════════════════════════════════════┼═══════════════┼══════════════════════╝
                                                  ▼               │  EffectResult events
┌──────────────────────── EXECUTION PLANE — EFFECT RUNTIME ───────┼───────────────────────┐
│  Interprets EffectDescriptions. Retry · timeout · cancel · idempotency-dedup · trace.   │
│                                                                                         │
│  ┌─ ModelEffect ──► Model Router ──► providers/ (anthropic|github|nvidia|mock, SSE)     │
│  ├─ ProposerEffect ► IntentParser · Planner · EditProposer · Critic (LLM, cached)       │
│  ├─ HostToolEffect ─► HostToolExecutor ─► FastAPI/MoviePy sidecar (ffmpeg analyses,      │
│  │                                          render/export) · Electron IPC · MCP          │
│  ├─ AnalysisEffect ─► deterministic in-proc (silence→ops synth, beat-grid math)          │
│  └─ PatchEffect ───► editor-core: assemble → validate → invert → apply(working copy)     │
└─────────────────────────────────────────┬───────────────────────────────────────────────┘
                                          ▼
┌──────────────────────────────── DATA PLANE ─────────────────────────────────────────────┐
│  Project document (timeline-schema, Zod)  ·  Semantic Timeline Index (derived, cached)    │
│  Append-only Event Log (WAL; state = fold(log))  ·  Memory Store (project/user/workflow)  │
│  Snapshot/checkpoint store (log-offset based)                                             │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**What is KEEP / EVOLVE / REPLACE from today's code:**

| Module (today) | Verdict | Why |
|---|---|---|
| `editor-core` (operations, patch, invert, validator, history) | **KEEP wholesale** | Objectively the right deterministic core. Becomes `PatchEffect`. |
| `timeline-schema` (Zod + Pydantic parity, migrations) | **KEEP** | Source of truth for the document. |
| `ai-sdk/events.ts` (append-only log → reduced view) | **KEEP, ELEVATE** | Already the pattern the kernel needs. Promote from "UI event log" to the kernel's WAL; add effect/task-lifecycle events. |
| `ai-sdk/tool-registry.ts` (typed tools, kinds, JSON-schema) | **KEEP, EXTEND** | Add versioning, permissions, cost/latency hints, capability tags (§14). |
| `ai-sdk/tool-executor.ts` (HostToolExecutor seam) | **KEEP, GENERALIZE** | Becomes the `HostToolEffect` handler; one of several effect handlers. |
| `ai-sdk/providers/*` + `reliability/*` | **KEEP** | The Model Router + Effect Runtime's resilience layer. Already has retry/timeout/tracer/signals. |
| `ai-sdk/context-builder.ts` | **EVOLVE** | Keep tiered budgeting; replace string-concat assembly with *structured retrieval* over the Semantic Index (§10). |
| `ai-sdk/critic.ts` | **KEEP, PROMOTE** | Becomes the Verifier proposer + a scheduled `verify` task, not a post-hoc afterthought. |
| `ai-sdk/memory-store.ts` | **EVOLVE** | Split into the four memory scopes (§16); today it's only project-scope. |
| `ai-sdk/orchestrator.ts` (the monolith) | **REPLACE** | Its responsibilities are redistributed across Conductor (control), proposers (decision), effect runtime (execution). This is the surgery. |

The redesign is therefore ~70% *reorganization of excellent existing parts* behind a
new control-plane spine, and ~30% new (Conductor kernel, scheduler, semantic index,
recipe compiler). That is the honest scope — not a greenfield fantasy.

---

## 5. Component hierarchy

```
Session (1 per open project)
├── SessionGateway               transport adapter (in-proc / Electron IPC / HTTP+SSE)
├── Conductor (control plane)     ─ pure, deterministic
│   ├── CommandRouter             classify → recipe | plan | chat | direct-edit
│   ├── PlanCompiler              intent|recipe → Task DAG
│   ├── TaskGraph                 nodes, edges, budgets, resource classes
│   ├── Scheduler                 topo + parallel + priority + backpressure
│   ├── RunStateMachine           idle→planning→executing→verifying→(review|error|cancelled)
│   └── EventLog (writer)         append-only; emits AiEvents
├── EffectRuntime (execution)
│   ├── EffectDispatcher          idempotency, dedup, trace, cancel wiring
│   ├── ModelRouter               model selection, cost, fallback (providers/)
│   ├── Proposers                 IntentParser · Planner · EditProposer · Critic
│   ├── HostToolExecutor          sidecar/IPC/MCP (existing seam)
│   ├── DeterministicAnalyses     silence→ops, beat-grid, gap detection (pure)
│   └── PatchEngine               editor-core assemble/validate/invert/apply
├── DataPlane
│   ├── ProjectDoc                timeline-schema
│   ├── SemanticTimelineIndex     derived projection (cached, content-hash keyed)
│   ├── MemoryStore               short | task | project | user | workflow
│   └── CheckpointStore           log-offset snapshots
└── Observability                 tracer, telemetry, cost meter, replay recorder
```

---

## 6. Multi-agent? — the verdict: **specialized proposers, one deterministic coordinator**

The vision doc lists ~15 candidate agents (Planner, Timeline Analyst, Color
Specialist, Reviewer, Critic, Verification Agent, Coordinator…). The honest
architectural answer: **do not build autonomous conversational agents that talk to
each other.** Multi-agent swarms are where determinism, cost control, and
debuggability go to die (agents re-deriving context, chattering, looping).

Instead: **one deterministic Coordinator (the Conductor) invokes a small set of
stateless, single-purpose *proposers*.** A proposer is a role — a prompt + an output
schema + a model tier — not a long-lived actor. It has no memory, no conversation, no
ability to call another proposer. It returns a validated struct; the kernel decides
what happens next.

The right roster (four, not fifteen):

| Proposer | Input (bounded) | Output (schema) | Model tier | When |
|---|---|---|---|---|
| **IntentParser** | user text + tiny project header + selection | `Intent { goal, targets[], constraints, platform }` | small/fast | only when router can't match a recipe |
| **Planner** | Intent + Semantic Index summary + tool capabilities | `Plan { steps[]: {op-kind, target, deps} }` (compiles to DAG) | mid | novel/composite requests |
| **EditProposer** | one plan step + focused index slice + relevant tools | `ToolCall[]` (validated by registry) | mid | per edit task |
| **Critic/Verifier** | working project + goal + render-validation | `Findings[]` (deterministic checks + optional LLM judgment) | small + deterministic | verify phase |

Why "specialists" like Color/Motion/Subtitle are **not** separate agents: they are
**tool clusters + recipes**, not cognitive agents. "Color grade to look cinematic" is
`EditProposer` constrained to color tools, or a deterministic color recipe. Spinning
up a "Color Agent" adds a conversation, a context rebuild, and a coordination protocol
to do what a scoped tool filter already does. Specialization lives in **tools and
recipes**, not in a population of chatbots.

**Rule of thumb:** *add a proposer only when it needs a genuinely different output
schema and model tier; add a tool/recipe for everything else.* This keeps token cost
and non-determinism proportional to the number of decisions, not the number of
"agents."

---

## 7. The Conductor (control-plane reducer)

The Conductor is the heart. It is a pure state machine:

```ts
// Conceptual — the kernel is pure; all I/O is expressed as EffectDescriptions it emits.
type ConductorState = {
  run: RunStatus;                    // idle|planning|executing|verifying|review|error|cancelled
  graph: TaskGraph;                  // the DAG for the current run
  ready: TaskId[];                   // tasks whose deps are satisfied
  inflight: Map<TaskId, EffectId>;   // dispatched, awaiting result
  working: ProjectRef;               // working copy (never the user's doc until accepted)
  ops: Operation[];                  // cumulative validated ops this run
  budget: Budget;                    // tokens, ops, wall-clock, $ spent vs cap
  log: EventLogOffset;               // where we are in the WAL
};

// The ONLY entry points. Both are pure: (state, x) -> [state', EffectDescription[]]
function onCommand(state, cmd):      [ConductorState, Effect[]];
function onEffectResult(state, res): [ConductorState, Effect[]];
```

`onEffectResult` is where the kernel folds a proposal or a tool outcome back in,
advances the scheduler, and emits the next batch of effects + `AiEvent`s. Because it
is pure and returns effects-as-data, you can:

- **Unit-test the entire orchestration** with a table of `(state, result) → (state,
  effects)` — no mocks of the network, no fake timers. (This is why `events.ts` is at
  100% coverage today; we extend that discipline to the whole control plane.)
- **Replay** a run by feeding the recorded effect results back in — same state, same
  events, no model calls (§18).
- **Swap transports** freely: the kernel doesn't know if an effect runs in-proc, over
  Electron IPC, or over HTTP.

This is the OS-kernel analogy made concrete: the Conductor is ring 0; everything with
side effects is ring 3, reached only through the "syscall" of emitting an
`EffectDescription`.

---

## 8. Planning, Task Graph, and the recipe-first router

> **[2026-07-13 — superseded for the live Agent-mode run path by ADR 0055.]** The
> deterministic keyword `routeCommand` below over-triggered (greedy recipe hijack: "add an
> intro with keyframes" → `add_hook` → "no changes, no AI needed") and under-served (a bare
> "hi" → full planning). Agent mode now routes via `Orchestrator.streamAuto`: ONE small
> model classification (`command-classifier.ts`) → chitchat | question | recipe | edit.
> `routeCommand` and the recipe/creative-phrase tables are retained only for the
> save-as-workflow shape check; a taught workflow's exact trigger still routes to its recipe
> with zero tokens. See `docs/adr/0055-model-routed-command-classifier.md`.

### 8.1 The router (the latency/cost win)

Every command first hits a **deterministic classifier** (keyword + intent-signature +
selection state — no model call):

```
"remove all silences"      → recipe: remove_silence           (0 tokens, instant plan)
"add captions"             → recipe: add_captions
"punch in when she talks"  → recipe: punch_in_on_speaker      (uses transcript)
"make a 45s montage to the beat of the music"  → PLAN (novel/composite → Planner)
"why does this feel slow?" → chat (read-only, Critic + transcript)
Cmd+K on a selection: "tighten this"  → direct EditProposer (single small patch)
```

Recipes are the FramePilot task commands that already exist (`/remove-silence`,
`/add-captions`, `/improve-pacing`, …) — but promoted from "slash commands a human
runs" to **first-class deterministic planners the router can dispatch automatically.**

### 8.2 A recipe *is* a plan (unification — see self-critique §25)

To avoid a "two brains" split between the recipe engine and the LLM planner, **both
compile to the same Task DAG.** A recipe is simply a *deterministic* `PlanCompiler`
input; the Planner proposer is the *non-deterministic* one. Downstream — scheduler,
effect runtime, verify — is identical. There is exactly one execution path.

```
remove_silence recipe compiles to:
   T1 analyze_silence(track=A-roll)         [HostToolEffect, resource=ffmpeg]
   T2 synth_ripple_deletes(from=T1)         [AnalysisEffect, deterministic]  dep: T1
   T3 assemble+validate patch(from=T2)      [PatchEffect]                    dep: T2
   T4 verify(goal="no silence > 0.4s")      [Critic]                         dep: T3
   → propose DiffEvent for human review
```

Zero LLM calls for the entire "remove all silences" flow. It streams progress from the
*real* boundaries of T1→T4. It is fully deterministic given the same media. That is the
"magical yet deterministic" bar, met by *not asking the model at all*.

### 8.3 Timeline Intelligence — the Semantic Timeline Index

The Planner and EditProposer never see raw `project.fp.json`. They see a **derived
semantic projection** — the thing that makes the model reason like an editor:

```
SemanticTimelineIndex (pure derivation of ProjectDoc; cached by content-hash)
├── shots[]        {start,end, sourceClip, motion, brightness}      (from detect_scenes)
├── dialogue[]     {start,end, speaker?, text}                      (from transcript)
├── silences[]     {start,end, dB}                                  (from analyze_silence)
├── beats[]        {times[], bpm}                                   (from detect_beats)
├── music[]        {trackId, ranges}
├── broll[]        {clipIds}          faces[] objects[]  (future CV — honestly gated)
├── captions[] transitions[] effects[] speedRamps[] markers[]
└── layers[]       z-ordered, kind-labeled (from context-builder's existing summarizer)
```

Key properties:
- **Derived, never authored.** It is `f(ProjectDoc, analysisResults)`; the Project
  document stays the only writable truth. No schema change (tenet 8 of AGENT-NATIVE-UX).
- **Incrementally invalidated.** Keyed by content-hash of the relevant slice; a trim to
  clip X invalidates only the shots/silences overlapping X. Analysis results are
  memoized in the index (this generalizes today's per-run `hostCache`).
- **The retrieval surface for context.** Context assembly (§10) selects *slices* of
  this index (the focus range, the targeted layer), not the whole document. The model
  reasons over "dialogue between 12–18s" and "beat grid," not clip JSON.

This is where "the AI understands editing concepts rather than implementation details"
actually lives.

### 8.4 Scheduler

- **Topological + parallel:** independent tasks dispatch together. `analyze_silence`,
  `detect_scenes`, `detect_beats` on different assets run concurrently.
- **Resource classes with concurrency caps.** Naive parallelism melts a laptop —
  ffmpeg is CPU/IO-bound. Each task declares a class (`ffmpeg`, `model`, `pure`,
  `render`) and the scheduler enforces per-class limits (e.g. `ffmpeg: 2`, `model: 4`,
  `render: 1`). Backpressure, not a thundering herd.
- **Priority:** user-visible edits > background analyses > speculative prefetch.
- **Budget-aware:** stops dispatching when the run hits its token/$/op/wall-clock cap;
  emits an honest "reached budget" notice (generalizes today's `maxOpsPerRun`).
- **Speculative execution:** while the Planner is thinking, the scheduler may
  pre-dispatch obviously-needed read analyses (transcript, silence) so their results
  are warm when the plan lands. Cursor-style latency hiding.

---

## 9. Context architecture (minimal tokens, maximal relevance)

The rule: **the model receives the smallest slice that could possibly change its
answer, and never the same bytes twice.**

```
Context assembly for a proposer call =
   system contract (stable, prompt-cached)                     ← Anthropic prompt caching
 + tool descriptors (only the tools this proposer may use)     ← scoped, not all 26
 + Semantic Index SLICE (focus range + targeted layer)         ← retrieval, not dump
 + task-local scratch (just this task's inputs/prior results)
 + memory slice (only preferences relevant to this op-kind)
   — assembled to a token budget; lowest-priority tiers dropped with an honest notice
```

Lifecycle & techniques:
- **Indexed, not shipped.** The document lives in the Semantic Index; context pulls
  slices by query (time range, layer, entity id). This replaces
  `context-builder.ts`'s whole-timeline string with a retrieval call.
- **Cached & versioned.** The stable system contract + tool schemas are marked for
  **provider prompt caching** (Anthropic cache breakpoints). Index slices are keyed by
  content-hash; unchanged slices reuse cached tokens.
- **Compressed.** Long transcripts → salient-window summarization keyed to the focus
  range (extends today's `summarizeTranscript` truncation into relevance selection).
- **Expiry.** Task scratch dies with the task. Run scratch dies with the run. Nothing
  accumulates into an ever-growing prompt — the exact opposite of "re-prompt the world
  each turn."
- **Prioritized dropping.** Keep today's tiered `DROP_ORDER` (transcript → timeline →
  memory → history → selection) as the budget backstop, now operating over slices.
- **Deterministic.** Same project + same task → same context bytes → cacheable,
  testable (already a property of `context-builder`; preserved).

Token math intuition: today an agent turn re-ships system + all 26 tool schemas + full
timeline + growing action log **every step**. The redesign ships the stable prefix
*once* (cached), scoped tools *per proposer*, and an index *slice* — turning an O(steps
× worldsize) prompt into O(decisions × slicesize) with a cached prefix.

---

## 10. Tool lifecycle & the "who invokes tools" tradeoff

Tools stay exactly as disciplined as they are today, plus five upgrades:

`typed` (Zod, already) · `self-describing` (JSON schema derived, already) ·
**`versioned`** (registry entries carry a semver; MCP + persisted runs pin it) ·
**`permissioned`** (capability tags: `reads-media`, `writes-timeline`, `spends-$`,
`network`; the sandbox and the scheduler enforce them) · **`cost/latency-hinted`**
(so the Planner and Model Router can budget) · `composable` (recipes are tool
programs) · `idempotent` where possible (analyses keyed by args-hash).

**Who owns invocation?** *Not the planner.* This is the key tradeoff:

| Option | Verdict |
|---|---|
| Planner/model calls tools directly (today) | ❌ conflates decision with execution; no dedup, no parallel, no idempotency, model drives control flow. |
| **A dedicated Effect Runtime owns all invocation** | ✅ the proposer only *proposes* a `ToolCall`; the kernel schedules it as an effect; the runtime validates, dedups, retries, cancels, traces, and folds the result back. |

So: **EditProposer emits `ToolCall[]`; the Conductor turns each into a `PatchEffect`
(mutating) or `HostToolEffect` (analysis/action); the EffectRuntime executes.** The
model proposes; the runtime disposes. This is what makes tools transactional and
reliable rather than fire-and-hope.

**Tool lifecycle (states, streamed):**
```
proposed → validated(args) → scheduled → running(real timings) →
   (completed | warning | failed | cancelled) → result folded → [timeline_action if it produced ops]
```
This is exactly the `ToolStatus` lifecycle in `events.ts` today — we keep it verbatim;
the difference is that `running` now spans a *real* scheduled effect boundary for
*every* kind, not just host tools.

---

## 11. (folded into §10) — tool calling covered above.

---

## 12. Streaming architecture (everything alive, never frozen)

The backbone already exists and is excellent: **the append-only `AiEvent` log with an
incremental reducer** (`createConversationViewBuilder`, O(1) amortized push, avoids the
O(n²) re-fold that caused "buffered" streaming). We keep it and stream *more* stages
through it.

```
Kernel emits AiEvents at EVERY boundary:
  status(thinking|planning|executing|verifying)   run lifecycle
  reasoning + reasoning_delta                      step-local model thinking (never fabricated)
  plan (drafted ledger only)                        bounded up-front checklist, when one exists
  assistant + assistant_delta (per segment)        interleaved narration ↔ tool cards
  tool_call (running→terminal) + tool_result       real timings, real data
  timeline_action                                  only after ops validate+apply
  progress                                          for measurable long ops (render/analyze %)
  diff                                             the reviewable patch
  warning|error|notification                       honest, never silent
  checkpoint                                        resumable snapshot on cancel
```

New events the redesign adds (additive, event-log-compatible — same rule as
AGENT-NATIVE-UX): `task_started` / `task_finished` (DAG node lifecycle, drives a
richer "what's running in parallel" view) and `effect_progress` (streamed % from
host/render effects). The reducer folds them the same way; old consumers ignore them.

**Perceived-latency techniques** (Cursor's actual moat):
- Emit `status(planning)` and the empty reasoning shimmer within one frame of the
  command — before any model call resolves.
- Recipe path: first real `tool_call(running)` appears in ~1 frame (no model
  round-trip).
- Speculative analyses stream their progress while the Planner is still deciding.
- Parallel tasks surface as *simultaneous* running cards — the UI visibly does more
  than one thing, which reads as "fast and competent."

**Step-local activity (ADR 0072):** an agent run has one `turnId` but many model
steps. Its reasoning event is therefore keyed by step (`${turnId}:reasoning:${step}`),
opens before that step's tool cards, and settles even if no reasoning text arrives.
Chat and one-shot edit retain the unkeyed `${turnId}:reasoning` id. The `plan` event
is reserved for a real `planFirst` draft with a fixed ledger length; unplanned runs
show their interleaved step activity rather than a synthesized, ever-growing checklist.

**Transport:** in-browser it's an async generator (today). Desktop: the kernel runs in
the Electron **main** process; events stream to the renderer over IPC as the same
`AiEvent`s. MCP: the same events serialize to the protocol. One event model, three
wires.

---

## 13. Internal state model

Four state scopes, each with a clear owner and lifetime:

| Scope | Owner | Contents | Lifetime | Persisted? |
|---|---|---|---|---|
| **Document state** | DataPlane | ProjectDoc (timeline, assets, transcript, aiMemory) | project | yes (`project.fp.json`) |
| **Derived state** | DataPlane | Semantic Index, names, describe caches | ephemeral, reconstructible | no (rebuilt from doc) |
| **Run state** | Conductor | graph, ready/inflight, working copy, budget, run status | one run | checkpointed on cancel |
| **Conversation state** | EventLog | the AiEvent WAL → ConversationView | session (persisted with project) | yes (event log) |

Synchronization rule: **there is exactly one writer per scope.** The Conductor writes
run state; the PatchEngine writes the working copy (only through validated patches);
accepting a diff is the *only* path from working copy → ProjectDoc, and it's a human
action. Derived state is never written, only recomputed. This eliminates the class of
bugs where "AI state" and "app state" disagree — they can't, because there is one
truth (the doc + log) and everything else is a pure function of it.

The full set the vision lists (preview/render/worker/background states) are all
**effect states** living in the EffectRuntime as inflight `EffectId → status`, surfaced
as events. They are not separate stores; they are the runtime's view of what it's
executing.

---

## 14. (folded into §13)

---

## 15. (folded into §10, §16)

---

## 16. Memory, threading, IPC, workers, recovery

### 16.1 Memory architecture (four scopes; be ruthless about lifetime)

| Memory | Scope | Persisted | Purpose |
|---|---|---|---|
| **Short-term / task** | one task | no | the task's inputs + prior results; dies with the task |
| **Run / conversation** | one run/session | yes (event log) | the AiEvent WAL; bounded history window threaded into context |
| **Project memory** | project | yes (`aiMemory`, existing) | brand/caption style, pacing, accepted/rejected edits — today's `memory-store.ts`, kept |
| **User memory** | across projects | yes (app profile) | cross-project preferences, favorite export platforms, model tier defaults |
| **Workflow memory** | user/team | yes | *reusable recipes the user teaches* — "my intro style" saved as a parameterized plan |

What persists vs. ephemeral: **anything derivable is ephemeral** (Semantic Index, task
scratch); **anything learned or authored persists** (project/user/workflow memory,
event log). The model itself remembers *nothing* — memory is app state injected as a
context slice (tenet 2). Workflow memory is the sleeper feature: a taught workflow
becomes a deterministic recipe, moving future runs from the LLM path to the zero-token
recipe path — the system literally gets cheaper and more deterministic as the user
teaches it.

### 16.2 Threading & IPC

- **Kernel is single-threaded and pure** — no locks needed; it's a reducer. It runs in
  the browser main thread (web) or the Electron **main** process (desktop).
- **Effects are concurrent** — the scheduler dispatches many at once; concurrency is in
  the *runtime*, bounded per resource class. Model calls: async I/O. ffmpeg analyses:
  the FastAPI sidecar's own process pool. CV/decode: Web Workers / worker_threads.
- **Desktop IPC:** renderer sends `Command`s to main; main streams `AiEvent`s back.
  The kernel + effect runtime live in main (closer to the sidecar, off the UI thread).
  This is a deliberate, reviewed IPC-surface change (CLAUDE.md §5 gate).
- **Background workers:** thumbnail decode (the `bitmapCache` work already landed),
  waveform extraction, speculative analyses, and long renders run as background
  effects with their own progress events; the kernel treats them as any other effect.

### 16.3 Error recovery (saga-style, per failure class)

| Failure | Strategy |
|---|---|
| **Model call fails/times out** | Model Router retries with backoff, then falls back to a lower tier or a deterministic recipe if one covers the intent; if none, honest `error` event, run pauses at `review`. (Uses existing `reliability/retry`, `timeout`, `resilient-provider`.) |
| **Tool/host effect fails** | Task marked failed; scheduler routes around it if downstream tasks have alternatives, else fails the subgraph and reports which node + why. Never fabricate success (existing honesty rule). |
| **Partial execution** | Cumulative validated ops so far remain a reviewable patch; nothing is lost. Rollback is *not needed* mid-run because we edit a working copy and only *propose*; the user's doc is untouched until accept. |
| **Invalid timeline state** | The `PatchEffect` validator rejects the offending turn's patch *before* apply (existing `validator.ts`); the working copy never enters an invalid state. |
| **User interruption** | Abort signal cancels inflight effects (host fetch aborted, model stream closed); kernel emits `cancelled` and a `checkpoint` (log offset + cumulative ops) for Resume. Exactly today's semantics, generalized to any effect. |
| **Conflicting edits / stale context** | The working copy is versioned by base content-hash; if the user edits under a running agent, the kernel detects the base moved and either rebases the remaining plan or fails honestly ("the project changed — starting over"), never applying a stale patch. Extends today's resume-validation check. |
| **Unexpected model output** | Proposers return *schema-validated* structs; a malformed proposal is a validation failure fed back once (self-correct), not a crash. Extends today's `describeArgValidationError` loop. |

---

## 17. Scheduling, retry, rollback, checkpoint — concrete strategies

- **Scheduling:** list-scheduling over the DAG; ready-set = nodes with satisfied deps;
  dispatch up to per-resource-class caps by priority; re-evaluate on each
  `onEffectResult`. Deterministic given the same result-arrival order; **and** we record
  arrival order in the log so replay is exact even though wall-clock parallelism isn't.
- **Retry:** per-effect policy (`maxAttempts`, backoff, jitter) in the runtime, keyed
  by an **idempotency key** = hash(effect kind, args, base-content-hash). Retries and
  duplicate proposals dedup to one execution (generalizes today's per-run `hostCache`).
- **Rollback:** two levels. (1) *Within a run*: no rollback needed — we build a working
  copy and only apply validated turns; a rejected turn simply isn't applied. (2) *After
  accept*: every applied patch has an `invert` (`editor-core`), so undo is a first-class
  inverse patch, and a multi-step agent run collapses into **one** undoable patch (or a
  labeled group) — clean undo UX.
- **Checkpoint:** a checkpoint is just an **event-log offset + the cumulative validated
  ops**. It's already an `AiEvent` (`CheckpointEvent`). Resume replays ops onto the
  current doc, validates the base still matches, and continues the DAG from the last
  completed node. No separate store, no serialization of kernel internals.

---

## 18. Scalability & extensibility (no rewrite to get here)

| Requirement | How the architecture already supports it |
|---|---|
| **100+ tools** | Registry is a flat typed list; proposers get *scoped* subsets, so prompt size is independent of registry size. Tool versioning + capability tags added. |
| **100k+ timeline objects** | Context uses Semantic Index *slices* + focus ranges (never the whole doc); the UI already does horizontal windowing (ADR 0040) + bitmap caching. Index invalidation is incremental. |
| **Hour-long projects** | Analyses are chunked, cached in the index, and run as background effects; context is time-range-scoped. |
| **Concurrent AI tasks** | The scheduler *is* concurrency; multiple user requests become multiple runs the Conductor multiplexes (each a supervised "process"). |
| **Cloud execution** | Effects are data + transport-agnostic. A `HostToolEffect` can dispatch to a local sidecar or a cloud worker with no kernel change. |
| **Collaborative editing** | The doc-as-event-log + single-writer discipline is CRDT-ready; the SessionGateway becomes a sync point. Designed-for, not built-now. |
| **Plugin/MCP marketplace** | New tools/recipes register into the same registry; MCP servers appear as additional `HostToolEffect` handlers. The existing `mcp-server` already proves the surface. |
| **Custom/local models** | Model Router already abstracts providers (anthropic/github/nvidia/mock); a local model is one more provider. Offline = recipe path + local model, zero cloud. |
| **Autonomous workflows** | A taught workflow is a recipe; a scheduled/batch run is the Conductor driven by a non-interactive gateway. |

**Offline capability** deserves a callout: because recipes are deterministic and
require no model, "remove silence / add captions / export reels" all work fully
offline. Only novel composition needs a model, and that can be a local one. The
architecture degrades gracefully from cloud-frontier → local-model → recipe-only.

---

## 19. Performance & token optimization (the concrete list)

**Perceived latency:**
1. Recipe-first: most commands never wait on a model.
2. Emit `planning`/shimmer within one frame of the command.
3. Speculative prefetch of read analyses during planning.
4. Parallel effect execution → visibly-concurrent progress.
5. Streamed diffs / apply-as-you-go for the review card.
6. Incremental event reducer (O(1) push) — already shipped, keep.

**Token cost:**
1. Recipes = 0 tokens.
2. Prompt caching of the stable system contract + tool schemas (Anthropic cache
   breakpoints).
3. Scoped tool descriptors per proposer (not all 26 every turn) — extends today's
   `toolDescriptors(filter)`.
4. Strip dead schema bytes (already done: `$schema` URI stripping, ~360 tok/turn).
5. Context = index *slices*, not whole-doc dumps.
6. Structured outputs (schemas) instead of prose the model pads.
7. Model-tier routing: small model for IntentParser/Critic, mid for Planner/Editor,
   frontier only when needed — the cost meter enforces the budget.
8. In-run + cross-run analysis dedup via idempotency keys.

**Runtime performance:** kernel is a pure reducer (cheap); heavy work is off the UI
thread (sidecar/workers); thumbnails/waveforms cached (bitmap cache shipped); timeline
windowed (ADR 0040).

---

## 20. Sequence diagrams

### 20.1 "remove all silences" — the recipe (zero-LLM) path

```
User        Gateway     Conductor            EffectRuntime         Sidecar        UI(events)
 │  submit ───►│           │                     │                    │              │
 │             │─ command ►│ router: recipe       │                    │              │
 │             │           │ compile DAG (T1..T4) │                    │─ status(planning), plan[] ►│
 │             │           │─ dispatch T1 ───────►│─ analyze_silence ─►│              │
 │             │           │                     │                    │─ tool_call(running) ►│
 │             │           │◄── T1 result(silences) ◄─────────────────│─ tool_call(completed) ►│
 │             │           │─ dispatch T2 (synth) ►│ (pure)            │              │
 │             │           │◄── ripple ops ───────│                    │              │
 │             │           │─ dispatch T3 (patch) ►│ assemble+validate │─ timeline_action×N ►│
 │             │           │◄── validated patch ──│                    │              │
 │             │           │─ dispatch T4 (verify)►│ critic (det.)     │─ status(verifying) ►│
 │             │           │◄── ok ───────────────│                    │─ diff (review card) ►│
 │             │           │ status(review)       │                    │─ status(completed) ►│
 │  Accept ───►│─ command ►│ apply patch → Doc, record undo-inverse    │              │
```

Latency to first visible work: ~1 frame. Model calls: 0. Deterministic: yes.

### 20.2 "45s montage cut to the beat" — the planner (LLM) path

```
Conductor                         EffectRuntime / Proposers
  │ router: no recipe → IntentParse effect ─────► IntentParser(small model) ─► Intent
  │ ◄─ Intent(goal=montage, target=music+broll, dur=45s)
  │ speculative: pre-dispatch detect_beats(music), detect_scenes(broll)  ∥ (parallel, warm)
  │ Plan effect ────────────────────────────────► Planner(mid) ─► Plan(steps)
  │ compile Plan → DAG:
  │   T1 detect_beats(music)      [warm from speculation]
  │   T2 detect_scenes(broll)     [warm]
  │   T3 build_beat_grid(T1)      [pure]                      dep T1
  │   T4 select_shots(T2, index)  [EditProposer, mid]         dep T2,T3
  │   T5 place_clips_on_beats(T3,T4) [pure synth → ToolCall[]] dep T3,T4
  │   T6 assemble+validate patch  [PatchEffect]               dep T5
  │   T7 verify(duration≈45s, cuts∈beats) [Critic]            dep T6
  │ scheduler runs T1∥T2 → T3 → T4 → T5 → T6 → T7 → diff → review
  │ (each transition streams tool_call/task/progress/assistant-segment events)
```

The model is consulted **3 times** (IntentParse, Plan, one EditProposer for shot
selection), each a bounded/cached call — not once per timeline mutation. The beat-grid
math and clip placement are deterministic.

---

## 21. (sequences covered in §20)

---

## 22. Execution / context / tool lifecycles (state machines)

```
RUN:      idle → planning → executing ⇄ verifying → review → (accepted | discarded)
                    │            │           │
                    └──────── cancelled ◄────┘   (checkpoint emitted)
                    └──────── error (pause at review with partial diff)

TASK:     pending → ready → dispatched → running → (completed | warning | failed | cancelled)
                                              │
                                              └─ retry (≤maxAttempts, idempotent)

CONTEXT:  request → select index slices → budget/drop tiers → cache-key →
              (cache hit → reuse) | (miss → assemble) → send → expire with task

TOOL:     proposed → args-validated → scheduled → running(real timing) →
              (completed|warning|failed|cancelled) → result folded → [timeline_action]
```

---

## 23. Weaknesses & honest tradeoffs

1. **Kernel complexity up front.** A DAG + scheduler is more machinery than a `for`
   loop. *Mitigation:* the "degenerate DAG" (a linear 1–3 node chain) must have
   near-zero ceremony; trivial edits (`Cmd+K`) bypass planning entirely via the direct
   EditProposer path. We pay the complexity only where concurrency earns it.
2. **Recipes require maintenance.** Every deterministic recipe is code to own and test.
   *Tradeoff accepted:* recipes are where determinism, speed, and cost all win; they're
   worth the maintenance, and they're already half-built as slash commands.
3. **Parallelism can thrash a laptop.** *Mitigation:* resource-class concurrency caps;
   `ffmpeg` and `render` classes are tightly bounded; parallelism is opt-in per class.
4. **Determinism has an asterisk.** LLM proposals are non-deterministic. We only claim
   the *control plane* is deterministic; we make *runs* reproducible by recording each
   proposal in the log and replaying from the record. A *fresh* run with a live model
   can differ — that's inherent to any LLM system; we quarantine and validate it.
5. **Semantic Index staleness.** A derived cache can lag rapid edits. *Mitigation:*
   content-hash keying + incremental, slice-level invalidation; correctness never
   depends on the index (it depends on the doc + validator), only relevance does.
6. **Bigger surface to test.** *Mitigation:* the kernel is pure, so it's table-testable
   at 100% (the `events.ts` precedent). Effects are mocked at one seam. This is a net
   *win* for testability vs. the current monolith, but it's more to write.
7. **Migration risk.** Replacing `orchestrator.ts` is heart surgery on a shipping
   feature. *Mitigation:* strangler-fig migration (§26) — the kernel first wraps the
   existing loop as a single "agent effect," then peels responsibilities out one phase
   at a time, each behind green `pnpm verify`.

---

## 24. Why this beats a naive LLM-agent implementation

| Dimension | Naive agent loop | This architecture |
|---|---|---|
| Control flow | LLM samples the next action | Pure deterministic reducer |
| Latency (common cmds) | ≥1 model round-trip before anything | ~1 frame (recipe path, 0 models) |
| Parallelism | none (sequential turns) | DAG scheduler, resource-capped |
| Tokens | O(steps × worldsize), grows per turn | O(decisions × slice), cached prefix |
| "Running" state | often fake | real effect boundaries, real timings |
| Determinism | none | control plane deterministic; runs replayable |
| Recovery | ad-hoc retries | saga per failure class; checkpoint = log offset |
| Undo | bespoke | inverse patch (editor-core), one grouped undo |
| Testability | mock the network, hope | pure kernel table-tests + one effect seam |
| Offline | impossible | recipes + local model |
| Scaling to 100+ tools | prompt bloats | scoped descriptors, size-independent |
| Adding a capability | prompt-engineer the mega-loop | register a tool + (optional) recipe |
| Feels like | chatting with an LLM | collaborating with an engine ✅ (the actual goal) |

The last row is the whole point. Users don't feel a kernel; they feel that the app
*does things* — in parallel, instantly for common tasks, with visible honest progress,
always reversible. That *is* "an expert editor sitting beside you."

---

## 25. Self-critique → v2 (one iteration, as requested)

Critiquing v1 above, six problems and their fixes (folded back into the sections):

1. **"Two brains" risk (recipes vs. LLM planner could diverge).** → **v2 fix:** a
   recipe *is* a `PlanCompiler` input; both paths compile to the *same* Task DAG and
   share the entire downstream (scheduler/effects/verify). One execution path, two
   plan sources. (Now §8.2.)
2. **DAG overhead on trivial edits.** → **v2 fix:** first-class "degenerate DAG" + a
   direct `Cmd+K` EditProposer path that skips planning; the kernel must be as cheap as
   a function call for 1-op edits. (Now §23.1, §8.1.)
3. **Naive parallelism melts hardware.** → **v2 fix:** resource-class concurrency caps
   in the scheduler, not unbounded fan-out. (Now §8.4, §17.)
4. **Unbounded event log.** → **v2 fix:** snapshotting + compaction — fold the log to a
   checkpoint and truncate; keep a bounded tail for replay/undo. (Add to §17.)
5. **Over-claimed determinism.** → **v2 fix:** precise claim — *control plane*
   deterministic; *runs* reproducible by recording proposals; a fresh live run may
   differ. Stated honestly. (Now §23.4.)
6. **Semantic Index could be a correctness dependency.** → **v2 fix:** the index is
   *relevance-only*; correctness always flows through the doc + validator, so a stale
   index degrades relevance, never safety. (Now §8.3, §23.5.)

v2 also **downgrades the proposer roster from ~15 imagined agents to 4** and reclassifies
"specialists" (color/motion/subtitle) as tool clusters + recipes rather than agents —
the single most important simplification, because it makes cost and non-determinism
scale with *decisions*, not with an org chart of chatbots. (Now §6.)

Net: v2 is *simpler* than v1 in the ways that matter (one execution path, four
proposers, degenerate-DAG fast path) and *more honest* about determinism, while keeping
every capability.

---

## 26. Execution plan

**Strategy: strangler-fig, not big-bang.** The kernel is introduced *around* the
existing orchestrator, then responsibilities are peeled out phase by phase. Every phase
ends green on `pnpm verify`, ships behind the existing invariants (no schema change; AI
emits patches only; render-vs-preview; one policy across surfaces; no new store beyond
what's justified), updates `plan/PLAN.md` + docs/ADR/CHANGELOG, and is independently
reviewable. Order honors the build-order invariant (engine → render/validate → AI →
agent).

> Legend: `[ ]` not started. Owners reference the repo's subagents.

### Phase K0 — Foundations & seams (no behavior change)
- [x] **K0.1** Extract `Command` and `EffectDescription` types + a `SessionGateway`
      interface in `packages/ai-sdk`. Wrap today's `streamAgent` as a single
      `AgentEffect` behind the gateway. *Proves the seam; zero UX change.*
      Owner: ai-tooling-engineer. — **Done 2026-07-07:** new `src/kernel/`
      (`commands.ts` · `effects.ts` w/ pure `compileCommand` · `gateway.ts` w/
      `createInProcessGateway`), exported from the package index. In-proc gateway
      compiles `submit_turn` → one `AgentEffect` and dispatches to the existing
      `Orchestrator.stream*`; parity test asserts byte-for-byte-identical events for
      chat/plan/edit/agent. `effects.ts`/`gateway.ts` 100% covered; 425 ai-sdk tests
      green; typecheck clean.
- [x] **K0.2** Promote `events.ts` to the kernel WAL: add `task_started`/`task_finished`/
      `effect_progress` events (additive; reducer folds them; old consumers ignore).
      Owner: ai-tooling-engineer. Tests: reducer at 100%. — **Done 2026-07-07:** three
      new `AiEvent` members + `TaskView`; the reducer folds them into a view-level
      `tasks` list (NOT `nodes`, mirroring `checkpoint`) keyed by `taskId` — running →
      terminal, runtime derived from the start ts, `effect_progress` clamped onto the
      owning task and ignored for an unknown one. `TurnEmitter` gained
      `taskStarted`/`taskFinished`/`effectProgress`. `events.ts` back to **100%** (stmt/
      branch/func/line); the exhaustive `EventNode` node-switch is untouched and the
      web/desktop/MCP `event.type` consumers (all have a `default`) ignore the new kinds.
      434 ai-sdk tests green; web-editor/desktop/mcp typecheck clean.
- [x] **K0.3** Define `EffectRuntime` with one real handler (`HostToolEffect`
      = today's `HostToolExecutor`) + `ModelEffect` (today's providers). Idempotency
      keys + dedup generalized from the per-run `hostCache`. Owner: ai-tooling-engineer.
      — **Done 2026-07-07:** `src/kernel/effect-runtime.ts` — `EffectDescription` union
      extended with `HostToolEffect`/`ModelEffect` (+ `RuntimeEffect`); pure
      `idempotencyKeyFor` (host tools keyed by `name+args` like `hostCache`, models
      keyed only when explicit); `createEffectRuntime` interprets both, honours the
      abort signal, and dedups behind the key — memoizing **only successes** (a
      `failed`/`cancelled` host outcome or a thrown model call is evicted so a retry
      re-runs), sharing one execution across concurrent duplicates, and re-marking memo
      hits `cached:true`. No executor ⇒ honest `failed` outcome, never fabricated.
      effect-runtime.ts + effects.ts + gateway.ts **100%**; 445 ai-sdk tests green;
      typecheck + eslint clean. (Not yet wired into `streamAgent` — that is the K1
      cutover.)

### Phase K1 — The Conductor (pure control plane)
- [x] **K1.1** Implement `Conductor` as `onCommand`/`onEffectResult` pure reducer with a
      **degenerate (linear) DAG** only — reproduce today's agent behavior exactly, but
      with control flow in the reducer and execution in the runtime. Table-tested.
      — **Done 2026-07-07:** `src/kernel/conductor.ts` — pure `onCommand`/`onEffectResult`
      returning `{state, effects, events}`. Ports the `streamAgent` turn-loop *control
      flow*: start (spinner+shimmer), step cap, per-turn + per-run op caps, no-progress
      spin guard, validator-rejection accounting + honest empty-run notice, user-cancel +
      resume checkpoint, and the terminal `verify → finalize` chain. Execution mechanics
      (model stream, host tools, patch assemble/validate, diff+report+terminal) stay in
      `ConductorEffect`s (`run_turn`/`run_verify`/`finalize`) the runtime interprets; the
      distilled `AgentTurnResult`/`VerifyResult` fold back in. `seq` threaded through state
      so event ids never collide across folds. 20 table tests, **100%** conductor.ts; 465
      ai-sdk tests green; typecheck+lint+build clean. **Not yet wired into `streamAgent`,
      and full event-stream parity + `planFirst`/`resume`/`autoRepair` are K1.2.**
- [ ] **K1.2** Port the run state machine (idle→planning→executing→verifying→review) +
      budget caps (`maxOps*`) + checkpoint/resume (already `CheckpointEvent`). Parity
      tests against current `streamAgent` outputs (same event sequences).
- [x] **K1.3** Cut `streamAgent` over to the Conductor; delete the old loop once the
      parity suite is green. — **done 2026-07-07 (signed off).** `streamAgent` compiles the
      run into a `Command` + handlers (`agentRun`) and delegates to `runConductor`, wrapped
      in a throw-settling generator (old catch/finally: error card + partial diff + terminal
      status). The ~398-line loop is deleted; the shared turn mechanics are the only survivor.
      Gate: `streamAgent-golden.test.ts` freezes the OLD loop's full `AiEvent[]` (fixed clock,
      ts + ids, no normalization) BEFORE cutover; the Conductor-backed `streamAgent`
      reproduces it byte-for-byte. Throw-time seq reads through one shared active-emitter
      reader. `agentConductorHandlers` retained as the public kernel seam (K6.1). 507 tests,
      100% on orchestrator/conductor/driver/events, dependents clean. **ADR 0042.** Realizes
      redesign DoD item 1 (monolithic loop replaced by Conductor + handlers). Owner:
      ai-tooling-engineer.

- [~] **K1.2** Port the run state machine + budget caps + checkpoint/resume; **parity
      tests** against current `streamAgent` outputs (same event sequences). — **K1.2a done
      2026-07-07:** `src/kernel/driver.ts` — `runConductor(command, handlers, signal)`
      async-generator that binds the pure Conductor to injectable execution handlers
      (`runTurn`/`runVerify`/`finalize`): streams `onCommand` events, routes each effect to
      its handler, folds the distilled result via `onEffectResult`, loops to the terminal
      `finalize` — mirroring `streamAgent`'s `AsyncGenerator<AiEvent>` surface. 4 tests
      (done · multi-turn · cancel · non-agent) with deterministic fake handlers; driver.ts
      **100%**; 469 ai-sdk tests green. **Next (K1.2b/c):** real handlers (model stream +
      tools + patch + diff) reusing the orchestrator's turn mechanics, then the
      `streamAgent`-vs-Conductor event-parity harness + `planFirst`/`resume`/`autoRepair`.
      — **K1.2b step 1 done 2026-07-07 (extract & share):** the per-turn tool-execution
      sub-loop is now a shared private `Orchestrator.executeToolCalls` async-generator
      (emit running→terminal cards + results, collect ops/notes/statuses); `streamAgent`
      calls it in place of the inline loop. Behavior-preserving — all **107** golden
      orchestrator/stream tests green, `orchestrator.ts` still **100%**. Becomes the shared
      mechanic the Conductor `run_turn` handler reuses, so the two paths can't diverge on
      how a turn's tools run.
      — **K1.2b step 2 done 2026-07-07 (split-emitter seq foundation):** byte-for-byte id
      parity needs ONE monotonic one-off sequence shared between the reducer (structural
      events) and the handlers (fine events). `createTurnEmitter(ref, startSeq = 0)` now
      accepts a seed and exposes `seq()`, so the driver seeds each handler's emitter at the
      reducer's current `ConductorState.seq` and reads back the advanced value for the next
      fold. Additive — 471 ai-sdk tests green, `events.ts`/`orchestrator.ts`/`conductor.ts`/
      `driver.ts` all **100%**. **Verified design for the remaining K1.2b/c push (the parity
      harness gate + reducer plan-ledger ownership):**
      - **seq contract:** driver passes `step.state` to each handler; handler seeds
        `createTurnEmitter(ref, state.seq)`, emits its fine events, and returns the advanced
        `endSeq` on the `ConductorResult`; `onEffectResult` seeds its emitter at
        `result.endSeq` (not `state.seq`) so structural + fine ids interleave as one run.
      - **state additions:** `ConductorState.planSteps: readonly PlanStep[]` +
        `ledgerLength: number` (reducer owns the ledger, design §1). `log` ownership moves to
        the handler (built with `streamAgent`'s exact note text) and rides back on each
        result so the finalize checkpoint stays byte-identical.
      - **effect additions:** `RunTurnEffect` grows `planSteps` + `ledgerLength`; new
        `DraftPlanEffect` emitted from `onCommand` when `planFirst && !resume` → handler
        calls `generateAgentPlan`, returns labels; reducer folds → seeds `planSteps` (all
        `pending`), emits `plan`, sets `ledgerLength`, preserving the
        `status('planning')`→`plan`→`status('thinking')` order.
      - **result additions:** `AgentTurnResult` grows `endSeq`, `planSteps`, `planStepIndex`,
        `intent`, `anyToolFailed`, `describedActions` (pre-described applied ops, since the
        reducer can't touch editor-core), `log`. `VerifyResult` grows `endSeq` + repair-applied
        ops (autoRepair folds into `run_verify`→`finalize` via `attemptRepair`).
      - **divergences the harness must pin (design §2/§3 ordering):** the `running` plan
        event is emitted MID-turn by the run_turn handler (only place `intent` exists); the
        TERMINAL plan event + the per-op `timeline_action` cards are emitted by the reducer
        on the fold, AFTER the handler returns — so `timeline_action`s are emitted by the
        reducer from `result.describedActions`. Mid-turn tool-cancel emits a `failed` plan
        ('Stopped by user') that the turn-boundary `aborted` path does NOT, so the reducer
        must split `anyToolCancelled` from `aborted` (today it treats them identically).
      — **K1.2b/c LANDED 2026-07-07 (the unit, one green commit):** implemented exactly as
      designed above. `Orchestrator.agentConductorHandlers(input, opts, agentOptions)`
      returns the five handlers reusing the shared turn mechanics; `conductor.ts` owns the
      plan ledger + `draft_plan`/`resume` folds; `driver.ts` passes `step.state` to each
      handler and routes the new effects. **Parity harness** `src/kernel/parity.test.ts`
      drives `streamAgent` vs `runConductor` byte-for-byte (deep-equal `AiEvent[]`) over 16
      scenarios — all 10 named (multi-turn applied · done/no-op · per-turn cap · per-run cap ·
      spin guard · user cancel · planFirst · resume · autoRepair · empty-run) plus
      empty-terminal-text, narrate+edit, three cancel variants (pre-abort / mid model call /
      mid host tool), empty drafted plan, and stale-checkpoint resume — **green**. Both
      predicted divergences reconciled (no workaround). `streamAgent` untouched (K1.3 cutover
      still gated). `conductor.ts`/`driver.ts`/`events.ts`/`orchestrator.ts` all **100%**;
      506 ai-sdk tests green; typecheck+lint+build clean.

### Phase K2 — Semantic Index & structured context
- [x] **K2.1** Build `SemanticTimelineIndex` as a pure derivation (reuse
      `context-builder`'s layer summarizer, `project-index`, transcript). Content-hash
      keyed + incremental invalidation. Owner: timeline-engineer + ai-tooling-engineer.
      **Done 2026-07-07.** `packages/ai-sdk/src/kernel/semantic-index.ts`:
      `buildSemanticIndex(project)` + memoized `semanticIndexFor(project)`. Derives the
      slices readable from the ProjectDoc alone — `layers[]` (z/kind/span, reusing the
      layer summarizer's logic over `indexFor`), `dialogue[]` (transcript grouped into
      utterances on a 0.6s gap), `captions[]`, `transitions[]` (kind/duration/fromClip
      from params), `effects[]` (color/audio/mask/text/other categorized), `music[]`
      (audio-layer ranges). Built on `indexFor(project)` and memoized per immutable
      `Project` snapshot via WeakMap — the **content-hash-keyed / incremental
      invalidation** property realized through snapshot identity (a trim re-walks only
      the changed track; an untouched project reuses the whole index by reference; same
      argument as `project-index.ts`, stronger than a hash — nothing mutable to drift).
      Analysis-fed / schema-gated slices (`shots`←detect_scenes, `silences`←analyze_silence,
      `beats`←detect_beats, `speedRamps`, `markers`, CV `broll`) are **typed for a stable
      contract but honestly empty** until analysis-result ingestion lands (K3) — never
      faked. Pure (no project mutation); no schema/dep change. New module **100%**
      stmts/branch/funcs/lines (20 tests); 527 ai-sdk tests green; typecheck/lint/build
      clean; dist rebuilt. Slice *retrieval* into the prompt (replacing whole-timeline
      strings) is K2.2.
- [x] **K2.2** Replace whole-timeline context strings with **index-slice retrieval** +
      keep tiered budgeting/drop-order. Prompt-cache the stable system+tools prefix.
      Measure token delta (performance-monitor). Owner: ai-tooling-engineer.
      **Done 2026-07-07.** `context-builder.ts` now assembles the timeline and transcript
      tiers as **bounded slices**, not whole-document dumps: (1) `summarizeTimeline` gains
      a `maxClipsPerLayer` cap (default `Infinity` → existing direct callers unchanged);
      `assembleContext` passes `MAX_CLIPS_PER_LAYER=12`, so an unfocused layer shows its
      first 12 clips and collapses the rest to a count/span — the slice is O(slice), not
      O(timeline) (a 200-clip layer renders <1/5 the tokens of the dump; token-delta
      asserted in a test). The selection-scoped path (B3) is unchanged. (2)
      `summarizeTranscript` gains a `focus` param: with a selection it returns the words
      spoken within the range ±`TRANSCRIPT_FOCUS_PAD=2s` (word-level, so it bounds even a
      single unbroken monologue — dialogue-segment windowing does not), replacing the
      "first 600 words" head with "what is being said around the edit." Tiered
      budgeting/`DROP_ORDER` unchanged (now operating over the slices). **Prompt-caching
      of the stable system+tools prefix was already shipped (R2 B5, `providers/anthropic.ts`
      marks the tool schemas + system contract with an Anthropic `cache_control`
      breakpoint) — verified in place, not re-done.** `context-builder.ts` **100%**; 536
      ai-sdk tests green (+9); typecheck/lint/build + web-editor typecheck clean; dist
      rebuilt; no schema/dep change. Structured per-proposer slice retrieval off the
      `SemanticTimelineIndex` (layer/entity queries) lands with the proposers in K3.

### Phase K3 — Planner, Task DAG, Scheduler
> Built as pure kernel modules **alongside** the parity-locked agent-loop Conductor
> (K1.3 froze its byte-exact event stream); the recipe/plan path consumes them. The DAG
> engine does not rewrite the locked reducer — that cutover is a later, sign-off-gated step.
- [x] **K3.1** `PlanCompiler`: Intent|Recipe → real (non-degenerate) Task DAG.
      **Done 2026-07-07.** `kernel/task-graph.ts` — the `TaskGraph`: a validated acyclic
      DAG of `TaskNode`s (each carries an inert `TaskEffectSpec`, a **resource class**
      `ffmpeg|model|pure|render|host` for the scheduler's concurrency caps, a **priority**
      `edit|analysis|speculative`, and deps). `buildTaskGraph` enforces the invariants
      (unique ids, resolvable deps, acyclic — throws `TaskGraphError` with a specific
      reason); `topologicalOrder` (Kahn, stable by graph order → replayable) and
      `readyTasks(completed, inflight)` (priority-then-graph-order) are the pure
      derivations the K3.2 Scheduler reads. `kernel/plan-compiler.ts` — `compilePlan`
      turns a Planner `ProposedPlan` into the graph (auto-ids, resource/priority defaults
      by effect kind); `compileRecipe` proves "**a recipe is a plan**" (§8.2): recipes are
      pure `params → steps` functions (`remove_silence` → the analyze→synth→patch→verify
      four-node DAG with 0 model calls; `add_captions`) that flow through the *same*
      `compilePlan` → one execution path. Both new modules **100%** (20 tests); 556 ai-sdk
      tests green; typecheck/lint/build clean; no schema/dep change; parity untouched.
- [x] **K3.2** `Scheduler`: topological + parallel + priority + **resource-class
      concurrency caps** + backpressure + budget-aware stop. Speculative prefetch of
      read analyses. Deterministic result-order recording for replay.
      **Done 2026-07-07.** `kernel/scheduler.ts` — a **pure** dispatcher over a
      `TaskGraph`: `nextDispatch` picks the next batch honouring per-class caps
      (`DEFAULT_RESOURCE_CAPS`: `ffmpeg` 2 / `model` 4 / `render` 1 / `host` 2 / `pure` ∞),
      priority-then-graph order (edits ≻ analyses ≻ speculative, so read analyses are the
      lowest-priority prefetch that fills spare capacity), and a `Budget` (`maxTasks`/
      `maxTokens`) that generalizes `maxOpsPerRun` — dispatch stops but in-flight work
      drains. `SchedulerState` is folded forward by `onTaskCompleted`, which records
      `completionOrder` for byte-exact replay (tenet 6); `isComplete`/`isSettled` are the
      driver's stop conditions. No I/O, clock, or randomness. **100%** coverage (18 tests);
      573 ai-sdk tests green; typecheck/lint/build clean; no schema/dep change; parity
      untouched.
- [x] **K3.3** `IntentParser` + `Planner` + `EditProposer` + `Critic` proposers as
      schema-validated effects with model-tier routing. Owner: ai-tooling-engineer.
      **Done 2026-07-07.** `kernel/proposers/` — the four §6 proposers as pure, stateless
      "roles" (prompt + Zod output schema + model tier), each expressing its model call as
      an inert `ModelEffect` (effects-as-data, tenet 5) and validating the reply, never
      performing I/O. `types.ts` — the `ModelProposer` contract, the **model-tier routing
      seam** (`ModelTier` `small|mid|large` + `ModelTierRouting`/`DEFAULT_TIER_ROUTING`/
      `tierModel`; no provider-tier seam existed, so this introduces the minimal one — pure
      config the future Model Router consumes, built alongside the parity-locked Conductor),
      and the shared `parseJsonResponse` (fence-tolerant JSON → `safeParse` → a
      `ProposerResult` error, never a throw — §16.3 self-correct). **IntentParser** (small)
      → `Intent {goal,targets[],constraints,platform}` from user text + a tiny
      `projectHeaderOf` header + selection. **Planner** (mid) → the **exact `ProposedPlan`**
      shape (`ProposedPlanSchema`) so a proposal flows straight through the existing
      `compilePlan` → DAG; bounded on `summarizeSemanticIndex` + `toolCapabilities`.
      **EditProposer** (mid) → `ToolCall[]` **validated by the tool registry** (each call's
      name must be an in-scope tool and its args must pass that tool's `parse`; a
      hallucinated tool or bad args is rejected, coerced args returned) — bespoke
      `parseResponse(raw, tools)` so validation is honest. **Critic/Verifier** (small +
      deterministic) — **promotes `critic.ts`**: `runCritic` reuses `critique` verbatim (no
      model in the trust core), mapping checks → `Finding[]`; an additive small-tier
      `buildJudgmentRequest`/`parseJudgment` seam adds advisory `source:'judgment'` findings
      that never flip the deterministic verdict. New dir **100%** stmts/branch/funcs/lines
      (43 tests); 629 ai-sdk tests green; typecheck/lint/build clean; dist rebuilt; no
      schema/dep change; parity untouched. Wired into `kernel/index.ts`. Structured
      per-proposer slice *retrieval* + the driver wiring that dispatches these effects lands
      with the recipe router (K4).
- [x] **K3.4** Parallelism proof: montage use case runs `detect_beats ∥ detect_scenes`;
      golden test asserts cuts land on returned beats (extends the AGENT-NATIVE-UX DoD).
      **Done 2026-07-07.** `kernel/montage.ts` — the deterministic beat-sync core
      (§20.2's `build_beat_grid` + `place_clips_on_beats` as pure functions): `buildBeatGrid`
      normalizes onsets (sort/dedupe/drop non-finite) and `placeCutsOnBeats` fills each beat
      interval with the next shot up to the target duration, so **every cut boundary is a
      beat** by construction (`cutsLandOnBeats` is the invariant). `montage-parallelism-golden.test.ts`
      drives the real §20.2 plan through K3.1 `compilePlan` → K3.2 `nextDispatch`: it asserts
      (1) `detect_beats`/`detect_scenes` dispatch in the **same** batch (and serialize when the
      `ffmpeg` pool is capped to 1 — the win is the cap, not luck), and (2) the resulting cuts
      ⊆ the returned beats, replaying to a golden dispatch order + cut list with **zero live
      model calls** (the one `select_shots` step served from a recorded proposer output, tenet 6).
      `montage.ts` **100%** (12 tests); 586 ai-sdk tests green (+13); typecheck/lint/build clean;
      no schema/dep change; parity untouched.

### Phase K4 — Recipe-first router
- [~] **K4.1** Deterministic `CommandRouter` (keyword/intent-signature/selection).
      **Router built (`kernel/router.ts`, 100%) since K5.2.** UI wiring **partial
      2026-07-08:** the web-editor run path (`AiSidebar.runTurn`) now calls `routeCommand`
      and, when the user is in agent mode and the command is a read-only **question**,
      runs it as `chat` (no wasted agent loop / misleading self-check). Edit-intent routes
      (`recipe`/`plan`/`direct_edit`) still fall through to the agent loop — dispatching a
      matched **recipe** down the DAG path waits on K4.2 + the engine leaf-executors.
      Shipped alongside an **honest empty-run notice** (`ai/runOutcome.ts`): an editing run
      that applied nothing now says why (no applicable edit, or the analysis engine is
      unreachable in the browser) instead of showing only "Self-check: Passed". 24 sidebar/
      helper tests; web-editor test+typecheck+lint green.
- [ ] **K4.2** Promote existing slash-command recipes (`/remove-silence`,
      `/add-captions`, `/improve-pacing`, `/add-hook`) to `PlanCompiler` recipes the
      router auto-dispatches; each compiles to a DAG and requires **0 model calls**.
      Golden + e2e: "remove all silences" produces a valid patch with no provider call.
- [ ] **K4.3** Cost meter + telemetry: report tokens/$/latency per run; assert recipe
      runs cost 0 tokens. Owner: ai-tooling-engineer + performance-monitor.

### Phase K5 — Memory, recovery, replay hardening
- [x] **K5.1** Split memory into scopes (task/run/project/user/workflow); keep
      `memory-store.ts` as project scope; add user + workflow scopes. — **done
      2026-07-08.** task scope = the scheduler's ephemeral task-results (derivable, not
      persisted); run scope = the `events.ts` AiEvent WAL (already persisted). New pure,
      persistence-agnostic stores `user-memory.ts` (cross-project editorial defaults +
      favourite export platforms; tier defaults stay in `AiConfig.tierRouting`, not
      duplicated) and `workflow-memory.ts` (saved parameterized recipes — a `SavedWorkflow`
      *is* a `RecipeRequest`, so it replays through the same `compileRecipe`; the seam K5.2
      fills). `scoped-memory.ts` layers project **over** user (project wins per field; a
      user default only fills a blank project field) and `context-builder` threads the
      effective editorial memory into the `memory` tier via a new optional
      `ContextInput.userMemory`. All three new modules **100%** (19 tests); 706 ai-sdk tests
      green; typecheck/lint/build clean; web-editor + desktop typecheck clean; dist rebuilt.
      No schema change. **K5.1b done 2026-07-08:** user + workflow memory now persist and
      reach the model end-to-end. Neither scope holds secrets (unlike API keys), so both live
      in the renderer's `localStorage` (`web-editor/editor/userMemoryStorage.ts`, over the pure
      ai-sdk read/write helpers), which Electron keeps per-origin — **one store serves both the
      browser build and the desktop renderer with no new IPC surface**. A **Settings → Memory**
      panel (`useUserMemory` hook) edits the cross-project editorial defaults + prunes taught
      workflows; the browser AI session threads `userMemory` into the model context (mirroring
      history/selection; desktop main-process threading is a later follow-up once its IPC
      carries it). web-editor typecheck/lint green; 760 web-editor tests green (incl. storage +
      Settings-Memory tests).
- [x] **K5.2** Workflow memory: "save this run as a recipe" → parameterized deterministic
      plan (the get-cheaper-as-taught feature). — **done 2026-07-08.** `captureWorkflow`
      turns a completed run's `RecipeRequest` into a named, triggerable `SavedWorkflow`
      (default id = slug of name, default trigger = normalized name); `normalizeTrigger`
      (case/whitespace/punctuation) makes matching deterministic. `matchSavedWorkflow`
      exact-matches a command to a saved trigger, and `routeCommand` now consults
      `command.savedWorkflows` **before** the built-in recipes — so a taught run that would
      otherwise hit the LLM `plan` path (or that the user customized with specific params)
      dispatches its saved recipe with **zero tokens**. Exact-match only (a fuzzy match
      could hijack an unrelated command — honesty rule). `workflow-memory.ts` + `router.ts`
      **100%**; 715 ai-sdk tests green; typecheck/lint/build clean; dist rebuilt. No schema
      change. **UI loop closed 2026-07-08:** a **"Save as recipe"** item in the AI sidebar
      overflow menu captures the last command as a workflow when the router resolves it to a
      recipe (honest inline refusal for planner runs — never a fabricated recipe); Settings →
      Memory lists/deletes them, and typing the saved trigger replays with zero tokens — so
      the teach → save → replay loop is complete end-to-end in the UI (2 new sidebar tests).
- [x] **K5.3** Saga recovery per failure class (§16.3); event-log snapshot/compaction;
      **run replay** from recorded proposals (no model). Owner: ai-tooling-engineer +
      security-reviewer (cancel/timeout/sandbox review). — **done 2026-07-08.** Three pure
      kernel modules: (1) `recovery.ts` — `recoveryFor(failure)` maps each §16.3 failure
      class (model timeout/error, tool failed, invalid patch, user cancelled, stale base,
      malformed proposal) to a `RecoveryStrategy` (retry-with-backoff → recipe/tier
      fallback; route-around vs fail-subgraph; pause-at-review; checkpoint-cancel;
      rebase-or-restart; self-correct-once), every branch honesty-preserving. (2)
      `event-log.ts` — `compactEventLog` drops streaming deltas + keeps last-per-id (lossless
      for reload); `snapshotEventLog` adds the derived run summary (turn/event/dropped counts,
      last status + checkpoint) for resume/telemetry. (3) `replay.ts` —
      `createRecordingEffectRuntime` captures each `EffectResult` in call order;
      `createReplayEffectRuntime` replays them with **no deps at all** (zero provider/host
      calls — DoD item 4), asserting effect-kind order and throwing `ReplayDivergenceError`
      on divergence. All three **100%** (19 tests); 734 ai-sdk tests green; typecheck/lint/
      build clean; dist rebuilt. No schema change. **Phase K5 complete.**

### Phase K6 — Surfaces & scale
- [x] **K6.1** Desktop: kernel in Electron **main**, events over IPC (IPC-surface change
      → maintainer approval, CLAUDE.md §5). MCP: same kernel behind the protocol.
      Owner: mcp-engineer + security-reviewer. — **done 2026-07-08 (maintainer-approved:
      "complete all remaining phases").** The kernel already **runs in Electron main**: the
      main-process `Orchestrator` has been Conductor-backed since the K1.3 cutover, and it
      streams `AiEvent`s to the renderer over the hardened, sender-scoped `aiStreamStart`
      channel (unguessable run ids, per-sender abort, run timeout, project re-validation, key
      stays in main) — so the "kernel in main over IPC" seam substantively exists. This phase
      **extends that reviewed seam additively** rather than rip-and-replacing a working IPC
      contract with a Command-shaped one (which would add no capability and re-open a
      security-sensitive surface): `AiStreamRequest.userMemory` is threaded end-to-end, so the
      desktop path inherits the user's cross-project editorial defaults exactly like the
      browser path (completing K5.1b on desktop). **Security review (inline):** the one new
      field is untrusted, so `parseUserMemory` sanitises it in main — every free-text field
      trimmed + 200-char-capped, `favoriteExportPlatforms` string-filtered + 20-item-capped,
      malformed input dropped (never thrown); it carries no secrets and touches no path/FS
      surface; it rides the existing channel (no new IPC method). MCP already runs the same
      kernel behind the protocol (shared `TOOL_REGISTRY` + `assembleEdit`, parity-tested).
      shared-types/desktop/web-editor typecheck + lint green; 187 desktop tests green (incl.
      5 new `parseUserMemory` cases). Additive `shared-types` change, no project-schema change.
- [x] **K6.2** Tool registry upgrades: versioning, capability/permission tags, cost/
      latency hints. Scale test: 100+ synthetic tools with scoped descriptors (prompt
      size flat). Owner: ai-tooling-engineer. — **done 2026-07-08.** New `tool-scope.ts`:
      `ToolMetadata` (version + capability/permission tags + cost/latency) is **derived per
      kind** so none of the 26 tools needs annotating, and a tool may override by declaring
      the additive optional fields on `ToolSpec` (TS-only, never emitted in
      `toolDescriptors` → MCP/Python descriptor parity untouched, verified). `selectTools`
      filters the registry to a `ToolScope` (least-privilege permissions ∧ capability match ∧
      name allowlist ∧ availability gate); `scopedToolDescriptors` projects the scoped set to
      the model-facing shape. **Scale test** builds 120 and 600 synthetic tools across 6
      capabilities and proves a scoped prompt tracks the *scope*, not registry size (a
      single-name scope's serialized size is byte-identical at 120 vs 600 tools; a
      capability scope is <¼ the full-registry prompt). `tool-scope.ts` + `tool-registry.ts`
      **100%**; 742 ai-sdk tests green; typecheck/lint/build clean; MCP `tools.test.ts`
      parity green; dist rebuilt. No schema change.
- [x] **K6.3** Docs: ADR "Orchestration Kernel" (graduate this RFC), agent-UX guide
      update, CHANGELOG + website changelog. Owner: docs-maintainer + changelog-maintainer.
      — **done 2026-07-08.** **ADR 0044** graduates this RFC to Accepted (the umbrella
      decision over K0–K6, building on ADR 0042/0043). The agent-UX guide
      (`docs/guides/ai-sidebar.md`) gained a **Memory** section (cross-project defaults +
      saved workflows); `CHANGELOG.md` (Unreleased) and a new website changelog entry
      (`2026-07-08-memory-and-taught-recipes.mdx`) cover the user-facing K5/K6 features; this
      RFC + `plan/PLAN.md` are reconciled. **Phase K5 & K6 complete.**

### Definition of Done (whole redesign) — status 2026-07-08

Graduated to **ADR 0044**. Architecturally complete; the two items gated on
build-order (live recipe leaf-executors need their Python engines) are called out.

1. ✅ `orchestrator.ts` monolith replaced by Conductor + EffectRuntime + proposers; event
   output is a strict superset of today's (parity suite green). — ADR 0042.
2. ◑ Recipes **compile** to a 0-model-call Task DAG (six of them; router auto-dispatches),
   and replay proves 0 provider calls. Running a recipe to *deterministic media output*
   end-to-end still waits on its engine leaf-executors (`analyze_silence` et al.) — inert
   specs today, honoured by the build-order invariant (not faked).
3. ◑ The Scheduler runs independent DAG tasks **in parallel** with resource caps (montage
   golden test, K3.4); no fabricated ✅ anywhere. Landing cuts on *returned* beats is the
   same engine-gated leaf-executor step as (2).
4. ✅ Stop → `cancelled` within one frame batch; Resume from checkpoint (both parity-locked);
   run **replay** reproduces a recorded run with no provider calls (K5.3).
5. ✅ Every new kernel module at 100% coverage; token/$ per run instrumented (cost meter,
   ADR 0043) with scoped-prompt scaling (K6.2); `pnpm verify` green per phase;
   docs/ADR/CHANGELOG/plan reconciled.

---

## Appendix A — Mapping the vision doc's subsystem list to this design

Intent Understanding→§6 IntentParser · Planning Engine→§8 · Task Graph/Execution
Graph→§8.4,§7 · State Manager→§13 · Context Manager→§9,§10 · Memory→§16.1 · Timeline/
Selection/Scene/Clip Intelligence→§8.3 Semantic Index · Asset Manager→ProjectDoc+bin
tools · Knowledge Store→Memory+Index · Tool Registry/Router→§10 · Execution Queue/
Parallel Scheduler→§8.4 · Streaming Layer→§12 · Checkpoint/Undo/History→§17 · Telemetry/
Observability→§5 Observability,§19 · Error Recovery→§16.3 · Agent Runtime→Conductor+
Proposers · Model Router/Cost Optimizer→§19,ModelRouter · Prompt Builder→§9 · Event
Bus→EventLog · IPC Layer→§16.2 · Desktop Runtime→§16.2 · Persistence→§13 · Background
Workers→§16.2 · Cache Layers→§9 (context/prompt), §8.3 (index), bitmapCache (UI).

Every subsystem the vision enumerates has a home; none requires an architectural
rewrite to add — which is the real test of the design.
```
