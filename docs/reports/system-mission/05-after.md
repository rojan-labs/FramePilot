# Phase 5 — Workers and lifecycle: after

## The decision rule, applied

`plan/system-mission/05-WORKERS-AND-LIFECYCLE.md` says a bounded-context specialist is
introduced **only** when the ledger shows, for a real scenario, at least one of: its
context is < 40 % of the main turn's; it can run concurrently with another step; or its
error rate drops with a narrower prompt.

Measured over **585 real requests** from the mission runs (`context_usage` manifests in
`reports/system-mission/runs/after-*.json`, p50):

| section | p50 tokens | share of a request |
| --- | --- | --- |
| **tool definitions** | **15,669** | **69.1 %** |
| additional request content | 3,945 | 17.4 % |
| transcript slice (when present) | 3,088 | 13.6 % |
| skills manifest | 1,649 | 7.3 % |
| session context | 521 | 2.3 % |
| source media | 240 | 1.1 % |
| system contract | 135 | 0.6 % |
| timeline summary | 91 | 0.4 % |
| media bin | 86 | 0.4 % |
| **total per request** | **22,671** | 100 % |

Splitting the tool block (88 tools, `estimateTokens` over the built registry):
**descriptions 8,748 · parameter schemas 7,553.**

## Candidate 1 — planner (plan-only prompt without tool schemas): **PASSES**

A request with the tool block removed is **7,002 tokens — 30.9 % of a main turn**, under
the 40 % threshold. The number is not marginal and it is not a projection: it is the same
manifest the runs actually reported, minus the section a planning step does not use.

The refinement the data suggests: a planner does not need to be told *nothing* about the
tools — it needs to know what each one can do, not how to call it. That is the
**descriptions (8,748) without the parameter schemas (7,553)**, so a planning request
lands near 15.8k rather than 22.7k, and the 7,553 tokens of JSON Schema — a third of every
planning request — buy nothing for a step that emits prose, not tool calls.

### Resolved 2026-08-29 — the accepted item was already landed, and the refinement fails the rule

The measurement above was taken from the manifests without reading the code that produces
the plan turn. `Orchestrator.generateAgentPlan` already sends **no tools at all**:

```ts
// No tools on a plan turn: the model must not call one here, so their schemas are
// wasted tokens and contradict the instruction (see plan()).
const response = await this.completeModel({ messages }, signal, effectRuntime);
```

So the plan-only prompt is not a specialist waiting to be built — it is the one that has
been running, and 7,002 tokens / 30.9 % is a description of production, not a projection.
Re-measured independently over **706** `context_usage` manifests (all of
`reports/system-mission/runs/after-*.json`, not the 585 the table above used): p50 total
**19,172**, tool definitions **14,939 (77.9 %)**, request without the tool block **5,187
(27.1 %)**. Different sample, same verdict, comfortably under 40 % either way.

That reframes the refinement. Adding the descriptions is not a saving against a
22,671-token planning request that never existed — it is a **cost against the 7,002-token
one that does**:

| planner request | tool tokens | request p50 | share of a main turn | 40 % rule |
| --- | --- | --- | --- | --- |
| full tool block (the hypothetical baseline the table above compared against) | 15,669 | 22,671 | 100 % | fails |
| **descriptions without parameter schemas** (the proposed refinement) | 8,748 | **15,750** | **69.5 %** | **fails** |
| **no tool block — what ships today** | **0** | **7,002** | **30.9 %** | **passes** |

The description/schema split reproduces exactly: `estimateTokens` over the 88 built tool
specs gives names 339, **descriptions 8,748**, **parameter schemas 7,553**.

**Not implemented, and the number is the reason.** The refinement's premise — that a
planner emitting prose has no use for 7,553 tokens of JSON Schema — is correct and is
already honoured in the strongest available form: it gets neither the schemas nor the
descriptions. Adding the descriptions back would take the plan turn from 30.9 % to 69.5 %
of a main turn and break the very threshold that admitted this specialist. Phase 5's rule
does not have an exception for a specialist that has already passed.

What the refinement was really pointing at is a real gap, stated here so it is not
rediscovered as a saving: the plan turn is told nothing about the editor's tool surface,
so its steps are grounded in the skills manifest and the request alone. The headroom under
the rule is 9,068 − 7,002 = **2,066 tokens**, and the tool *names* cost 339. A bounded
capability digest — names, grouped, no descriptions and no schemas — would fit that
headroom five times over. It is not landed here because its benefit is plan *quality*,
which this session cannot measure: the mission harness needs a live provider and the
bridge rate-limits. Landing an unmeasurable prompt change to close a task is the failure
mode Phase 5 exists to avoid. It carries into Phase 2 with the evidence it needs: a
three-run mission delta on the rubric, not a token count.

## Candidate 2 — media-analysis summarizer: **REJECTED, with the number that rejected it**

The premise was that turning a raw footage map into structured facts is expensive enough to
deserve its own bounded step. The ledger says it is not: across 585 requests the footage
map does not appear in the ten largest sections at all, and `source media` — the block that
carries the per-asset facts — is **240 tokens, 1.1 % of a request**.

There is nothing to save. A specialist here would add a model call, a contract and a
failure mode in exchange for roughly a fifth of one percent of the context. Rejected.

## Candidate 3 — critic judgment: **already a specialist**

It already runs through `proposerModelEffect` on a small tier with its own prompt
(`CRITIC_JUDGMENT_SYSTEM_PROMPT`, 140 tokens) and its own manifest budget. Nothing to
introduce; it is the shape the other candidates were measured against.

## Typed contracts for the existing specialists (P5.1)

`src/specialists/` — `SpecialistInput { task, context, constraints, inputs }` →
`SpecialistOutput { outputs, artifacts[], confidence, errors[] }`, zod-validated in both
directions. Seven specialists declared: audio, color, motion, timeline, tracking-mask,
automatic-tracking, subject-detection, plus the Critic proposer.

The controllers were already bounded specialists in behaviour — pure functions from a
slice of host state to editor commands. What they lacked was enforcement of either half.
Each declared its own result union (six shapes saying the same four things: commands,
evidence, facts, a rejection code), and each call site hand-assembled its input from the
whole `ToolContext`, so the slice a controller reads existed only as the shape of an
object literal in a domain tool.

Both are now stated once and checked. A specialist declares its slice; `sliceOf` projects
the `ToolContext` down to it, so a call site never sees the context to over-share from it;
the envelope is `.strict()`, so an undeclared field is a `SpecialistContractError` naming
the specialist rather than a habit. The visible consequence: `professional_color` is the
only tool permitted to read run-scoped host measurements (`evidence`), and that is now a
declaration a test asserts across all seven, not a fact you had to notice.

What is deliberately not re-validated: `context.project` was parsed by
`@framepilot/timeline-schema` and `context.interaction` by
`captureEditorInteractionContext`. Re-running a deep parse of a minutes-long timeline at
every tool call would spend real time re-deriving a guarantee the boundary above already
gives. The envelope checks identity and shape and leaves the deep contracts to the schemas
that own them.

`confidence` is 1 or 0 for the deterministic controllers and says so: a controller resolves
its target from authoritative editor state or it refuses, and inventing a spread would make
the field lie in the one place a reader would trust it. It is a number rather than a boolean
because the Critic's verdict genuinely is graded — the share of its deterministic checks
that held — and a shape that could not express that would have pushed the Critic back out
of the contract.

23 tests, including the Done-when: for each of the seven, the input built for it contains
no field outside its declared slice, and an input carrying one is refused.

**Residual:** `resolveAutomaticTrackingObjective` / `resolveSubjectDetectionObjective` are
declared here, but their only production caller is
`apps/desktop/electron/ai/automatic-tracking-executor.ts`, outside this change. Adopting
`runSpecialist` there is what remains.

## Lifecycle (P5.3, P5.4, P5.5)

- **Registry** — `electron/process-registry.ts`: every child registered with owner,
  purpose, started-at, optional timeout and a cancel handle, moving through
  `created → ready → running → idle → failed → recovering → terminated`. `will-quit` walks
  it as a backstop, so a child added by later code cannot silently opt out of shutdown.
  10 tests.
- **Crash recovery** — the pidfile is the part nothing else could do: written
  synchronously (the one sync write in `userData`) so it survives a process that died
  without running a single handler, and swept on the next launch. Liveness-checked first,
  because a pid is reused and killing a stranger is the worse failure.
- **Duplicate suppression (P5.4)** — `engine/python/framepilot_engine/singleflight.py`
  coalesces identical in-flight requests on `/asset-media`, `/analyze-silence` and
  `/detect-beats`: six identical concurrent callers produce **one** ffmpeg derivation and
  all six are served. Concurrency caps already existed (asset-media, temporal evidence,
  visual index, one encode); duplicate suppression was the missing half.
- **Recovery (P5.5)** — an engine that dies after becoming ready is restarted, bounded,
  with 1s/2s/4s backoff and the cause in `status.detail`; `stop()` during the backoff
  cancels it and resets the budget; an exit during startup stays a plain start failure.
  6 tests.

## What this phase deliberately did not build

No new model workers, no message bus, no plugin runtime. Two of the three candidates were
rejected by measurement and the third is accepted-but-unlanded; the phase's own rule is
that a worker without a ledger row justifying it does not get built, and honouring that
rule is the result, not a shortfall against it.
