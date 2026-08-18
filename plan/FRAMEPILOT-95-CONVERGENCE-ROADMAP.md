# FramePilot 9.5 Convergence Roadmap

**Status:** `[~]` in progress — Phase 0 measurement merged (PR #13); Phase 1 runtime
convergence complete (ADR 0126). Phases 2-11 not started.
**Created:** 2026-08-16
**Last reconciled:** 2026-08-18 against the code, not against these checkboxes.
**Target branch:** `main`
**Owner:** maintainer
**Purpose:** move FramePilot toward a measured 9.5/10 across product, editing-machine, AI-agent, reliability, UX, and architectural simplicity benchmarks without adding speculative systems.

> This is a convergence plan, not a request to rewrite FramePilot. The goal is to make the capabilities that already exist flow through one excellent architecture, prove them with real editing outcomes, strengthen the deterministic editing machine underneath them, and remove mechanisms that no longer earn their complexity.

---

## 0. Executive decision

FramePilot should continue toward this product model:

> **An intelligent editing agent operating a professional, deterministic video-editing machine.**

The next major engineering phase should not be broad feature expansion. It should be a **Convergence Program** with this order:

1. **Measure** the real editing outcome before changing architecture.
2. **Converge** mutating AI execution onto one runtime.
3. **Strengthen** one canonical editor command/transaction authority used by AI and manual workflows.
4. **Simplify** tool exposure and orchestration using measured evidence.
5. **Build the project brain** for long-form multimodal retrieval.
6. **Prove preview/export semantic parity.**
7. **Improve quality verification** without creating another writer.
8. **Perfect editor and AI control UX.**
9. **Add generic delegation only after the single runtime is excellent.**
10. **Delete everything that is no longer necessary.**

The governing principle is:

> **The runtime controls execution and safety. The model controls editorial strategy.**

The runtime should know how to execute safely, cancel, recover, validate, persist, bound cost, expose tools, apply revisions, and undo. It should not become a second editorial intelligence system that tries to decide how much the model should inspect, what editing strategy it should use, or which hard-coded workflow best matches a natural-language request unless a deterministic safety invariant requires that decision.

---

# 1. Product-scope gate

This program is intentionally large, so it must satisfy FramePilot's product-scope gate before any implementation work starts.

## User outcome

Given a real 5 to 15 minute SaaS demo, screen recording, product video, talking-head recording, or short-form source session, FramePilot should reliably produce a polished 30 to 90 second edit with:

- a strong hook;
- coherent cuts;
- dead time removed;
- accurate captions;
- useful emphasis and punch-ins where appropriate;
- relevant B-roll where supported;
- clean dialogue and restrained music treatment;
- tasteful transitions and effects;
- correct platform framing/export;
- a fully inspectable, editable, undoable timeline.

The longer-term extension is the same behavior on 30 to 120 minute projects without context or memory usage scaling linearly with footage duration.

## Current gap

FramePilot has strong deterministic foundations and a growing professional control plane, but several quality dimensions are still not proven at the full-agent outcome level:

- the existing professional capability evals prove deterministic operation and rendered capability paths, but do not yet constitute a broad benchmark for whether the agent produces a publishable finished edit from natural language;
- LangGraph is the agent runtime, while `planned_edit` remains a separate mutating execution route with its own intent parsing, planning, graph compilation, and execution machinery;
- tool and orchestration policy still contain behavior intended to compensate for model failure modes, which should be retained only when benchmarks prove they improve outcomes;
- manual editor semantics, AI editing semantics, preview semantics, and render semantics need stronger convergence guarantees;
- long-form understanding needs a hierarchical temporal retrieval model rather than larger prompts;
- professional UX and AI-control UX need measurable workflows, not only implementation completeness;
- the repository has accumulated sophisticated subsystems through large architecture waves and needs a deliberate deletion/consolidation phase.

## Minimum vertical slice

The first slice is **measurement only**:

1. Extend the existing professional eval infrastructure rather than creating a competing framework.
2. Add representative agent-level scenarios that exercise real user prompts through the current runtime and deterministic editor/render path.
3. Record baseline outcome quality, latency, model calls, tool calls, invalid calls, project revisions, review findings, cancellation/recovery behavior, and execution route.
4. Produce an architecture census showing every mutating AI route and the authority responsible for each state transition.
5. Do not remove `planned_edit`, stage policy, planner machinery, or runtime components until this baseline exists.

## Existing systems to reuse

The program must reuse and extend, not replace, the current foundations:

- `@framepilot/editor-core` typed operations, validation, inversion, and patch semantics;
- Professional Editor Control Plane contracts and `EditorCommand` work;
- `EditorInteractionContext` and deterministic target resolution;
- current LangGraph `agent-graph.ts` runtime;
- pure conductor decisions where they represent execution invariants;
- durable run authority and exactly-once project commit semantics;
- Instant Apply and grouped run undo;
- read-only temporal/perceptual review findings;
- current semantic/project intelligence infrastructure;
- the existing professional eval registration manifest and rendered release gate;
- current preview and deterministic Python/FFmpeg export architecture;
- existing skills and evidence mechanisms.

## Explicitly deferred adjacent scope

Until this program reaches the stated gates, do not use it as justification for:

- new top-level AI execution routes;
- specialist writer agents for captions, pacing, color, B-roll, audio, tracking, or beat sync;
- another workflow engine or orchestration framework;
- a second project-state source of truth;
- generalized plugin or provider architecture without multiple current consumers;
- broad Premiere/Resolve/Fusion parity unrelated to the north-star workflow;
- speculative capability packs unrelated to current user outcomes;
- new AI-only timeline mutation mechanisms;
- a rewrite of editor-core;
- replacement of LangGraph merely for aesthetic architectural reasons.

## Evidence required

This program is complete only through measured evidence:

- representative raw-footage-to-finished-edit evals;
- deterministic operation tests and property tests;
- rendered evidence for visual/audio claims;
- preview/export semantic-parity evidence;
- long-project performance measurements;
- crash/cancel/restart recovery scenarios;
- professional manual-workflow tests;
- agent steering/undo/resume tests;
- architecture census proving single authorities and removed parallel paths.

---

# 2. Current architecture position

FramePilot is not on the wrong path. The current repository has several unusually strong foundations:

- typed, schema-validated, reversible timeline operations;
- deterministic validation before apply;
- one authoritative project revision model;
- deterministic Python/FFmpeg final rendering;
- UI preview kept separate from final rendering for responsiveness;
- professional editor commands and target resolution;
- a LangGraph-backed agent loop with pure control decisions;
- durable run and exactly-once commit work;
- Instant Apply with grouped Undo run;
- perceptual review converted to a read-only finding source rather than a second writer;
- domain-owned tool specifications;
- semantic/project intelligence and multimodal evidence work;
- a professional capability eval/release path;
- strong repository rules that now explicitly favor finished-edit quality, reuse, vertical slices, and deletion over speculative architecture.

The main remaining architectural concern is not a lack of sophistication. It is **too many conceptual mechanisms for deciding and executing AI work**.

Today, the repository conceptually contains both:

```text
ordinary agent request
  -> LangGraph agent runtime
  -> conductor + handlers
  -> tools
  -> typed operations
```

and a surviving planned-edit path:

```text
planned edit request
  -> intent parser
  -> planner
  -> compilePlan
  -> task graph / scheduler / effect runtime
  -> executePlannedEdit
  -> typed operations
```

Planning is valuable. A second mutating execution universe is not automatically valuable.

This roadmap therefore treats `planned_edit` as a **hypothesis to test**, not code to delete on principle.

---

# 3. Target architecture

The target should be simple enough to explain without repository archaeology.

```text
                         USER
                          |
                          v
                   FramePilot Run
                          |
                +---------+---------+
                |                   |
             Context              Model
                |                   |
                +---------+---------+
                          v
                     TOOL RUNTIME
                          |
             +------------+-------------+
             |            |             |
          Inspect       Analyze        Edit
             |            |             |
             +------------+-------------+
                          v
              PROFESSIONAL EDITING MACHINE
                          |
       +------------------+--------------------+
       |                  |                    |
 Timeline/Commands   Media Intelligence    Audio/Visual
       |                  |                    |
       +------------------+--------------------+
                          v
                 Validated Transaction
                          |
                  Project Revision
                          |
              +-----------+-----------+
              v                       v
        Realtime Preview           Final Render
   HTML video/canvas/WebGL       Python/FFmpeg
              |                       |
              +-----------+-----------+
                          v
                       REVIEW
                          |
                    findings only
                          |
                          v
                       AGENT
                 repair if necessary
```

Surrounding runtime services:

```text
revision safety
undo
cancellation
durability
permissions
cost limits
context compression
retry policy
observability
recovery
audit trail
```

## Model responsibilities

The model owns strategy:

- what should be edited;
- what footage or evidence matters;
- what makes the sequence better;
- whether more evidence is needed;
- where a cut should happen editorially;
- which shot best communicates an idea;
- pacing, story, emphasis, relevance, and taste;
- when the objective has been achieved.

## Runtime responsibilities

The runtime owns mechanics and invariants:

- whether an operation is valid;
- whether a target exists and is authoritative;
- whether a revision is current;
- whether the model may use a tool;
- how the command compiles to operations;
- how validation/apply/invert work;
- how cancellation and retries work;
- how work is persisted and resumed;
- how context is bounded;
- how cost/resource limits are enforced;
- how events and traces are recorded.

## Core architectural principle

> **The graph encodes invariants. The model decides strategy.**

---

# 4. Program-level 9.5 benchmark model

A subjective score is useful for orientation but must not be the release criterion. Each benchmark below has a measurable 9.5 gate.

The current scores in this table are **working baseline estimates only**. Phase 0 replaces them with measurements.

| Benchmark | Working baseline | 9.5 definition |
| --- | ---: | --- |
| Product vision | 9.5 | north-star workflow remains explicit and scope decisions map to it |
| Core editor architecture | 8.5 | one canonical command/transaction authority for supported edits |
| Typed operations | 9.2 | every AI mutation compiles to typed operations, with property coverage for behavior-changing branches |
| Undo/reversibility | 9.3 | exact restoration across canonical operations and run-level undo scenarios |
| Single writer | 9.5 | exactly one timeline-writing agent authority in every mutating run |
| Tool architecture | 8.5 | small relevant effective surface, <1% invalid/malformed calls in representative evals |
| Agent autonomy | 7.7 | >=95% success on canonical supported agent-edit scenarios without unnecessary clarification |
| Orchestration design | 7.2 | one mutating AI execution runtime, planning represented as state/capability unless evidence proves otherwise |
| Orchestration simplicity | 5.8 | no duplicate mutating planner/executor universe, clear ownership map |
| LangGraph usage | 8.0 | thin runtime host for one execution model, no business behavior hidden in framework mechanics |
| Agent safety | 9.0 | zero corruptions in recovery/fuzz suite, deterministic revision/cancel/retry semantics |
| Context architecture | 8.0 | evidence has bounded retrieval, provenance, revision awareness, and stale-data policy |
| Video understanding | 7.5 | >=95% recall on labelled temporal retrieval scenarios in supported domains |
| Long-video scalability | 7.3 | context/reasoning growth tracks task complexity rather than source duration |
| Preview architecture | 8.0 | semantic parity suite covers every supported frame/audio-changing capability |
| Render architecture | 7.8 | one final-render authority, validated output, deterministic failure semantics |
| AI verification | 8.5 | read-only review, calibrated findings, deterministic checks for objective failures |
| AI UX | 7.5 | inspect, activity, diff, steer, cancel, retry/continue, undo are reliable and understandable |
| Professional UX | 7.0 | canonical keyboard/manual workflows are fast, predictable, and tested |
| Skills | 8.5 | skills provide knowledge/procedure, never become hidden mutation runtimes |
| Delegation | 6.5 | generic same-runtime child runs with restricted permissions, read-only by default |
| Extensibility | 8.5 | new capabilities extend command/tool/skill contracts without a new execution route |
| Observability | 8.5 | any failed edit can be causally reconstructed from run evidence |
| Architecture docs | 9.0 | live ownership map, supersession records, no contradictory active architecture claims |
| Complexity management | 6.0 | explicit deletion budget and decreasing count of independent execution concepts |
| Competitive direction | 9.0 | finished-edit quality remains the primary optimization target |

## Global non-negotiable gates

A 9.5 system must also satisfy these binary rules:

- **0** original-media mutations.
- **0** raw model-authored project mutations.
- **0** unvalidated applied operations.
- **0** review components that write directly.
- **1** authoritative project source of truth.
- **1** authoritative final-render path.
- **1** authoritative editor command/transaction semantics per supported edit.
- **1** mutating AI runtime after convergence.
- **100%** of applied AI edits inspectable through a diff/receipt.
- **100%** of applied AI runs undoable according to their advertised scope.

---

# 5. Phase 0, measurement before architecture

**Priority:** P0
**Do this first.**

## Objective

Create evidence strong enough to justify later deletion or retention decisions.

## 5.1 Extend the existing professional eval infrastructure

Do **not** create a second standalone eval framework. Extend the current professional eval registration/release machinery with an agent-outcome layer.

The capability gate answers:

> Can FramePilot correctly execute and render this capability?

The new agent layer must answer:

> Given natural language and realistic media/project state, can the agent choose and combine those capabilities into a good finished edit?

## 5.2 Canonical eval set

Build approximately 50 representative scenarios.

### Tier A, deterministic editing mechanics

Examples:

- trim;
- ripple trim;
- roll;
- slip;
- slide;
- split;
- insert;
- overwrite;
- lift;
- replace.

These mostly verify the machine and AI-to-command boundary.

### Tier B, simple AI edits

Examples:

- remove awkward silences;
- add accurate captions;
- emphasize key words intelligently;
- tighten the first 20 seconds;
- add restrained punch-ins at important moments;
- normalize dialogue and duck music under speech;
- create a 9:16 version;
- remove filler without unnatural cuts.

### Tier C, semantic editing

Examples:

- find the strongest hook and move it to the beginning;
- shorten the pricing explanation without losing meaning;
- add relevant B-roll where analytics are discussed;
- remove repetitive explanation;
- make a software demo faster while preserving required steps;
- find the best scenic moments for a montage.

### Tier D, compound agent jobs

Examples:

- turn an 8-minute SaaS demo into a polished 60-second product video;
- produce a 20 to 30 second beat-synced reel from many source clips;
- turn a podcast segment into a short with captions, meaningful punch-ins, and B-roll;
- produce a concise tutorial while preserving every required action.

### Tier E, adversarial and recovery scenarios

Examples:

- offline media;
- missing transcript;
- stale interaction context;
- project revision changes mid-run;
- cancel during analysis;
- cancel during mutation;
- model emits invalid tool arguments;
- insufficient transition handles;
- Undo run after a multi-step edit;
- restart after durable work is recorded;
- large source session;
- 1000+ clips/assets.

## 5.3 Record these metrics for every run

- route/mode selected;
- model/provider;
- model call count;
- tool schemas exposed per turn;
- tool calls;
- invalid/malformed calls;
- duplicate/redundant calls;
- cache/memo hits;
- tokens in/out;
- wall-clock latency;
- analysis/review latency;
- number of operations attempted/applied/rejected;
- project revision before/after;
- review findings;
- repair attempts;
- cancellation state;
- run outcome;
- deterministic validation outcome;
- render evidence outcome;
- human/editorial score where subjective quality is unavoidable.

## 5.4 Architecture census

Generate and maintain a simple table:

| Concern | Current authorities | Target |
| --- | --- | --- |
| natural-language classification | current classifier/routes | minimal routing only |
| planning | agent plan + planned-edit planner | one plan model/state |
| mutating AI execution | agent + planned-edit | one runtime |
| project mutation | editor-core/host authority | one |
| review mutation | none | zero |
| final rendering | Python/FFmpeg | one |
| preview | UI implementation of same semantics | one semantic contract |
| durability | shared durable run authority | one |

## Phase 0 exit criteria

- [x] Representative agent evals run through current production-like paths.
      *(Deterministic rows only. `professional-agent-evals.ts`, 50 scenarios.)*
- [ ] Baseline metrics replace the working score estimates in this document.
      **Blocked on the maintainer:** needs a provider key and real source media. The
      measuring contracts exist (`agent-run-quality.ts`, `pnpm eval:agent:foundation:real`);
      no number in the §4 table has been replaced, and none should be until they are real.
- [x] Every mutating route is identified.
      *(`docs/architecture/FRAMEPILOT-95-MUTATION-ROUTE-CENSUS.md`, kept live.)*
- [x] Every route's validation, revision, persistence, cancellation, review, and undo semantics are documented.
- [x] No architecture deletion happened before this evidence existed.
      *(The Phase-1 deletion is gated on the parity record, with two dimensions explicitly
      waived by the maintainer rather than inferred — see the evidence document.)*

---

# 6. Phase 1, converge mutating AI execution

**Priority:** P0 immediately after Phase 0.

## Objective

Reach one clear answer to:

> How does FramePilot execute a mutating AI request?

Target:

```text
all mutating AI requests
          |
          v
     one agent runtime
          |
          v
        tools
          |
          v
    editing machine
```

User-facing modes may remain different. Execution semantics should not.

## 6.1 Prove primary-agent parity with `planned_edit`

Do not delete `planned_edit` first.

For every scenario currently benefiting from the planned-edit path:

1. execute the same user goal through the primary agent runtime;
2. compare quality, latency, cost, tool behavior, cancellation, durability, review, and undo;
3. classify every primary-agent failure into one of four buckets:
   - missing editor/tool capability;
   - missing knowledge/skill;
   - missing project evidence/retrieval;
   - model/editorial decision failure.

A fifth bucket, "needs another orchestrator," requires benchmark evidence and explicit maintainer approval.

## 6.2 Make planning agent state, not automatically another runtime

Complex work still needs planning.

Represent planning conceptually as:

```text
RunPlan
  objective
  steps
  current step
  completed steps
  evidence
  project revision
```

The same runtime can:

```text
understand
  -> make/update plan
  -> use tool
  -> observe
  -> update plan
  -> use tool
  -> verify
  -> finish
```

Do not remove planning. Remove duplicated execution machinery if it no longer improves outcomes.

## 6.3 Planned-edit retirement gate

Retire `planned_edit` as a distinct mutating execution path only when all of these hold:

- primary-agent success is equal or better on the representative set;
- no planned-edit-only capability remains;
- latency and cost are within agreed budget;
- cancellation behavior is equivalent or better;
- durability/reload semantics are equivalent or better;
- event/activity UX remains understandable;
- review and run-level undo retain parity;
- failures remain honest and typed.

Then remove or collapse, where they are truly orphaned:

- `streamPlannedEdit`;
- planner-only intent parsing;
- plan compilation used only to create the second execution universe;
- planner-specific graph execution;
- effect runtime pieces used only by that path;
- route fallbacks and duplicate budgeting/cancellation/event semantics.

## 6.4 Preserve generic batch scheduling where it earns its keep

A task scheduler may still be useful for deterministic jobs such as:

- frame extraction;
- proxy generation;
- batch analysis;
- embeddings;
- review sampling.

If retained, it should sit **under a tool or infrastructure service**, not become a competing agent runtime.

Example:

```text
agent
  -> analyze_media_batch(...)
      -> deterministic worker scheduler
```

## Phase 1 exit criteria

- [x] One mutating agent runtime owns all natural-language edit execution.
      *(ADR 0126. Every request that reaches the classifier — the `auto`/Agent path all
      natural language goes through — routes to the agent; `planned_edit` is gone from the
      classifier, the editor-run lifecycle enum, the desktop stream modes and the IPC
      contract. This criterion is about ROUTED natural-language execution. The explicitly
      user-selected single-shot `edit` mode is a separate entry point and is NOT covered by
      this box — see the follow-up below.)*
- [x] Planning remains available without requiring a second mutation runtime.
      *(The agent already owns plan state: `planFirst`, `AgentRun.plan`, plan-approval
      gating, and the run ledger. No new planning state was needed.)*
- [x] No supported scenario regresses beyond agreed eval tolerance.
      *(Deterministic scenarios only — see the waiver note below.)*
- [x] Duplicate runtime modules are deleted.
      *(plan-driver, plan-compiler, graph-executor, task-graph, scheduler, recipe-leaves,
      intent-parser, planner, edit-proposer, and their prompts.)*
- [x] Architecture docs clearly state the sole mutating execution path.
      *(`docs/architecture/ai-engine.md`, the census, ADR 0126.)*

### Waivers carried out of Phase 1

Two §6.3 conditions could not be discharged deterministically and were **explicitly waived by
the maintainer**, not satisfied:

| Condition | Status | What would discharge it |
| --- | --- | --- |
| primary-agent success equal or better on the representative set | **waived** | the Phase-0 real-provider capture with editorial scoring |
| latency and cost within agreed budget | **waived (cost measured, latency not)** | the same capture, recording p50/p95 |

Model-call cost *was* measured and favours the agent. Wall-clock latency and editorial
quality were not, because a scripted provider cannot produce either. Recorded here so a
later reader does not mistake an unmeasured dimension for a proven one.

### Follow-up opened by this phase

- [ ] **The single-shot `edit` route is a second mutating entry point.** It is a proposal
      surface, not a second runtime — no loop, no conductor, no durable checkpointing, and no
      authority the agent lacks — but §4's "1 mutating AI runtime" is not literally true while
      it exists. Its user-facing value (one quick reviewable edit; browser-only `variations`
      A/B takes) is real, so it was deliberately NOT folded into the agent in this phase.
      Converging it means running Edit mode as a turn-bounded agent run and deciding what
      happens to `variations`. Tracked here rather than silently claimed as done.

---

# 7. Phase 2, make editor commands and transactions the editing authority

**Priority:** P1, in parallel only where it directly unblocks Phase 1.

## Objective

AI, UI, keyboard, automation, and MCP should converge on the same editing semantics.

Target:

```text
AI tool ---------+
UI interaction --+--> EditorCommand --> validate/compile --> transaction --> project revision
shortcut --------+
MCP -------------+
```

## 7.1 Canonical command contract

Every supported professional edit should have one semantic contract with:

- deterministic target requirements;
- explicit time domain;
- preconditions;
- compilation to typed operations;
- validation;
- apply;
- invert/undo;
- human-readable description;
- diff/receipt representation;
- replay semantics where applicable.

Do not create AI-only editor mechanics for operations that already have or should have canonical editor semantics.

## 7.2 Capability completion matrix

Track every supported capability through the full spine:

| Capability | UI | AI | deterministic target | command | validate | undo | preview | export | tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| trim/ripple | | | | | | | | | |
| roll | | | | | | | | | |
| slip/slide | | | | | | | | | |
| insert/overwrite | | | | | | | | | |
| lift/extract/replace | | | | | | | | | |
| transitions | | | | | | | | | |
| transforms/keyframes | | | | | | | | | |
| captions | | | | | | | | | |
| audio | | | | | | | | | |
| color | | | | | | | | | |
| masks/tracking | | | | | | | | | |
| multicam | | | | | | | | | |

A schema, tool, backend, or preview-only implementation does not make a row complete.

## 7.3 Operation algebra and property tests

For core deterministic operations, add property-oriented coverage for:

- apply then invert restores exact project state;
- operation composition preserves schema validity;
- invalid preconditions fail closed;
- stale revisions cannot silently apply;
- no operation can escape project authority;
- serialization/reload does not change meaning;
- generated operation sequences cannot corrupt timeline structure.

## Phase 2 exit criteria

- [ ] Supported edits have one canonical semantic owner.
- [ ] AI mutation tools are thin adapters to canonical commands/operations.
- [ ] Manual and AI paths do not implement divergent edit mechanics.
- [ ] Core operation inversion is property-tested.
- [ ] Capability matrix accurately reflects real end-to-end support.

---

# 8. Phase 3, simplify the agent control plane with evidence

**Priority:** P1 after the baseline is stable.

## Objective

Keep deterministic execution policy. Remove behavioral micromanagement that benchmarks do not justify.

## 8.1 What the conductor should strongly own

- cancellation;
- retry policy;
- revision safety;
- resource ceilings;
- provider failure handling;
- valid state transitions;
- durable checkpoints;
- run completion semantics;
- compaction triggers;
- tool permissions;
- transaction safety;
- deterministic loop/stall protection where measurable.

## 8.2 What requires explicit benchmark justification

- deciding how much research is enough;
- forcing an editorial phase change;
- preventing fresh evidence solely because a semantic stage says execution started;
- encoding assumptions about how a good editor should sequence inspection, planning, and editing.

## 8.3 A/B test the stage policy

Compare:

**A. Current staged behavior**

against

**B. Reduced semantic staging**, retaining:

- tool permissions based on safety;
- cost/resource bounds;
- memoization;
- loop detection;
- revision safety;
- deterministic validation.

Measure:

- final edit quality;
- unnecessary analysis turns;
- premature edits;
- evidence starvation after an edit;
- latency;
- token usage;
- failure/recovery behavior.

Retain only the policy that earns its complexity.

## Phase 3 exit criteria

- [ ] Conductor responsibilities are documented as invariants versus behavioral heuristics.
- [ ] Every non-trivial behavioral rail has eval evidence.
- [ ] Redundant or ineffective policy is removed.
- [ ] Runtime remains deterministic and replayable where currently guaranteed.

---

# 9. Phase 4, make the effective tool surface smaller and clearer

**Priority:** P1.

## Objective

Keep a rich capability library without forcing the model to reason over every backend procedure on every turn.

Conceptual families should remain easy to understand:

```text
PROJECT
  read/search

TIMELINE
  read/inspect/apply

MEDIA
  search/inspect

TRANSCRIPT
  search/inspect

VISUAL
  inspect/track

AUDIO
  inspect/analyze

PREVIEW
  inspect

REVIEW
  request/read findings

SKILLS
  load

DELEGATION
  delegate, later
```

This is a conceptual model, not a requirement to rename every current tool.

## 9.1 Dynamic exposure

Measure and reduce the **effective** tool surface per turn using:

- user intent;
- interaction context;
- current project capabilities;
- loaded skills;
- model/provider capabilities;
- current run state;
- permission boundaries.

## 9.2 Tool-quality telemetry

Record:

- number of schemas exposed;
- schema token cost;
- tool selected;
- invalid argument rate;
- wrong-tool retry rate;
- duplicate tools with overlapping semantics;
- latency and result size;
- whether a result was useful to the next decision.

Target:

- <1% malformed/invalid calls on supported canonical evals;
- near-zero ambiguous duplicate tool selection;
- bounded schema-token overhead;
- structured machine-readable outputs rather than prose parsing.

## Phase 4 exit criteria

- [ ] Effective tool surface is measured.
- [ ] Redundant/overlapping semantics are consolidated.
- [ ] Tool schemas are dynamically scoped where useful.
- [ ] Tool-selection quality meets the 9.5 target.

---

# 10. Phase 5, build the Project Brain for long-form editing

**Priority:** P1 after execution convergence is underway.

## Objective

The agent should query a large project the way a coding agent queries a codebase, without loading the whole project into context.

## 10.1 Hierarchical temporal evidence model

Move toward a single conceptual hierarchy:

```text
PROJECT
|
+-- sequences
|
+-- source assets
|   +-- scenes/shots
|   |   +-- representative frames
|   |   +-- objects/faces/subjects
|   |   +-- motion
|   |   +-- embeddings
|   |
|   +-- transcript
|   |   +-- speakers
|   |   +-- sentences
|   |   +-- words
|   |
|   +-- audio
|       +-- speech
|       +-- music
|       +-- beats
|       +-- silence
|       +-- loudness
|
+-- timeline
    +-- usage
    +-- edit history
    +-- revision
    +-- semantic structure
```

## 10.2 Provenance on every evidence item

Conceptually include:

```text
asset/sequence identity
start/end
kind
value
confidence
source/provider
model or analyzer version
generated time
project/media fingerprint
revision relevance
```

Stale evidence must be detectable and either invalidated, revalidated, or truthfully marked stale.

## 10.3 Retrieval benchmarks

Label representative questions such as:

- where does the speaker explain pricing?
- find the strongest hooks;
- find high-motion scenic shots;
- find every moment this speaker talks;
- find the best B-roll for analytics dashboard;
- find duplicate takes;
- find unused footage;
- find applause;
- find long silences;
- find shots containing a target subject;
- find moments around a specific time/reference.

Target >=95% recall on supported labelled scenarios, with precision high enough that the agent does not need to inspect the whole project afterward.

## 10.4 Long-form benchmark

Test at least one realistic large project with:

- 60 to 120 minutes of source media;
- 1000+ clips/assets or a similarly large timeline/source set;
- multiple speakers;
- large transcript;
- visual index;
- audio analysis;
- several editing tasks.

Success criterion:

> Context and model work grow primarily with the complexity of the requested task and retrieved evidence, not linearly with source duration.

## Phase 5 exit criteria

- [ ] Evidence has one clear provenance/staleness model.
- [ ] Retrieval quality is measured.
- [ ] Large-project context remains bounded.
- [ ] Agent can answer and edit from indexed evidence without whole-project prompt loading.

---

# 11. Phase 6, preview/export semantic parity

**Priority:** P1/P2 because a professional editor cannot tolerate preview/export disagreement.

## Objective

Keep two physical implementations while enforcing one semantic editing contract.

Correct architecture:

```text
same project/edit semantics
      |                |
      v                v
realtime preview    final render
HTML/video/WebGL    Python/FFmpeg
```

The requirement is semantic parity, not identical implementation.

## 11.1 Golden parity projects

For every supported frame/audio-changing capability, create canonical fixtures covering at least:

- position;
- scale;
- crop;
- rotation;
- opacity;
- keyframes/interpolation;
- captions;
- transitions;
- masks;
- tracking;
- color;
- time remap/speed;
- audio gain;
- audio fades/automation;
- composition/motion graphics where currently supported.

Compare appropriate outputs:

- geometry;
- timing;
- interpolation;
- effect parameter meaning;
- caption placement;
- mask location;
- transition duration;
- audio envelope;
- temporal ordering.

Use pixel/audio comparisons where stable and semantic measurements where render backends necessarily differ.

## Phase 6 exit criteria

- [ ] Every supported visual/audio capability has a parity fixture.
- [ ] Known preview/export semantic mismatches are zero or explicitly blocked with user-visible limitations.
- [ ] New capabilities cannot ship preview-only or export-only without an explicit scope exception.

---

# 12. Phase 7, quality verification without a second writer

**Priority:** P2.

## Objective

Make FramePilot better at detecting bad edits while preserving the one-writer architecture.

## 12.1 Maintain the authority split

**Validation** answers:

> Is this change safe and legal to apply?

It should be fast and authoritative.

**Review** answers:

> Is this edit good?

It should be read-only and produce findings.

Correct flow:

```text
agent writes
  -> validated revision
  -> review reads
  -> finding
  -> main agent decides whether/how to repair
```

## 12.2 Video/edit linters

Add deterministic or learned checks only where they provide actionable evidence, for example:

- beat offset;
- black/blank frames;
- unintended freeze frames;
- silence holes;
- clipping;
- loudness discontinuity;
- caption outside safe area;
- caption overlap;
- face/subject occlusion;
- accidental duplicate shots;
- implausibly tiny shot durations;
- invalid transition handles;
- tracking drift;
- aspect/resolution mismatch;
- unintended timeline gaps.

Do not treat every aesthetic judgement as deterministic truth. Findings should carry scope, confidence, evidence, and whether they are authoritative or advisory.

## Phase 7 exit criteria

- [ ] Review never writes directly.
- [ ] Deterministic checks are clearly separated from perceptual opinions.
- [ ] Findings are revision/region aware and cannot repair stale work blindly.
- [ ] Quality checks measurably improve agent outcomes on the eval set.

---

# 13. Phase 8, professional editor UX and AI control UX

**Priority:** P2, but fix severe blockers earlier.

## Objective

A 9.5 architecture that feels bad to edit with is not a 9.5 product.

## 13.1 Manual editor benchmark

Measure common keyboard-first workflows:

- import;
- organize;
- preview/scrub;
- select;
- split;
- trim/ripple/roll;
- slip/slide;
- move/snap;
- timeline zoom/navigation;
- multi-select;
- transition;
- keyframe;
- captions;
- audio adjustment;
- undo/redo;
- export.

Criteria should include:

- number of interactions;
- keyboard availability;
- response latency;
- visual clarity;
- discoverability;
- accidental-operation rate;
- focus/selection correctness;
- accessibility.

## 13.2 Human + AI collaboration benchmark

Test this sequence explicitly:

```text
AI edits
  -> user trims manually
  -> AI continues from new revision
  -> user undoes selected work or the run
  -> user steers the agent
  -> AI continues without stale assumptions
```

## 13.3 Five AI-control surfaces

The user should always be able to understand and control:

1. **Inspect**: what evidence did the agent use?
2. **Plan**: what objective and next steps is it pursuing?
3. **Activity**: what is it doing now?
4. **Diff**: what changed?
5. **Control**: cancel, steer, undo, retry/continue where meaningful.

Do not expose internal architecture vocabulary such as scheduler/effect-runtime/stage machine unless it is a developer diagnostic.

Prefer user-facing activity like:

```text
Analyzing 23 candidate shots
Found 8 strong moments
Building the opening sequence
Added 14 cuts
Checking pacing
Adjusted 3 cuts after review
```

## Phase 8 exit criteria

- [ ] Manual north-star workflows are measured and polished.
- [ ] AI/manual interleaving is revision-safe.
- [ ] Inspect/plan/activity/diff/control are understandable and reliable.
- [ ] Cancellation and grouped undo remain obvious during long work.

---

# 14. Phase 9, observability and the FramePilot run debugger

**Priority:** P2/P3, but basic telemetry begins in Phase 0.

## Objective

Any bad edit should be diagnosable without guessing.

Record enough information to reconstruct:

- user request;
- model/provider;
- context manifest;
- evidence retrieved;
- tools offered;
- tools called;
- sanitized inputs;
- outputs/failures;
- project revision before;
- operations attempted/applied/rejected;
- validation results;
- project revision after;
- review findings;
- retry/recovery events;
- tokens/cost;
- latency;
- cancellation;
- final result.

## 14.1 Failure taxonomy

Every failed quality scenario should be assignable to one primary cause:

- retrieval/evidence;
- model/editorial decision;
- tool selection/schema;
- target resolution;
- command/compiler;
- operation/validation;
- host persistence/revision;
- preview;
- final render;
- perceptual review;
- recovery/cancellation.

## 14.2 Internal run debugger

Build an internal developer view only when the recorded data model is stable enough to justify it.

Example:

```text
RUN 92A1
Request: Make a 30-second beat-synced reel
Model: ...
Duration: ...
Cost: ...

00:00 inspect project
00:02 load beat-sync guidance
00:04 analyze audio
00:07 beats found
00:08 search footage
00:12 inspect candidates
00:18 apply 31 operations
00:20 revision 492 -> 493
00:22 review
00:24 2 findings
00:26 repair
00:29 revision 493 -> 494
00:31 complete
```

## Phase 9 exit criteria

- [ ] Failed evals can be causally classified.
- [ ] Run traces are bounded, privacy-aware, and useful.
- [ ] Developer can distinguish retrieval, reasoning, command, renderer, and review failures.
- [ ] Observability overhead remains within budget.

---

# 15. Phase 10, generic delegation only after convergence

**Priority:** P3.

## Objective

Add parallel intelligence without adding parallel mutation authorities.

Use one generic delegation primitive conceptually similar to:

```text
task.delegate
```

A child run should reuse the same session/runtime machinery with:

- parent run identity;
- focused prompt/objective;
- explicit tool permissions;
- bounded context;
- bounded depth/concurrency;
- structured result;
- no independent project mutation by default.

Recommended first child roles are read-only:

```text
Main Editing Agent
  +-- Footage Scout
  +-- Transcript Researcher
  +-- Visual Reviewer/Researcher
```

Do not create separate architecture for:

- CaptionAgent;
- BrollAgent;
- BeatAgent;
- ColorAgent;
- TrackingAgent;
- PacingAgent;
- AudioAgent.

Those are capabilities, skills, or tasks unless strong evidence proves they require an independent agent identity.

## Phase 10 exit criteria

- [ ] Child runs reuse the same runtime.
- [ ] Child permissions are restricted.
- [ ] Child writers are disabled by default.
- [ ] Delegation improves measurable latency/quality on selected compound tasks.
- [ ] Complexity increase is smaller than the measured gain.

---

# 16. Phase 11, deliberate architecture deletion

**Priority:** continuous after each convergence milestone.

Deletion is a roadmap item, not incidental cleanup.

Track these counts over time:

| Complexity metric | Target | Measured 2026-08-18 |
| --- | ---: | --- |
| mutating AI runtimes | 1 | **1** agent runtime, plus the single-shot `edit` proposal surface (Phase-1 follow-up) |
| project mutation authorities | 1 | **1** — `editor-core` |
| final render authorities | 1 | **1** — Python/FFmpeg |
| review writers | 0 | **0** — asserted per scenario by the conformance suite |
| AI-only editor mutation APIs | 0 | **0** |
| independent planning executors | 0 unless benchmark-justified | **0** — the planner executor was benchmarked and removed |
| user-visible orchestration modes that change safety semantics | 0 | **0** — `agent`/`chat`/`edit` share validation, revision and undo |
| stale architecture docs claiming retired systems | 0 | **0** — ADRs 0082/0084/0085 marked superseded rather than rewritten |

## Candidate deletion list after proven migration

Phase 1 result (`[x]` = deleted, `[-]` = kept with a reason):

- [x] `streamPlannedEdit`;
- [x] planner-only intent parsing (`proposers/intent-parser.ts`; `ProjectHeader`/
      `projectHeaderOf` moved to `command-classifier.ts`, their only surviving consumer);
- [x] plan compiler used only by planned-edit execution;
- [x] planned-edit graph executor / task graph / scheduler — none had a generic
      infrastructure consumer, so §6.4's "keep the scheduler under a tool" did not apply;
- [x] `recipe-leaves.ts` and `proposers/planner.ts` / `proposers/edit-proposer.ts`;
- [x] duplicate cost/cancellation/event logic (the `streamAuto` fallback cost re-seeding);
- [x] duplicate routing fallbacks (the declined-plan → agent continuation);
- [-] the effect runtime itself: still used by the agent, replay and the gateway — it is
      generic infrastructure below tools, exactly the §6.4 shape;
- [-] `createAnalysisBagWarmer` in `brain-client.ts`: its orchestrator option was
      planned-edit-only and is removed, but the brain read primitive is Phase-5 material.
      It currently has no production consumer — a tracked loose end, not a live path;
- [x] obsolete ADR status claims — 0082/0085 marked superseded, 0084 narrowed, history kept.

## Keep unless evidence says otherwise

- typed operations;
- validation before apply;
- deterministic target resolution;
- revision checking;
- undo/inversion;
- durable recovery;
- cancellation;
- context compaction;
- tool identity/idempotency where required;
- visual/audio evidence;
- read-only perceptual review;
- skills;
- Python/FFmpeg final rendering;
- realtime UI preview;
- LangGraph as a thin runtime host if it continues to earn its place;
- generic batch scheduling where used as infrastructure below tools/workers.

---

# 17. Recommended implementation PR sequence

Keep each PR coherent, reviewable, and independently useful. Avoid another mega-PR that introduces several new subsystems at once.

## Foundation

### PR 1: `test(ai): extend professional evals with agent outcome benchmarks`

- reuse current professional eval infrastructure;
- add initial canonical natural-language scenarios;
- capture run route and quality metrics;
- no runtime changes.

### PR 2: `chore(ai): add agent runtime quality telemetry`

- tool exposure/calls;
- invalid calls;
- tokens/model calls;
- latency;
- operations/rejections;
- revisions;
- review findings;
- bounded structured output.

### PR 3: `docs(ai): publish mutating execution architecture census`

- map all active execution routes and authorities;
- identify code that is runtime, infrastructure, or legacy/duplicated responsibility.

## Runtime convergence

### PR 4: `test(ai): benchmark planned-edit scenarios through primary agent runtime`

- comparison only where possible;
- capture parity gaps.

### PR 5: `feat(ai): close primary-agent capability gaps`

- tools, skills, retrieval, or editor commands only;
- no new orchestrator.

### PR 6: `refactor(ai): represent complex planning in primary agent state`

- preserve visible plan/activity semantics;
- keep current route available until parity is proven.

### PR 7: `refactor(ai): converge planned edits onto primary mutating runtime`

- route convergence after gates pass;
- preserve durability/cancel/review/undo behavior.

### PR 8: `refactor(ai): remove orphan planned-edit execution machinery`

- delete only proven dead/duplicate code;
- reclassify generic schedulers as infrastructure when still needed.

## Editing machine

### PR 9: `refactor(editor): define canonical editor transaction authority`

- document/strengthen command -> operation -> transaction semantics;
- avoid parallel package churn unless dependency evidence requires it.

### PR 10: `refactor(ai): make mutation tools thin editor-command adapters`

- remove AI-only mechanics.

### PR 11: `test(editor): add operation algebra and undo property coverage`

- exact restoration;
- stale revision;
- invalid sequence fuzzing;
- serialization/reload.

## Runtime/tool simplification

### PR 12: `test(ai): compare staged and reduced-stage orchestration policies`

- A/B evidence before deletion.

### PR 13: `refactor(ai): remove unearned behavioral orchestration policy`

- retain safety/runtime invariants.

### PR 14: `refactor(ai): dynamically scope effective tool surface`

- measure selection accuracy and schema cost.

## Intelligence and media semantics

### PR 15: `refactor(intelligence): unify evidence provenance and staleness`

- incremental, migration-safe extension of current project intelligence.

### PR 16: `perf(intelligence): prove bounded long-form retrieval`

- realistic large project benchmark.

### PR 17: `test(render): establish preview-export semantic parity matrix`

- canonical goldens/semantic measurements.

### PR 18: `feat(review): expand deterministic edit-quality checks`

- actionable findings only;
- reviewer remains read-only.

## Product control and scale

### PR 19: `feat(editor): harden professional manual and AI-control workflows`

- keyboard/manual benchmark;
- inspect/diff/steer/cancel/undo.

### PR 20: `feat(ai): add generic read-only child-run delegation`

- only if runtime convergence benchmarks are already healthy.

### PR 21: `test(release): gate critical agent-quality benchmarks`

- gate only stable, deterministic or appropriately controlled metrics;
- do not make subjective model variance a flaky unconditional CI blocker.

### PR 22: `refactor(ai): final convergence deletion pass`

- delete stale routes, adapters, docs, duplicated policy, and dead tests.

---

# 18. Rules for every PR in this program

Every implementation PR must answer:

## User outcome

What gets better for the person editing a real video?

## Current measured gap

Which benchmark/eval demonstrates the weakness?

## Minimum vertical slice

What is the smallest end-to-end change that proves improvement?

## Reuse

Which existing command, operation, tool, runtime, index, reviewer, render path, or UI primitive is being reused?

## Deferred scope

What tempting adjacent architecture or feature is intentionally not included?

## Evidence

What before/after metric, fixture, timeline state, rendered result, property test, or manual workflow proves completion?

## Deletion check

Did this PR make any old path redundant? If yes, delete it in this PR when safe or create a specifically bounded follow-up.

---

# 19. Stop rules

Stop and re-evaluate a proposed change when any of these are true:

- it introduces another mutating execution route;
- it creates another project source of truth;
- it gives another agent/reviewer direct write authority;
- it builds a new abstraction with only one speculative consumer;
- it adds a workflow engine to solve a missing editor capability;
- it uses prompt sophistication to hide a missing deterministic editor feature;
- it makes preview and export behavior diverge;
- it cannot name a user-visible outcome or measurable architectural risk reduction;
- it creates a large design document without a near-term executable vertical slice;
- it expands professional NLE breadth while the north-star edit benchmark remains weak;
- its complexity cost is larger than the measured quality/reliability gain.

---

# 20. North-star eval progression

The final judge of this program is not architecture elegance. It is editing performance.

## Level 1

Give FramePilot a real 5 to 15 minute SaaS demo or talking-head source.

Prompt:

> Turn this into a polished 45 to 60 second short. Keep the strongest hook, remove dead time and repetition, preserve the important message, add accurate captions, use tasteful emphasis/punch-ins, clean the audio, and export correctly for the target platform.

FramePilot should produce something the maintainer would plausibly publish.

## Level 2

Repeat across a representative suite and reach >=95% success for supported scenarios.

## Level 3

Use a 30 to 60 minute podcast/demo and preserve bounded context/retrieval behavior.

## Level 4

Interrupt the agent during work:

- cancel;
- steer;
- manually edit;
- continue;
- undo the run;
- resume/retry after failure;
- restart the application where durable semantics apply.

The agent must remain authoritative to the current project revision rather than hidden session state.

## Level 5

Verify that preview semantics match export semantics and that the final project remains fully editable, deterministic, inspectable, and reversible.

---

# 21. Definition of program completion

The FramePilot 9.5 Convergence Program is complete when:

- [ ] the benchmark table has measured evidence rather than subjective baseline estimates;
- [ ] canonical supported agent-edit scenarios achieve >=95% target success;
- [ ] the north-star raw-footage-to-finished-edit workflow is publishable-quality across representative projects;
- [~] there is one mutating AI runtime — `planned_edit` retired (ADR 0126); the single-shot
      `edit` proposal surface remains, see the Phase-1 follow-up;
- [ ] there is one authoritative editor command/transaction semantics per supported edit;
- [ ] there is one project truth and one final-render authority;
- [ ] review is read-only and cannot become a second writer;
- [ ] every AI mutation remains typed, validated, inspectable, revision-safe, and undoable;
- [x] planned-edit machinery is removed — the benchmark proved no unique value (ADR 0126);
- [ ] long-form retrieval scales with task complexity rather than source duration;
- [ ] preview/export semantic parity is proven for supported capabilities;
- [ ] professional manual editing workflows are measured and polished;
- [ ] AI inspect/activity/diff/steer/cancel/undo workflows are reliable;
- [ ] failure causes are observable and diagnosable;
- [ ] child delegation, if enabled, reuses the same runtime and is read-only by default;
- [ ] redundant architecture has been deliberately deleted;
- [ ] no new architecture path exists solely because one prompt was difficult;
- [ ] repository architecture docs agree on the live system.

The desired final mental model is intentionally simple:

> **OpenCode has a coding agent sitting on top of a computer. FramePilot should have an editing agent sitting on top of a professional video-editing machine.**

The machine owns correctness, state, timing, validation, rendering, revisions, and reversibility. The agent owns editorial reasoning and tool choice. The product wins when the resulting edit is good, not when the orchestration looks sophisticated.
