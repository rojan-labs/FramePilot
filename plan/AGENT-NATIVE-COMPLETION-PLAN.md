# FramePilot — Agent-Native Completion Plan

> **2026-07-27 supersession:** model-tier provider dispatch and its Settings/env surface
> were removed by ADR 0078. Tier labels now describe cost classes only; one active
> provider owns each complete request. Historical tier-routing tasks below are retained
> as delivery history, not current runtime requirements.

> **Status:** `[~]` in progress (rev. 2026-07-11). The end-to-end roadmap that turns the
> **built-but-partially-integrated** orchestration kernel into a **mature, top-notch
> agent-native video editor** — taking the *orchestration-engine* bar from
> Cursor/Windsurf/Claude-Code (§2) but **reorienting every UX decision around a video editor,
> not a coder** (§2.5, the lens). Companion to
> [`AI-ORCHESTRATION-REDESIGN.md`](./AI-ORCHESTRATION-REDESIGN.md) (the architecture,
> ADR 0044): that doc says *how the kernel is designed*; **this doc says how to make it
> run the whole product to a mature bar — for editors.**
>
> **Audience:** the person filling these gaps. Each task is written so you can pick it up,
> implement it, and check it off with a green `pnpm verify`.
>
> **This revision (2026-07-10b):** re-audited the live code end to end (UI → session →
> orchestrator → kernel → tools/effects → engine → MCP), rewrote the plan around a
> **maturity model** (§2), then added **§2.5 — the video-editor lens**: Cursor/Windsurf are
> coder tools for a textual artifact, and our user is a creative judging a *perceptual* one.
> Where the coder bar and the lens conflict, the lens wins. New editor-first work lives in
> **P13** (variations, creative-language refinement, footage search, platform-aware export)
> with content-understanding (Appendix B) and long-horizon runs (Appendix A) deferred. The
> spine is lit; the remaining work is *maturity* — surfaced the way an editor thinks.

---

## 0. Current reality — a grounded snapshot (2026-07-10 re-audit)

The recipe spine and the streaming agent loop are **live and load-bearing**. The parallel
planner path is **live but narrow** (browser-only, gated to recognized plan shapes). A
cluster of maturity modules (cost meter, replay, saga recovery, the Critic proposer,
per-tier model dispatch) are **built, unit-tested, and dark**. This table is the honest
state a grep for non-test callers returns today:

| Capability / module | Built | Tested | Live on real runs? |
|---|---|---|---|
| Router (`routeCommand`, 4 kinds) | ✅ | ✅ | ✅ (but `direct_edit` kind unreachable — UI never passes `hasSelection`) |
| Recipe spine (`compileRecipe`→scheduler→leaves→patch) | ✅ | ✅ | ✅ 6 recipes, **0 model calls** |
| DAG scheduler (`nextDispatch`) + `graph-executor` | ✅ | ✅ | ✅ (recipe + planned-edit) |
| Proposers `IntentParser`/`Planner`/`EditProposer` | ✅ | ✅ | ◑ `streamPlannedEdit` only — **browser-only, gated** to recognized plan shapes |
| Streaming agent loop (Conductor/`runConductor`) | ✅ | ✅ | ✅ — but **sequential** (model-as-scheduler), *not* the parallel DAG |
| Deterministic Critic battery (`critique()`, 8 checks) | ✅ | ✅ | ✅ **agent path only**; recipe/planner `verify` = structural patch-validity only |
| `Critic` proposer / `runCritic` (scheduled verify node) | ✅ | ✅ | ❌ 0 |
| Semantic Index (`semanticIndexFor`) | ✅ | ✅ | ◑ computed, but only **cardinalities** reach the Planner; analysis slices honestly empty |
| Model-tier routing (`DEFAULT_TIER_ROUTING`/`tierModel`) | ✅ | ✅ | ❌ 0 at call time — tiers are declarative metadata; single provider dispatched |
| Cost meter (`CostLedger`, `priceModelCall`) | ✅ | ✅ | ✅ (P7.1) — recipe runs price **0**, planner/agent-model tasks price real usage |
| Replay (record/replay runtimes) | ✅ | ✅ | ◑ (P7.3) — opt-in `Orchestrator.recordEffects`, off by default; no dev panel yet (P7.5) |
| Saga recovery (`recoveryFor`) | ✅ | ✅ | ◑ (P7.4) — `plan-driver.ts`'s model-effect throw path now consults the table; host-tool/agent-loop paths still ad-hoc (documented, deliberate) |
| Memory store (read + accept/reject write) | ✅ | ✅ | ✅ read into every context; accept/reject persisted |
| MCP server surface | ✅ | ✅ | ✅ — but **single-shot `assembleEdit`**, *not* the recipe/planner kernel |
| Parallel "what's running" view (`view.tasks`) | ✅ (data + UI, P8.2) | ✅ | ◑ `TaskRunView` renders it in `AiSidebar`; **no live path emits `task_started` yet** (`graph-executor.ts`'s emitter is unwired into `streamRecipe`/`streamPlannedEdit`) |
| Selection scoping (`AiSessionInput.selection`) | ✅ (transport+IPC) | ✅ | ❌ sidebar never populates it — dark on both surfaces |
| Cmd+K direct edit | — | — | ❌ absent (route unreachable, no keybinding) |
| Cost/token/budget UI | ✅ | ✅ | ◑ (P7.2) — creator-language usage chip on every priced run + a dev/pro raw-numbers toggle; no budget-cap UI yet |

**The one-paragraph truth (rev. 2026-07-10):** The kernel is no longer dark code. The
deterministic recipe path is genuinely instant and model-free; the streaming agent loop is
a real bounded autonomous run with verify + repair + spin-guard + checkpoint/resume. **But
the path users take in "Agent" mode is still the *sequential* Conductor loop** (model
schedules itself, one tool at a time), and the *parallel* proposer+DAG path is a
browser-only, shape-gated probe that falls back to that sequential loop for anything it
doesn't recognize. The remaining work is not "turn on dark code" — it is **maturity**:
make the parallel path the norm, reach parity across desktop and MCP, make runs
observable and recoverable, close the perceived-latency gap, and verify with a real
battery on *every* path — so the product feels like an engine on every surface, not just
in the happy-path demo.

---

## 1. Guardrails (do not break these while maturing)

Every task honors the invariants already in force (AGENTS.md, CLAUDE.md, ADR 0044):

1. **Build order:** engine → render/validate → AI → agent. A leaf-executor's Python engine
   ships *before* the recipe/plan that calls it. **Never fake an analysis result.**
2. **AI emits patches only** — validated, invertible `editor-core` operations, through the
   single `operationsForCall` trust boundary. No raw JSON mutation, ever.
3. **No schema change without a migration + doc + tests.**
4. **Render vs. preview wall stays absolute** (MoviePy renders; UI previews with HTML/canvas/proxy).
5. **One policy across the in-app surfaces** — browser and desktop drive the *same* kernel;
   no per-host orchestration fork. (Today desktop-`planned-edit` throws — P6 closes it.) The
   **MCP server is a deliberate exception**: external agents get the single-shot `assembleEdit`
   path, which still shares the canonical tool registry, the `operationsForCall` trust boundary,
   the sandbox, and path-hiding — so the *safety* policy is one, even though the *orchestration*
   is not. Converging MCP onto the full kernel is an explicit **non-goal** for this roadmap.
6. **Honesty:** no fabricated success, no green "passed" for a run that did nothing, no
   CHANGELOG/plan claim ahead of the code. A gate that isn't wired says so.
7. **Every new live path gets an integration test**, not just isolated unit tests — the
   central lesson of the original audit.

---

## 2. The maturity model — what "mature like Cursor/Windsurf/Claude Code" means here

The bar those tools set, translated to a video editor with chat + manual/autonomous agent
modes. Each capability maps to the phase that closes its gap, so the roadmap is provably
complete against the bar.

| # | Mature-agent capability | FramePilot today | Gap → phase |
|---|---|---|---|
| M1 | **One unified agent kernel on the in-app surfaces** | Browser drives 6 modes on the kernel; desktop `planned-edit` throws | **P6** |
| M2 | **Model proposes, kernel schedules a parallel DAG** — concurrent analyses, structured plan | Live for recipes (0-model) + a gated planner slice; the *user-facing agent mode* is still a sequential loop | **P3, P11** |
| M3 | **Real-time streaming feedback** — thinking, tool cards, *simultaneous* "what's running" | Tool cards + reasoning shimmer + plan checklist live; parallel-task data computed but **no UI** | **P8** |
| M4 | **Inline / selection-scoped quick edit** (Cmd+K "tighten this") | Absent — route unreachable, selection plumbed but unfed, no keybinding | **P8** |
| M4b | **Context attachment / @-mentions** — pin specific clips/assets/ranges/markers as context | Absent — only whole-project context; selection unfed | **P8** |
| M14b | **Mid-run steering** — redirect a running agent without stop+restart | Absent — only Stop + checkpoint-resume | **P11** |
| M5 | **Cost / token / budget observability** | Absent — cost meter dark, no usage events, no budget UI | **P7** |
| M6 | **Semantic context retrieval** — index the project, feed the model *slices* not dumps | Index computed but only cardinalities consumed; analysis-fed slices empty | **P4** |
| M7 | **Model-tier routing** — cheap model to classify, strong model to edit | Declarative metadata only; a single provider is dispatched for every tier | **P3.4** |
| M8 | **Checkpoint / resume / one-click undo** | ✅ Live and solid (keep; extend to multi-step collapse) | maintain + **P8.5** |
| M9 | **Rules / project memory / learn from accept-reject** | Memory read into context + accept/reject persisted; no explicit accept-vs-reject reasoning | **P9** |
| M10 | **Graceful degradation / offline / local model** | Ollama provider exists; offline recipe degradation unwired; unset engine URL silently disables analysis | **P5** |
| M11 | **Error recovery / saga** — tier fallback, rebase, route-around | `recoveryFor` dark; recovery ad-hoc; no automatic tier fallback | **P7** |
| M12 | **Verify before commit** — a real battery, not just "does it parse" | Real 8-check battery on the agent path; DAG paths only assert patch validity | **P11** |
| M13 | **Replay / determinism regression** | Record/replay runtimes dark | **P7** |
| M14 | **Autonomous agent with approval gates** | Bounded 8-step single-request loop; no plan-approval gate | **P11** |
| M14c | **Long-horizon multi-segment runs** | Single bounded run per submit | **Appendix A** (deferred — not part of the mature bar) |
| M15 | **External-agent (MCP) surface** | Single-shot `assembleEdit` on the shared tool registry + trust boundary — **accepted divergence, not planned to converge** (see P6) | — |

**Design principle for maturity (the through-line):** *converge* — the recipe path, the
planner path, the agent mode, and desktop should all drive the **same** in-app kernel
(compile → schedule → propose → effect → verify → patch), differing only in the *front
door* and the *proposer budget*. Every phase below moves one more in-app entry point onto
that single spine and adds one more mature affordance to it. Divergent in-app paths
(desktop's throwing `planned-edit`, the sequential-only agent loop) are debt to be retired.
The **MCP server stays single-shot by decision** (§1.5) — it shares the safety policy, not
the orchestration — so it is out of the convergence scope.

---

## 2.5 The video-editor lens (why we are NOT building Cursor)

Cursor/Windsurf set the *orchestration-engine* bar, and §2 adopts it. But their **user is a
programmer** and their **artifact is text** — and a video editor is neither. Benchmarking
UX against them uncritically imports coder-brained assumptions that are wrong for our user.
This section is the corrective lens; where a §2 capability conflicts with it, **this lens
wins.**

**The seven ways our user differs — and what each demands:**

1. **The artifact is perceptual, not textual.** A coder reads a diff and *knows*. An editor
   must **watch and hear** the result — an op-level "before/after" (trim 0.3s, ripple-delete
   range) is meaningless to them. → **Review must be preview-first: play the before/after,
   not describe it.** This is the plan's single biggest coder-brained flaw (see the P8.5/P12.6
   rewrite). The hard-disabled Preview button is a symptom.

2. **Quality is taste, not correctness.** Code compiles or it doesn't; a cut "feels right" or
   it doesn't, and no battery can judge that. → **The human watching *is* the verify step.**
   The autonomous verify battery (P11 Track B) should own **technical safety** (duration,
   safe-area, audio-clipping, missing assets) and then **get out of the way fast** for the
   taste call — never pretend to score aesthetics.

3. **The workflow is iterative refinement around a moving picture.** "No, tighter." "Bring
   the music down there." "Hold on her face." Editors refine by **pointing at a moment and
   reacting.** → The **point-on-timeline/player → react → AI adjusts** loop is *the* core
   interaction, not the chat composer. Mid-run steering (P11.4) and context pinning (P8.7) are
   the seeds; the loop must be first-class, not a sidebar feature.

4. **They try alternatives.** "Show me two openings." Creative work is comparative; there is
   no single right answer. → **Variations / A-B compare** is a first-class capability
   (new P13) — something coder tools barely have and editors need constantly.

5. **They think in footage and story, not files and functions.** "Find the clip where she
   laughs." "Where do I mention pricing?" → Semantic retrieval must cover **raw-footage
   content search** (visual + transcript + audio), not just timeline slices (P4 widened; the
   frontier is content understanding — Appendix B).

6. **Many are not technical.** "DAG," "recipe," "planner," "kernel," **"tokens"** — none of
   this exists for a short-form creator. → **Hide the machinery.** Speak edits, not
   operations. And **cost is coder-brained**: an API-metered programmer watches a token
   budget; a creator on a subscription does not. Reframe user-facing "cost" as friendly
   **usage** ("AI edits this month"), keep the token/$ meter as an *engineering* instrument,
   not a prominent creator gauge (see the P7/P12 reframes).

7. **Render is the slow, expensive deliverable — and platform-specific.** Coders build in
   seconds; a render is minutes and the *final product*, bound to platform specs (9:16 Reels,
   burned-in captions, loudness targets). → **Export/delivery intelligence** is part of the
   product, not just an action tool (P13).

**The division of labor that follows from all of this** (the frame the whole plan should
adopt): **automate the mechanical, assist the creative.** Recipes (0-model, deterministic:
remove silence, add captions, sync to beat, normalize audio) do the tedious work editors
hate — *ship these aggressively.* The planner/agent (creative: story, pacing, hook,
montage) *proposes and the editor judges by watching* — never fully autonomous over taste.
This is exactly the recipe-vs-planner split we already have; the plan should **name it as
the product thesis**, not treat it as an orchestration detail.

---

## 3. Dependency map (what unblocks what)

```
   ┌──────────────────────────────────────────────────────────────┐
   │ SHIPPED SPINE: honesty pass (P0) · recipe spine (P1) ·         │
   │ 6 recipes (P2) · gated planner path, 2 plan shapes (P3.1/P3.2) │
   └──────────────────────────────────────────────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────────┐
        ▼                        ▼                             ▼
   P3.4 Tier routing       P4 Semantic retrieval         P5 Engine reach
   (cheap/strong split)    (ingest analysis, slice)      + offline/local
        │                        │                             │
        └───────────┬────────────┴──────────────┬──────────────┘
                    ▼                            ▼
   P6 In-app surface parity           P7 Economics & observability
   (desktop planned-edit + agent)      (cost meter, budget, replay, saga recovery)
                    │                            │
                    └─────────────┬──────────────┘
                                  ▼
   P8 Perceived-latency & agent-native UX
   (parallel "what's running" view, Cmd+K + selection, streamed diffs, prefetch)
                                  │
                                  ▼
   P11 Agent-mode maturity & verification parity  ◄── the maturity keystone
   (converge agent mode onto the DAG kernel; real Critic battery on ALL in-app paths;
    plan-approval gating; mid-run steering)
                                  │
        ┌─────────────────────────┴─────────────────────────┐
        ▼                                                     ▼
   P9 Workflow memory (get-cheaper loop)          P10 Product hardening
                                                    (full-kernel e2e, security, perf, docs)
```

**Critical path to maturity:** the spine (P1–P3.2) is done. The keystone of *maturity* is
**P11** — converging the agent mode onto the parallel kernel and verifying every path with
a real battery — but it depends on P3.4/P4 (so the converged path is cheap and
context-aware) and pairs with P8 (so concurrency is *visible*). Do P3.4 + P4 + P8's
parallel view first; they are individually shippable and de-risk P11.

---

## ✅ Completed record (the shipped spine — kept for provenance)

> These phases are done and verified. Their **honest deferrals** are the pointers into the
> remaining phases below — read them as "what maturity still owes."

### P0 — Honesty pass — **SHIPPED (2026-07-08)**
- [x] **P0.1** Honest empty-run notice + question→chat routing (`ai/runOutcome.ts`, `AiSidebar.runTurn`).
- [x] **P0.2** Corrected the CHANGELOG router overclaim to "recognises" until recipes execute.
- [x] **P0.3** Added an "integration status" note to ADR 0044 pointing at this plan.

### P1 — The recipe spine: ONE recipe, end to end — **SHIPPED (2026-07-08)**
- [x] **P1.1** `analyze_silence` engine (ffmpeg `silencedetect`) via FastAPI sidecar + CLI, golden-tested parser.
- [x] **P1.2** Built the `recipe-executor` + `recipe-leaves`: first live driver of `nextDispatch`/`compileRecipe`/`buildTaskGraph`/`EffectRuntime`. 100% coverage.
- [x] **P1.3** Wired `Orchestrator.streamRecipe` + `AiSession` recipe mode (browser + desktop-local), **0 provider calls asserted via spy**, honest degradation when the engine leaf is unavailable.
- [x] **P1.4** Integration tests: `remove_silence` end to end → valid + **invertible** patch, 0 provider calls, plus empty/unavailable/cancelled/failed paths. *Follow-up: Playwright sidebar e2e → P10.*

### P2 — Generalize the recipe set — **SHIPPED (2026-07-08)**
- [x] **P2.1** `add_captions`, `improve_pacing`, `add_hook`, `punch_in` as pure reversible leaves (0 model calls); `export_reels` routes honestly to Export.
- [x] **P2.2** "Recipe · 0 tokens" chip after a real recipe edit.
- [x] **P2.3** Per-recipe goldens: 0 provider calls, valid + reversible patches, honest no-track/already-on-hook/export paths. ai-sdk at 100% coverage.

### P3.1 / P3.2 / P3.3(partial) — Live planner path (gated) — **SHIPPED (2026-07-08)**
- [x] **P3.1** First live dispatch of `IntentParser`/`Planner`/`select_shots` (beat-sync montage), driving the *same* `nextDispatch` scheduler via a shared `runGraph`. Bounded to 3 model calls on the happy path. Real host-tool payload shapes (`detect_beats`/`detect_scenes`).
  - *Deferred → P3.2/P4:* `montage.ts`'s `Cut` carries no source in/out (clips play from source 0); Planner's bounded input has no asset-id list, so a *live* Planner can't name concrete assets yet (proven with a mock provider).
- [x] **P3.2** Generalized the gate: replaced the one-scenario `isMontageShapedPlan` with a **structural** `isRecognizedPlan` (accepts any plan whose every task names an effect this driver runs). Added the general-purpose `propose_edit` model task via the real `EditProposer`, scoped to `mutate`-kind tools, with `sliceFrom` upstream-analysis threading and trust-boundary validation. Extracted the shared `operationsForCall` so the sequential loop and `propose_edit` build ops through the exact same code. Proven live on a second, structurally different plan (`analyze_silence → propose_edit(ripple_delete) → assemble_patch → verify`).
  - *Deferred → P11:* real `Critic` battery in `verify` (still structural patch-validity); *action*/*analysis*-kind tools inside `propose_edit`.
  - *Deferred → P6:* desktop parity (`planned-edit` throws on desktop). → P3.4 tier routing. → P4 semantic slices.
- [x] **P3.3 (partial)** `streamAgent` stays as the fallback: `AiSidebar` tries the live planner path first only for **Agent-mode, `plan`-kind, browser** commands; on the honest "not supported yet" notice it silently reruns on the user's original mode. Desktop untouched (throws loudly if `planned-edit` ever reaches it — a caller bug, not a silent misroute).

---

## P3.4 — Model-tier routing, live (cheap classify, strong edit) — [M7] — **SHIPPED (2026-07-10)**

- [x] **P3.4.1** `ModelEffect` now carries the proposer's declared tier
      (`proposerModelEffect` stamps it); `effect-runtime.ts`'s `runModel` resolves
      `deps.providers[effect.tier ?? 'mid'] ?? deps.defaultProvider` instead of always
      calling one injected provider. `createTierProviders` (`providers/index.ts`) builds
      one provider instance per distinct `{provider,model}` pair referenced by the routing
      — `resolveTierRouting` finally has a live consumer.
- [x] **P3.4.2** Honest degradation: the orchestrator only populates a tier's entry in
      `providers` when it was **explicitly** configured (a settings override or
      `FRAMEPILOT_TIER_*_PROVIDER/MODEL` env var — `isTierExplicit`). An undialed
      deployment keeps today's exact behavior — every tier collapses to the single
      `defaultProvider` — rather than silently constructing a fresh, unconfigured client
      from `DEFAULT_TIER_ROUTING`'s hardcoded `anthropic` default (which would have been a
      real behavior regression for every existing single-provider setup, not just a test
      artifact).
- [x] **P3.4.3** `planned-edit-stream.test.ts` asserts a planned-edit run's IntentParser/
      Planner/select_shots model effects carry `tier: 'small'`/`'mid'`/`'mid'`, that an
      explicitly-configured tier is actually used (a "poison" provider that throws if
      called proves the *other* tier wasn't dispatched to it), and that the empty-config
      case collapses every tier to `defaultProvider`. `effect-runtime.test.ts` covers the
      dispatch/fallback/collapse cases directly.

**Follow-up (not required for the mature bar, tracked for later):** no provider strategy
decision has been made yet on *which* concrete cheap/strong models to wire per tier in
production — `DEFAULT_TIER_ROUTING` still points every tier at the same `anthropic`
config; a maintainer sign-off (CLAUDE.md §5) on an actual multi-provider tier split
(e.g. Groq/Ollama for small) is a product/cost decision, not an engineering gap.

---

## P4 — Semantic index that actually reasons like an editor — [M6]

Today `buildSemanticIndex` populates project-derivable slices (`layers`, `dialogue`,
`captions`, `transitions`, `effects`, `music`) but the analysis-fed slices are hardcoded
empty (`shots:[]`, `silences:[]`, `beats:null`, `speedRamps:[]`, `markers:[]`,
`broll:[]`), and only their **cardinalities** reach the Planner (via
`summarizeSemanticIndex`). The rich context the redesign promises is computed and thrown
away.

- [x] **P4.1** Ingest analysis results into the index — **SHIPPED (2026-07-10)**:
      `buildSemanticIndex(project, analysisResults?)` now maps a real `detect_scenes` →
      `shots`, `analyze_silence` → `silences`, `detect_beats` → `beats`, translating each
      from the analyzed asset's source-media time into timeline time through every clip
      that actually places that asset (`ProjectIndex.clipsOfAsset`) — an asset not (yet) on
      the timeline honestly contributes nothing, never a fabricated placement.
      `semanticIndexFor(project, analysisResults?)` is now a two-level cache (Project
      snapshot → content-hash of the analysis bag), so it stays memoized per (project, bag)
      pair instead of rebuilding on every call. `plan-driver.ts`'s `propose_edit` task folds
      every `detect_scenes`/`analyze_silence`/`detect_beats` task **this run has already
      completed** into the bag before its own model call — unblocking P3.1's known gap (a
      live proposer can now reason over concrete, already-detected shots/beats instead of
      bare counts). `speedRamps`/`markers` stay honestly empty — no op/schema exists yet to
      feed them (unchanged; not part of this ship).
- [x] **P4.2** Structured per-proposer **slice retrieval** — **SHIPPED (2026-07-10)**: new
      `getSlice(index, { timeRange?, layerId?, kinds? })` (`semantic-index-slice.ts`) filters
      the index down to what a step actually needs — dialogue/captions/shots/silences by
      time-range overlap, layers/music/captions by track id, beats by grid overlap; kinds
      restricts which categories come back at all. `EditProposer`'s `slice` field is now
      real sliced data (this run's own analyses, scoped by an optional `args.timeRange/
      layerId/kinds` on the plan step) instead of an ad hoc single-upstream-task value; the
      Planner's request now also carries the real project-derived slice (dialogue/captions/
      layers/music/transitions/effects) alongside its existing cardinality summary — not
      just bare counts. (Transitions/effects carry no timeline position in the index today,
      so a time-range/layer query can't narrow them honestly — documented in
      `semantic-index-slice.ts`, not silently pretended.)
- [ ] **P4.3** Token-delta measurement (performance-monitor): prove prompt tokens scale
      with the slice, not the project, on a large timeline. Gate against regression.
- [ ] **P4.4** **Footage content search** (lens §2.5.5 — the editor's version of "search the
      codebase"): index *raw footage*, not just the timeline, so the editor can ask "find the
      clip where she laughs," "where do I mention pricing," "the wide shot of the ocean." Back
      it with what already exists — the **transcript** (word-level, per-asset) for speech, and
      `detect_scenes` for shot boundaries — exposed as a `find_footage` read tool the planner
      and the user can call. (Visual/semantic "what's *in* the frame" search is the frontier —
      Appendix B — but transcript + scene search delivers most of the value now.)

**Acceptance:** the Planner/EditProposer reason over "dialogue 12–18s" + "beat grid," not
clip JSON; prompt tokens scale with the slice, not the project; a live Planner can name
concrete assets (closing P3.1's deferral); and "find the clip where I say X" returns the
right footage from the transcript, not a dead end.

---

## P5 — Analysis-engine reachability & graceful degradation — [M10]

The sidecar is real and tested, but an **unset `VITE_FRAMEPILOT_PYTHON_API_URL` silently
disables silence/scene/beat** in the browser, and there is no offline story for novel work
beyond the Ollama provider merely existing.

- [x] **P5.1** Make the analysis engine reachable on the browser dev/deploy path — **SHIPPED
      (2026-07-10)**: `apps/web-editor/.env.example` documents `VITE_FRAMEPILOT_PYTHON_API_URL`
      (defaults to the desktop shell's own `127.0.0.1:8765`). `browserOrchestratorOptions`
      (`editor/ai.ts`) now fires a dev-mode-only, once console warning when the var is unset,
      so a developer isn't silently confused about why `analyze_silence`/`detect_scenes`/
      `detect_beats` report "no analysis engine is connected" — the executor still stays
      unwired on an explicit unset (a guess would fabricate a connection that may not exist).
      The desktop app already spawns + health-probes its own sidecar unconditionally
      (unchanged — read, not edited, for this ship).
- [x] **P5.2** Graceful offline degradation — **SHIPPED (2026-07-10)**: analysis-dependent
      recipes already reported honestly through the existing `effect-runtime.ts` honest-fail
      branch (unchanged string, verified); this ship adds the missing *visibility* half —
      Settings' provider list now labels **Ollama** "Offline · no network required" so it
      reads as the first-class offline option for novel/planner work it already was
      (registered, keyless-ready) but wasn't surfaced as. (Ollama remains a **model**
      provider only — it cannot run `detect_scenes`/`analyze_silence`/`detect_beats`; those
      still need the sidecar via P5.1/P5.3, never routed to Ollama.)
- [x] **P5.3** Surface engine availability as a **status chip** in the sidebar — **SHIPPED
      (2026-07-10)**: new `EngineStatusChip` (`components/ai/EngineStatusChip.tsx`) probes
      `GET {baseUrl}/health` (new `probeEngineReachable`, `editor/ai.ts`, mirroring the
      desktop shell's own `probeHealth`) on mount and again on window focus, rendering
      unknown/reachable/unreachable using the sidebar's existing `.ai-tone` status colors.
      Mounted in `AiSidebar` directly above the "model not ready" `.ai-apikey` banner it
      pairs with, before the composer, so the user sees analysis-engine reachability before
      asking for a beat-sync montage or silence removal.

**Acceptance:** no request ever silently no-ops for a missing engine — it either runs or
explains; as much as possible works offline; the user sees capability *before* asking.

---

## P6 — In-app surface parity: one policy, two wires (browser + desktop) — [M1]

The single-policy invariant is violated in one place in-app today: **desktop `planned-edit`
throws** (and the converged agent path from P11 must reach desktop too). The MCP server's
single-shot `assembleEdit` path is an **accepted divergence** (§1.5) — explicitly *not* in
scope for this phase.

- [ ] **P6.1** Thread `history` + `selection` through the desktop AI IPC into the
      main-process context (today history/selection/userMemory/agentOptions are parsed and
      threaded, but confirm selection reaches the context builder end-to-end once P8's
      selection feeding lands) — desktop agent runs become as coherent and selection-scoped
      as the browser.
- [ ] **P6.2** Bring `planned-edit` (and the converged agent path from P11) to **desktop**:
      either run the planner driver locally in the renderer (as `recipe` already does) or
      thread it over IPC — chosen for security parity, not convenience. Retire the throwing
      stub.
- [ ] **P6.3** Cross-surface parity test: the same command produces the same plan/DAG (and
      the same verify verdict) on **browser and desktop**.

**Acceptance:** a feature added to the kernel appears on both in-app surfaces with no
per-host orchestration code; the throwing desktop `planned-edit` stub is gone. (MCP
intentionally continues to expose the single-shot tool/patch surface.)

---

## P7 — Economics & observability: make runs measurable and recoverable — [M5, M11, M13]

`cost-meter.ts`, `replay.ts`, and `recovery.ts` are built, tested, and have **zero live
callers**. Every real run prices 0, can't be replayed, and recovers only via ad-hoc driver
logic. There is no token/cost/budget UI at all.

- [x] **P7.1** Wire the **cost meter** into every live run — **SHIPPED (2026-07-10)**:
      `AiResponse.usage` is now populated by every provider's `complete()` that can read a
      real token count off its own response (Anthropic top-level `usage`, the shared
      OpenAI-compatible `parseOpenAiCompletion` used by github/github-copilot/groq/
      openrouter, NVIDIA's inline parse, Google's `usageMetadata`); Ollama/mock stay
      `undefined` rather than fabricate a number. `graph-executor.ts`'s `TaskRunResult`/
      `GraphRunResult` now carry an optional/always-present `cost`, folded through
      `scheduler.onTaskCompleted`'s existing `cost` arg (previously always called with
      none). `plan-driver.ts`'s `runSelectShots`/`runProposeEdit` price every model
      attempt — including a rejected/retried one, not just the winner — via
      `cost-meter.ts#estimateUsd`. `RecipeRunResult.cost`/`PlannedEditRunResult.cost`
      thread it through honestly (a recipe run's cost is asserted **exactly**
      `{tokens: 0, usd: 0}` — `recipe-executor.test.ts`'s regression guard — since a
      recipe has no `model` tasks; a planner/agent run prices real usage).
- [x] **P7.2** Surface usage in **creator language, not coder language** (lens §2.5.6) —
      **SHIPPED (2026-07-10)**: new `kernel/cost/usage-summary.ts#summarizeUsage` maps a
      run's `{tokens, usd}` to `{instant, label, raw}` — `"Instant · no AI needed"` for a
      $0 run, `"AI edits used this session"` otherwise (raw numbers **never** in `label`;
      `raw` always carries the real numbers for the dev/pro toggle). A new `usage` `AiEvent`
      (raw `{tokens, usd}`, never rendered as a `ConversationView` node) carries the cost
      from `Orchestrator.streamRecipe`/`streamPlannedEdit` to the UI; `AiSidebar` folds it
      via `runOutcome.ts`'s `TurnSignals.cost` and replaces the old recipe-only "Recipe · 0
      tokens" chip with a creator-language chip on **every** run whose cost is known (today:
      recipe + planned-edit), tracking a running session-total. A new `showAiUsageDetails`
      setting (Settings → AI → Routing), **off by default**, appends the raw token/$ figures
      to the chip — the only place they can appear. NOTE flagged back to the requester: the
      plan's example phrasing "AI edits used this month / on your plan" had to become
      **session-scoped** ("AI edits used this session") — there is no real plan/billing/quota
      concept anywhere in this codebase today (confirmed by grep), so a monthly-limit framing
      would itself be a fabricated number.
- [x] **P7.3** Wire **replay** (`createRecordingEffectRuntime` → `createReplayEffectRuntime`)
      as a dev/debug affordance **and** a determinism regression test — **SHIPPED
      (2026-07-10)**: `Orchestrator` takes an opt-in `recordEffects` flag (off by default) +
      `onRecording` callback; when on, `streamRecipe`/`streamPlannedEdit`'s effect runtime is
      wrapped in `createRecordingEffectRuntime`, and the run's `RunRecording` is handed to
      `onRecording` once the run settles. The main deliverable —
      `kernel/replay/replay-determinism.test.ts` — records a real `executePlannedEdit` run
      (host-tool + model effects) and replays the SAME `TaskGraph` through
      `createReplayEffectRuntime(recording)`, a runtime with **no provider/executor
      reference at all**, asserting the replayed status/cost/patch/diff are byte-identical
      to the recorded run's. A companion test proves the `Orchestrator` wiring itself is
      consulted (on when `recordEffects` is set, silent when it isn't). Not built: a replay
      dev panel/inspector — that is P7.5, explicitly deferred.
- [x] **P7.4** Wire **saga recovery** (`recoveryFor`) into the live drivers, replacing the
      ad-hoc handling — **SHIPPED (2026-07-10), partial by design**: `plan-driver.ts`'s
      `runSelectShots`/`runProposeEdit` now catch a THROWN model-effect error (previously
      unhandled — it crashed the whole graph run as an unhandled rejection) and consult
      `recoveryFor({class: 'model_error', attempt, ...})` via the new
      `runModelEffectWithRecovery` helper: it retries with the table's prescribed backoff
      while the table says `retry`, and surfaces an honest task failure (naming the
      recovery reason) once the table's own budget (`MAX_MODEL_RETRIES`) is exhausted and
      it prescribes a tier/recipe fallback — neither of which this driver implements yet
      (a real fallback is a larger capability addition, out of this task's scope).
      `plan-driver.test.ts` proves a live driver actually consults the table (asserted
      backoff values, not a coincidental hardcoded loop). Deliberately left alone (large,
      high-blast-radius rewrites for a table-consultation-only gain, not a behavior fix):
      the sequential agent loop's ad-hoc host-tool-unavailable handling
      (`Orchestrator.runAgentCall`, "Cannot run X — no analysis engine connected... do not
      retry") and the Critic self-repair pass (`Orchestrator.attemptRepair`, already its own
      exactly-one-pass design) — both are deeply embedded in the large, heavily-tested
      sequential agent loop and would not change behavior if routed through `recoveryFor`
      today. `tool_failed`'s `route_around` branch is likewise not wired into
      `graph-executor.ts#runHostToolTask`: there is no "alternative downstream task" concept
      anywhere in the codebase yet, so `hasAlternative` would always be `false` and the table
      would only ever prescribe `fail_subgraph` — identical to today's behavior.
- [ ] **P7.5** Tracer/telemetry: every routing decision, effect, and task lifecycle is
      inspectable (the `reason` fields already exist on router/scheduler decisions — surface
      them in a dev panel and the tracer).

**Acceptance:** every run is internally measured and its decisions are inspectable; failures
degrade via the recovery table instead of dead-ending; any run is replayable with no model —
and the *user* sees plan-friendly usage, never a token meter, unless they opt into dev/pro.

---

## P8 — Perceived-latency & agent-native UX (the interaction moat) — [M3, M4, M8]

The event pipeline already computes everything the mature UI needs — it just isn't
rendered, and the two signature interactions (parallel visibility, Cmd+K) are missing.

- [x] **P8.1** Emit `planning`/reasoning shimmer within one frame of submit (before any
      model resolves) — **SHIPPED (2026-07-10), zero code change beyond a proving test**:
      re-audited `Orchestrator.streamChat`/`streamPlan`/`streamEdit`/`streamRecipe`/
      `streamPlannedEdit` — every one already `yield emit.status(...)` as its **first**
      statement, before any `await`, and `AiSidebar.runTurn` pushes every streamed event
      through `frameBatcher.ts`'s `createFrameBatcher` (flushes once per `requestAnimationFrame`,
      documented "never delayed by more than a frame"). So the header's `.ai-run-spinner`
      (driven by `view.status !== 'idle'`) was already guaranteed to render within one frame
      of submit, with no dependency on the model resolving anything further. Added a
      regression test proving it: `AiSidebar.test.tsx`'s *"shows the run indicator before
      anything else resolves — shimmer within one frame of submit (P8.1)"* uses a mock
      session that emits exactly one `status` event and then hangs forever — the spinner
      still renders, so the indicator provably does not wait on the model.
- [x] **P8.2** **Parallel "what's running" view:** render `view.tasks` (already computed from
      `task_started`/`task_finished`/`effect_progress` — **no component reads it today**) as
      *simultaneous* running cards, so `detect_beats ∥ detect_scenes` is visibly concurrent.
      This is the cheapest high-impact maturity win: the data pipeline is done end-to-end. —
      **SHIPPED (2026-07-10)**: new `apps/web-editor/src/components/ai/TaskRunView.tsx` groups
      `ConversationView.tasks` into a running grid (side-by-side/wrapping cards, so two tasks
      both mid-flight render together, never sequentially) plus a quieter settled row beneath;
      reuses `toolStatusTone`/`.ai-shimmer-text`/`.ai-spinner` for visual consistency with the
      existing tool cards rather than inventing a new status language. `label` on `TaskView` is
      already human text set by the caller (e.g. "Analyze silence · A-roll"), so no separate
      name-humanizing helper was needed. Mounted in `AiSidebar.tsx` as
      `<TaskRunView tasks={view.tasks ?? []} />`, strictly additive (renders nothing when
      `tasks` is empty/absent — true for every run today, since no live driver calls
      `emit.taskStarted` yet; wiring that up is separate, future work). Every existing sidebar
      affordance (mode/apply-mode dropdowns, tool cards, plan checklist, diff accept/reject,
      history, resume/retry) is untouched — the full pre-existing `AiSidebar.test.tsx` suite
      passes unmodified, plus a new explicit regression test and a dedicated
      `TaskRunView.test.tsx` (4 tests: empty state, two-concurrent-running, one-settles-
      independently, failed status). **P8.3–P8.7 remain explicitly deferred** (prefetch,
      Cmd+K, preview-first review, apply-as-you-go, context chips) — out of scope for this pass.
- [ ] **P8.3** Speculative prefetch: while the Planner thinks, pre-dispatch obvious read
      analyses (transcript/silence) through the `EffectRuntime`'s idempotency cache so
      results are warm when the plan lands.
- [x] **P8.4** **`Cmd+K` selection-scoped direct edit** [M4]: (a) feed the timeline
      **selection** into the sidebar run (`AiSessionInput.selection` is plumbed through
      transport + IPC but the sidebar never populates it), (b) pass `hasSelection` to
      `routeCommand` so the `direct_edit` kind becomes reachable (it's dead today), (c) add
      the keybinding + a minimal inline entry that runs a single selection-scoped
      `EditProposer` patch, skipping planning. Three wired-but-dead pieces, one feature. —
      **(a)+(b) SHIPPED (2026-07-11, H1.5c)**: `AiSidebar.tsx` resolves the editor's live
      `state.selectedIds` to a timeline range via a new shared `selectionRange` helper
      (`editor/selectors.ts` — the single source of truth for "selection → range", reused
      by both the request builder and the composer chip below) and threads it as
      `AiSessionInput.selection` on every run (respecting an explicit chip removal for that
      turn — see P12.7 below), and passes `hasSelection` into `routeCommand`, so the
      router's `direct_edit` kind is now reachable end-to-end (`router.test.ts` already
      covered the classification; the new coverage is the sidebar actually producing
      `hasSelection`). **(c) SHIPPED (2026-07-11, H1.5c second half)**: a shared
      `CommandPalette.tsx` supplies the keybinding (`⌘K`/`Ctrl+K`, rebound from
      `edit.split`) and the minimal inline entry — a free-text box that, with an active
      selection, sends the typed prompt as a scoped AI edit through the same
      `AiSidebar`/`runTurn` path the composer uses (no separate `direct_edit` execution
      branch was added; the router-level classification still governs how the request is
      handled, per the note above). Without a selection the palette shows an honest hint
      and a fallback to the full sidebar rather than silently doing nothing. The "@"
      pin-context picker (P8.7, shipped as a narrow slice 2026-07-11 — see below) was a
      separate follow-up UI work item; scoping the palette to a raw preview-player
      timecode instead of a clip (see P13.3) remains open.
- [ ] **P8.5** **Preview-first review** (lens §2.5.1 — the highest-value UX fix in the plan):
      an editor judges an edit by *watching it*, not by reading op JSON. The review card's
      primary action is **play before ↔ play after** in the HTML preview player (scrubbable,
      A-B toggle), with the op description as secondary detail. **Enable the hard-disabled
      Preview button as the default affordance, not an option.** Multi-step runs collapse to
      **one** undoable patch; keyboard accept/reject/next. Per-op before/after is the *fallback*
      textual view, not the headline. Without this, "review" is coder-brained and useless to an
      editor.
- [ ] **P8.6** Apply-as-you-go polish: the existing `auto` apply-mode commits diffs as they
      stream; make streamed/partial diffs render Cursor-style rather than only on terminal
      `diff`.
- [~] **P8.7** **Context attachment / @-mentions** [M4b]: let the user pin specific entities
      as run context — `@clip`, `@asset`, `@range 12–18s`, `@marker`, `@track` — beyond the
      single active selection. The `read`-tool + semantic-index (P4) machinery already
      resolves these entities; the gap is a composer affordance that attaches a *set* of them
      to `AiSessionInput` and a chip UI that shows what's pinned. This is the Cursor/Windsurf
      "@ a file" analog and the multi-entity superset of P8.4's selection scoping.
      **NARROW SLICE SHIPPED (2026-07-11, H1.5c third slice, `plan/PLAN.md`)**: `@clip` and
      `@asset` only. Typing `@query` in the composer opens a dropdown (mirrors the
      slash-command palette) over `pinnableEntities(project)` — every timeline clip +
      every `project.assets` entry; picking one adds an independently-removable chip
      alongside the selection chip (N pins coexist, architecturally free since
      `ContextItem` was already a flat array). Threaded into the model context via a new
      `ContextInput.pinned`/"Pinned context" prompt block (`context-builder.ts`), ranked
      just below `selection` in the token-budget tier order. Browser-only — desktop IPC
      threading deferred to P6. **Still open** (this slice's explicit non-goals, not
      silently dropped): `@range 12–18s`, `@marker`, `@track` entity kinds.

**Acceptance:** common commands feel instant; the app visibly does more than one thing at
once (real `∥` cards); a selection-scoped edit is a one-keystroke path; the user can pin
specific clips/assets/ranges as context; multi-step runs are one undo.

---

## P9 — Workflow memory: the "get cheaper as taught" loop — [M9]

Memory read + accept/reject write are live, but the teach→save→replay loop can't execute a
saved workflow through the live recipe executor yet, and nothing reasons specifically over
accepted-vs-rejected diffs.

- [ ] **P9.1** Close the teach→save→replay loop against the live recipe executor: a saved
      workflow replays through `compileRecipe` with **0 tokens** and actually edits (today it
      saves and routes, but the replay path needs the executor wired as its backend).
- [ ] **P9.2** Parameterized workflows: capture the run's params so "my intro style" replays
      with the taught values.
- [ ] **P9.3** Suggest saving when the user repeats a planner command that could become a
      recipe (the router already recognizes save-as-recipe).
- [ ] **P9.4** Make the accept/reject log *actionable*: feed accepted-vs-rejected edit
      patterns into the proposer context as preference signals, not just a generic memory
      summary — the model learns this project's taste.

**Acceptance:** teaching a workflow moves future runs from the LLM path to the 0-token
recipe path; the system measurably gets cheaper and more on-taste as it's used.

---

## P10 — Product hardening (top-notch bar)

- [ ] **P10.1** Full-kernel integration/e2e suite: drive router→compile→schedule→proposers→
      effects→verify on real runs across recipe, planner, converged-agent, direct-edit, and
      chat — plus **Playwright sidebar e2e** per recipe and per plan shape (the P1.4/P2.3
      follow-ups).
- [ ] **P10.2** Security review (security-reviewer): the planner/converged-agent executors'
      IPC and effect surface, desktop `planned-edit` parity (P6.2), sandbox, cancel/timeout,
      new sidecar calls.
- [ ] **P10.3** Performance gates (performance-monitor): interaction/scheduler/decode budgets
      for the parallel path; non-flaky perf-regression tests; the P4.3 token-delta gate.
- [ ] **P10.4** Offline/local-model path validated end to end (recipes + Ollama planner).
- [ ] **P10.5** Docs + ADRs: recipe vs. planner vs. agent behavior, cost/budget, offline,
      tier routing, desktop `planned-edit` parity, and the agent-mode cutover (P11). Record
      the "MCP stays single-shot" decision as an ADR so the divergence is documented, not
      accidental.

---

## P11 — Agent-mode maturity & verification parity (the maturity keystone) — [M2, M12, M14]

This is what makes "Agent" mode feel like Cursor/Windsurf rather than a sequential tool
loop, and what makes *every* path trustworthy before it commits. Two intertwined tracks.

### Track A — Converge agent mode onto the parallel kernel [M2, M14]
Today "Agent" mode runs the **sequential** Conductor loop (model schedules itself, one tool
at a time); the parallel DAG is a browser-only, shape-gated *probe* that falls back to that
loop. Mature agent mode should *propose a plan → schedule it in parallel → verify → patch*,
with the sequential loop as the explicit fallback for genuinely unplannable work.

- [x] **P11.1** Widen the planner path from "recognized shapes" toward general novel work:
      grow `isRecognizedPlan`'s effect coverage and the `propose_edit` tool scope
      (incl. *action*/*analysis*-kind tools via their own upstream `host_tool` tasks) so more
      requests compile to a DAG instead of falling back.
      **Shipped:** `montage-leaves.ts` now exports `PLANNER_LEAVES` — the UNION of the one
      hand-authored montage shape (`MONTAGE_LEAVES`) and every already-shipped,
      already-tested `RECIPE_LEAVES` pure primitive (ripple-delete/caption/pacing/hook/
      punch-in/filler-cleanup synthesis). `orchestrator.ts#isRecognizedPlan`'s `analysis`
      case and `plan-driver.ts#executePlannedEdit`'s default `leaves` both key off
      `PLANNER_LEAVES` now (previously `MONTAGE_LEAVES` only). This is a conservative
      widening — it recognizes MORE of what the driver can *actually run* (the same
      registry it now defaults to), never a shape the driver can't execute. Proven live in
      `planned-edit-stream.test.ts`'s new "a THIRD, RECIPE_LEAVES-composed plan shape"
      case (`find_hook`/`synth_hook_restructure`, no montage vocabulary at all).
      `host_tool`/`model` task recognition (`analysis`-kind tools, `select_shots`/
      `propose_edit`) was already this general as of P3.2 — unchanged here.
- [x] **P11.2** Make the planner path the **primary** agent route (not a silent probe) once
      P4 (semantic slices) + P3.4 (tiers) land: Agent-mode requests attempt the DAG first and
      only drop to the sequential loop with an honest, inspectable reason.
      **Shipped (kernel/orchestrator half):** `AiSidebar`'s `tryPlannedEditFirst` gate
      (`decision.kind === 'plan' && mode === 'agent' && !getBridge()`) already attempts the
      DAG FIRST for exactly the intended scope (novel/composite Agent-mode requests; recipe/
      chat/direct_edit decisions and desktop stay explicitly out — documented in place, not a
      silent gap, since desktop `planned-edit` IPC parity is a separate P6.2/P10 item). P11.1's
      widening is what makes this meaningfully "primary" in practice — more requests now
      succeed via the DAG instead of falling back. And the SILENT discard-and-replay is now an
      honest, inspectable fallback: `Orchestrator.streamPlannedEdit`'s five "unsupported" exit
      points emit a `notification` carrying a machine-inspectable
      `reason: PlannerFallbackReason` (`intent_unparseable` | `plan_unparseable` |
      `plan_uncompilable` | `unrecognized_task_shape` | `execution_unsupported`) plus a
      specific human `detail` — not just the one opaque `PLANNED_EDIT_UNSUPPORTED_NOTICE`
      string. `events.ts`'s `NotificationEvent`/`NoticeNode` carry the new optional
      `reason`/`detail` fields (additive, mirrors `ErrorEvent.detail`); `text` is unchanged so
      `AiSidebar`'s existing string-matching probe keeps working. Building the UI surface for
      the reason is an explicit follow-up (not built here — this task was kernel/orchestrator
      only). Full cross-surface (desktop) parity remains tracked separately.
- [x] **P11.3** **Plan-approval gating** for the autonomous mode: for high-blast-radius plans,
      surface the compiled DAG for one-click approve/edit before execution (the "Plan first"
      toggle already exists — give it a real gate, not just a draft). Manual mode reviews
      diffs; autonomous mode reviews the *plan*.
      **Shipped (2026-07-10/11):** the "Plan first" toggle now really gates execution. When
      the drafted up-front plan has MORE than `PLAN_APPROVAL_STEP_THRESHOLD` (3) steps, the run
      pauses before its first turn — before any op touches the timeline — for a new
      `PlanApprovalCard` (`apps/web-editor/src/components/ai/PlanApprovalCard.tsx`) that shows
      the numbered plan with inline Approve / Edit request / Cancel, no modal. A plan with 3 or
      fewer steps is never gated. New kernel machinery: a `requirePlanApproval` flag on
      `AgentOptions` (`packages/ai-sdk/src/agent.ts`), a new `awaiting_approval` `RunPhase`/
      effect/fold in `kernel/conductor.ts`, an `awaitApproval` handler in `orchestrator.ts`'s
      `agentRun`, and a new `run-controls.ts` module (`PlanApprovalGate`/
      `createPlanApprovalGate`) that carries the live, non-serialisable approve/cancel resolver
      OUTSIDE the pure `Command`/`AgentOptions` boundary (by design — see that file's module
      doc). Wired into `AiSidebar.tsx`. **Browser-only** for now — Electron IPC can't carry the
      live resolver — an explicit, documented gap, not silent, same precedent as the existing
      planner-first/variations features. Tests: `kernel/conductor.test.ts`,
      `kernel/driver.test.ts`, `orchestrator-stream.test.ts` (threshold on/off, approved/
      cancelled fold, no-resolver-wired honest degrade); `PlanApprovalCard.test.tsx` and the
      `AiSidebar — plan-approval gate (P11.3)` describe block in `AiSidebar.test.tsx` exercise
      the real approve/edit/cancel flow end to end against a fake session. Directly satisfies
      **P12.4** (same card).
- [x] **P11.4** **Mid-run steering** [M14b]: let the user inject guidance into a *running*
      agent without a full Stop+restart — a queued instruction the driver folds into the next
      turn / re-plan at the next scheduler boundary (still budget/spin-guarded, still honest
      about what it did with the interjection). This is the Windsurf-Cascade "talk to it while
      it works" affordance; today the only mid-run control is Stop + checkpoint-resume.
      **Shipped (2026-07-10/11):** while an Agent run is in progress, a new `SteeringInput`
      component (`apps/web-editor/src/components/ai/SteeringInput.tsx`) next to the running-
      task view lets the user type guidance and send it without stopping the run. Honest scope:
      this is **queued** and applied at the run's next per-turn boundary — the same boundary
      that already checks Stop/abort between turns — not an instant mid-step redirect. New
      kernel machinery: `SteeringQueue`/`createSteeringQueue` in `run-controls.ts`, popped at
      the top of `orchestrator.ts`'s `runTurn` handler and folded into that turn's model context
      (`agentMessages`'s new `steeringMessage` param), with an honest "Steering applied: ..."
      notification once it lands. **Browser-only**, same reason as P11.3. Tests:
      `kernel/conductor.test.ts`, `kernel/driver.test.ts`, `orchestrator-stream.test.ts`
      (steering fold at turn boundary, steering silent when unused); `SteeringInput.test.tsx`
      and the `AiSidebar — mid-run steering (P11.4)` describe block in `AiSidebar.test.tsx`
      exercise the real queue/apply flow end to end against a fake session. Directly satisfies
      **P12.5** (same input). Full-suite evidence for both P11.3/P11.4: `packages/ai-sdk` 1101
      tests passing / typecheck / lint clean; `apps/web-editor` 929 tests passing / typecheck /
      lint clean.

### Track B — Technical verification on every path; taste stays human [M12] (lens §2.5.2)
The verify battery's job is **technical safety, not aesthetic judgment** — no battery can
tell if a cut *feels* right, and pretending to would be dishonest and annoying to an editor.
So this track does two things: (a) run the real *technical* battery on every path, and (b)
hand the *taste* call straight to the human via fast preview-first review (P8.5), fast.
Today the deterministic 8-check `critique()` runs **only on the agent path**; recipe/planner
`verify` asserts *only* patch validity; the `Critic` *proposer* (`runCritic`) is **dark**.

- [x] **P11.5** Wire the `Critic` proposer / `runCritic` as a scheduled **`verify` kernel
      task** so recipe *and* planner DAGs run the real **technical** battery (request_match,
      duration_target, caption_alignment, safe_area, missing_assets, export_settings, and the
      render-gated pixel checks) — not just patch validity. Keep it deterministic-first; LLM
      judgment only where the seam already allows. **Do not add aesthetic/"is this good" scoring
      — that is the editor's call, made by watching (P8.5).**
      **Shipped:** `recipe-leaves.ts`'s shared `verify` leaf (the ONE registration point both
      `RECIPE_LEAVES` and `PLANNER_LEAVES` reuse — `montage-leaves.test.ts` asserts they are
      the literal same function) now: (1) still fails immediately, honestly, on a
      structurally-invalid patch (unchanged, pre-P11.5 behavior); (2) once structurally valid,
      calls `critic.ts#critique()` — the EXACT function the sequential agent path already
      calls (`orchestrator.ts`'s `critiqueOptions`/`critique`) — against the patch applied to
      the working project, and folds a `fail` into `verdict.ok = false`. The full
      `CritiqueReport` is exposed on the new `RecipeTaskOutput.critique` field for
      inspection/testing. `durationTargetSeconds`/`targetPlatform` thread through from the
      `verify` step's own `args` when a caller sets them (both honestly `skipped` otherwise —
      never fabricated). Render-gated checks (`audio_clipping`/`black_frames`) stay `skipped`
      on this path (no preview render inside a pure leaf) — same honest degrade every other
      path already has with no render yet. **Deliberately calls `critique()` directly rather
      than routing through the `runCritic`/Critic-proposer wrapper** (`kernel/proposers/
      critic.ts`) — `runCritic` is a pure pass-through (`critique(input.project, input.options)`
      wrapped into a differently-shaped `Finding[]`) with no behavioral difference and no
      currently-wired optional-judgment caller; calling `critique()` directly keeps the
      recipe/planner `RecipeTaskOutput.critique` the SAME `CritiqueReport` shape the sequential
      path's `AgentRun.critique` already returns, which is exactly what P11.6's parity test
      compares — matching "however the sequential path already invokes it" (`critique()`) more
      faithfully than a detour through the still-unused proposer wrapper would.
- [x] **P11.6** Verification parity test: a recipe run and a planner run surface the same
      *technical* verdicts the agent path does; a failing check degrades honestly (route-around
      via P7.4 recovery, or an honest "couldn't satisfy X" notice), never a fabricated ✅. The
      run then lands in preview-first review so the editor makes the taste call.
      **Shipped:** `kernel/verify-parity.test.ts` runs the same silent-range trim through the
      recipe DAG (`executeRecipe` + `compileRecipe('remove_silence')`), the planner DAG
      (`executePlannedEdit` on a hand-compiled `analyze_silence → propose_edit → assemble_patch
      → verify` graph — P11.1's widened, non-montage shape), and the sequential agent loop
      (`Orchestrator.agent()`), and asserts all three land on the IDENTICAL 8-check-id battery
      (`request_match`/`duration_target`/`caption_alignment`/`safe_area`/`audio_clipping`/
      `black_frames`/`missing_assets`/`export_settings`) — same rigor, not necessarily
      identical patches. `montage-leaves.test.ts` additionally proves `RECIPE_LEAVES.verify`
      and `PLANNER_LEAVES.verify` are the literal same function object (not two copies that
      could drift).

**Acceptance:** "make a 45s montage to the beat" runs the proposer + parallel DAG as the
*primary* agent path (not a probe), shows simultaneous running cards, lands cuts on
**returned** beats, is verified by the real battery before it commits, and — for a big
edit — pauses for plan approval; the model is called a bounded number of times, and every
in-app path (recipe, planner, agent, on both browser and desktop) verifies with the *same*
battery.

---

## Definition of Done (the whole product, at the mature bar)

1. Typing a common editing verb ("remove silences", "add captions", "punch in") edits the
   timeline **deterministically, with 0 model calls**, verified by the real battery, end to
   end, on **both in-app surfaces** (browser + desktop). (MCP exposes the same validated
   tool/patch surface via its single-shot path by decision, not the recipe/planner kernel.)
2. A novel request ("45s montage to the beat") runs the **proposer + parallel DAG as the
   primary agent path**, shows **visibly concurrent** progress, calls the model a bounded
   number of times on **tier-appropriate** models, reasons over **semantic slices** (not
   clip JSON), and lands cuts on **returned** beats — with no fabricated success.
3. Every run reports its **cost** against a **budget**; failures **degrade** via the
   recovery table (tier/recipe fallback, rebase, honest pause); any run is **replayable**
   with no model.
4. Selection-scoped **`Cmd+K`** edits are a one-keystroke direct-edit path; the user can
   **pin context** (@clip/@asset/@range); multi-step runs collapse to **one** undoable patch;
   parallel tasks are visible as simultaneous cards.
5. Autonomous mode gates **high-blast-radius plans** for approval and accepts **mid-run
   steering**; manual mode reviews diffs. (Long-horizon multi-segment runs are tracked
   separately in Appendix A — exploratory, not part of the mature bar.)
6. As much as possible works **offline** (recipes + local model); nothing silently no-ops
   for a missing engine — it runs or explains, with a capability chip shown *before* asking.
7. The **full in-app kernel** (not just `streamAgent`) has integration + e2e coverage; the
   divergent throwing-`planned-edit` and sequential-only paths are retired (MCP's single-shot
   surface stays by decision); `pnpm verify` green; docs and CHANGELOG match reality.
8. The **AI surface** (P12) matches the orchestration maturity: a live parallel-run HUD, a
   plan-usage (not token) readout, a plan-approval step list, a **preview-first** review queue,
   context chips, and Cmd+K — accessible, honest (no fake success), no coder jargon, and at
   parity on browser and desktop.
9. The product is unmistakably an **editor's** agent (P13, lens §2.5): review is by watching;
   the editor can compare variations, speak creative language, refine a moment by pointing at
   it, and export to a platform spec; mechanical work is instant/free, creative work is a
   reviewable proposal — taste stays the human's call.

---

## Sequencing & effort (suggested)

| Wave | Phases | Why this order | Rough size |
|---|---|---|---|
| 1 | **P3.4, P4** + **P12.1** | Cheap+strong tiers and real semantic slices make the converged path affordable and smart (prereqs for P11); restructure the sidebar IA so later UI has a home | M |
| 2 | **P8.2, P8.4** + **P12.2/P12.3** | Parallel view + Cmd+K/selection are wired-but-dead pieces; ship them with the composer redesign + live-run HUD — highest impact per unit effort | M |
| 3 | **P5, P7** + **P12.6** + **P4.4, P13.2** | Engine reachability/offline + measurable runs, surfaced through the **preview-first** review queue; footage search + creative vocabulary make the editor fluent | M |
| 4 | **P11** + **P12.4/P12.5** + **P13.1/P13.3** | The maturity keystone: converge agent mode onto the DAG + technical verify (taste stays human), with the plan step-list, mid-run steering, **variations**, and the point-react-refine loop | L |
| 5 | **P6, P9** + **P12.7/P12.8/P12.9** + **P13.4/P13.5** | In-app parity (desktop) + get-cheaper loop, timeline integration, discovery, platform-aware export, and the automate-mechanical/assist-creative framing | M |
| 6 | **P10** + **P12.10** | Hardening to the top-notch bar (e2e, security, perf, docs) + visual/motion/a11y pass | M |

> **Editor-first (P13) is woven in, not bolted on:** each P13 item rides the wave whose engine
> it depends on (footage search needs P4; variations need P11's proposer path). Ship the
> mechanical recipes (P2, already done) as the promoted "instant &amp; free" tier from day one.
> **Content understanding (Appendix B) and long-horizon runs (Appendix A) are deferred** —
> valuable, but past the mature bar and gated on engines that don't exist yet.

> **P12 (UX track) is not a separate wave** — each of its sub-items ships *with* the
> orchestration phase it surfaces (noted per wave above), so the engine and its surface land
> together and no capability is built without a way to see it. P12.1 (IA restructure) is the
> one exception: do it first so the rest has somewhere to live.

**Start here:** **P3.4** (tier dispatch — the seam is built, just uncalled), **P8.2** (render
`view.tasks` — the data pipeline is already complete), and **P12.1** (the sidebar IA
restructure). All three are shippable and visibly move the product toward the mature bar.
Then P4, then the P11 keystone with its approval/steering UI.

---

## P12 — AI surface & sidebar redesign (the UX track)

> **Why this exists:** the orchestration phases above each imply a piece of UI (a cost
> meter, a parallel-run view, an approval card, context chips). P12 is where those pieces
> become **one coherent, mature surface** rather than bolt-ons — and where we're explicitly
> allowed to **restructure the core AI sidebar** (`AiSidebar.tsx`, `Composer.tsx`,
> `EventNode.tsx`, `useConversationView.ts`) to get there. Every item cross-references the
> orchestration phase it surfaces.

### P12.0 — Design principles & constraints (do not violate)
- **Honesty in the UI too** — no fake progress, no green ✅ for a run that did nothing; a
  gated/unavailable capability *looks* gated. (Mirrors guardrail §1.6.)
- **No modal `prompt`/`confirm`/`alert`** — Electron has none in the renderer; every input
  (steering, rename, approve/edit) is an **inline** control.
- **Never remove a working affordance** — the audit-confirmed live UX (mode dropdown,
  manual/auto apply, tool cards, reasoning shimmer, plan checklist, diff accept/reject +
  global undo, history, resume/retry) is preserved or improved, never regressed.
- **Accessibility + motion** — keyboard-first, ARIA roles on cards, `prefers-reduced-motion`
  honored for shimmer/transitions, theme-aware (light/dark).
- **Desktop parity** — every new surface renders identically in the Electron renderer.

### P12.1 — Sidebar information-architecture restructure (the core change)
Today the sidebar is a single scroll of event nodes + a docked composer. Restructure into
clear zones so a mature run has somewhere to live:
- [ ] **P12.1a** A persistent **run-status header / agent HUD** (collapses when idle): current
      phase, elapsed, model/tier, cost ticker, Stop — always visible during a run.
- [ ] **P12.1b** The **transcript/thread** zone (existing nodes) scrolls independently beneath it.
- [ ] **P12.1c** A **review queue** affordance for pending diffs that doesn't get lost in scroll
      (backs P8.5/P12.6).
- [ ] **P12.1d** The **composer** stays docked but is redesigned in P12.2.
      *Refactor `AiSidebar.tsx`'s single render list into zone components fed by the same
      `useConversationView` reducer — no event-schema change.*

### P12.2 — Composer redesign
- [ ] Mode as a **segmented control** (Agent / Chat / Edit) instead of a buried dropdown;
      autonomy (manual/auto apply) as a clear adjacent toggle with plain-language labels.
- [ ] **Context chips** row: active selection + pinned `@clip/@asset/@range/@marker` (backs
      **P8.7**), each removable; an "@" affordance to add them.
- [ ] Inline **engine-availability + plan-usage** indicators (backs **P5.3**, **P7.2**) — the
      user sees *what can run here* and *whether it's free/instant or uses their AI plan* before
      submit. **No token/tier jargon** (lens §2.5.6); model/tier is auto and invisible (P3.4).
- [x] **`Cmd+K`** entry for selection-scoped direct edit (backs **P8.4**). — **SHIPPED
      (2026-07-11, H1.5c)**: a shared `CommandPalette.tsx` serves two entry points with the
      same UI and the same request path — the global `⌘K`/`Ctrl+K` shortcut (rebound: `edit.split`
      no longer claims `mod+k`, now just `['s']`; a new `ai.commandPalette` shortcut, group
      `'AI'`, owns `mod+k` in `editor/shortcuts.ts`) and a clip's right-click "Ask AI about this
      clip" item (`ClipContextMenu.tsx`). With an active selection, the palette's free-text box
      sends the prompt as a scoped AI edit carrying the existing `selectionRange` through the
      same `AiSidebar`/`runTurn` path the composer already uses — no parallel request path
      (added `AiSidebarHandle.runQuickEdit` so `Editor.tsx` can fire into it). Without a
      selection, the palette shows an honest hint ("Select a clip to scope your edit, or open
      the AI sidebar for a general request") plus a fallback that opens/focuses the sidebar —
      it never silently no-ops. **Deferred**: preview-player point-clicking (scoping to a raw
      timecode rather than a clip) was not attempted — only the clip-based trigger exists; see
      **P13.3** below.

### P12.3 — Live-run HUD: "what's running" (backs P8.2, P7.1/P7.2)
- [ ] Render `view.tasks` (computed every run today, **never displayed**) as **simultaneous**
      task cards in **plain creative language** ("finding the beats", "detecting scene cuts"),
      not tool names — with per-task status/elapsed/progress, `detect_beats ∥ detect_scenes`
      visibly concurrent.
- [ ] A friendly **progress + plan-usage** readout (not a token ticker; lens §2.5.6); honest
      "reached your plan's limit" state.
- [ ] First `planning` shimmer within one frame of submit (backs **P8.1**).

### P12.4 — Plan-approval card (backs P11.3) — done
- [x] For high-blast-radius autonomous plans, a first-class card renders the plan as a
      friendly **numbered step list** in plain language (never a "DAG" — the graph is internal),
      with inline **Approve / Edit / Reject** — no modal. Editing a step is an inline control,
      not a prompt. Manual mode reviews diffs; autonomous mode reviews the plan.
      **Shipped:** see **P11.3** for the full write-up — `PlanApprovalCard.tsx` is this card,
      gated on plans with more than 3 steps, wired into `AiSidebar.tsx`, browser-only for now
      (documented gap, not silent).

### P12.5 — Mid-run steering input (backs P11.4) — done
- [x] An inline "steer" field usable **while a run is active**: the typed guidance shows a
      **queued** state and is folded in at the next scheduler boundary, with an honest note in
      the transcript about what the interjection changed. No stop/restart required.
      **Shipped:** see **P11.4** for the full write-up — `SteeringInput.tsx` is this field,
      queued via `SteeringQueue`/`createSteeringQueue` and folded in at the next turn boundary,
      browser-only for now (documented gap, not silent).

### P12.6 — Preview-first review queue (backs P8.5/P8.6; lens §2.5.1)
- [ ] The review card's **headline is a before ↔ after player** (scrubbable A-B in the HTML
      preview), because an editor judges by watching, not by reading ops. **Enable the
      hard-disabled Preview as the default**, not an option.
- [ ] Group a multi-step run into **one reviewable unit that undoes as one patch**; keyboard
      **accept/reject/next**, batch **accept-all** (exists — keep).
- [ ] Per-op textual before/after is the **secondary/fallback** detail, not the headline.
- [ ] Stream partial results as they arrive, not only on the terminal `diff`.

### P12.7 — Timeline ↔ sidebar integration
- [ ] **Reveal for all entity kinds** — today `onReveal` only selects clips; make track/file/
      asset/range chips reveal + select on the timeline.
- [ ] **Highlight agent edits on the timeline** as diffs land (which clips changed), so review
      is spatial, not just textual.
- [x] Close the **selection ↔ context** loop: selecting on the timeline populates the composer
      context chips (backs **P8.4** selection feeding). — **SHIPPED (2026-07-11, H1.5c)**:
      `composerActions.ts#buildContextItems` now accepts an optional `ComposerSelection`
      (range + clip count) and prepends a removable `"Selected: N clips, S–Es"` chip;
      `AiSidebar.tsx` derives it from `editor.state.selectedIds`/`timeline` via the same
      `selectionRange` helper the request builder uses, so the chip and the request always
      agree. Removing the chip (`onRemoveContext('selection')`) drops it from that turn's
      request too — the removal is honoured, not silently re-added. Also fixed a real gap
      found while wiring this: `Composer.tsx` declared/threaded `contextItems` but never
      rendered them (dead prop; `.ai-context`/`.ai-context-chip` CSS already existed for
      it) — it now renders the chip row with the existing style. **Reveal for all entity
      kinds** and **highlight agent edits on the timeline** remain open.

### P12.8 — Chat UX polish
- [ ] Reference/citation chips for read-tool results the answer used; copy + regenerate;
      robust markdown/JSON/code rendering in `EventNode`.

### P12.9 — Empty state & capability discovery
- [ ] Engine-availability-aware starter prompts (don't suggest beat-sync when the engine is
      unreachable — backs **P5.3**); surface saved recipes/workflows as one-tap actions (backs
      **P9**); a lightweight "what can I do here" affordance.

### P12.10 — Visual system, motion & a11y pass
- [ ] Unify status colors/icons across tool/task/diff/plan cards; `prefers-reduced-motion`;
      full keyboard nav + ARIA; light/dark parity; desktop-renderer parity check.

**Acceptance:** the AI sidebar reads as a mature agent surface — the user sees *what can run
here and whether it uses their plan*, watches parallel work happen live in plain language,
approves big plans as a step list, steers mid-run, reviews edits by **watching before↔after**,
pins footage as context, and triggers Cmd+K edits — with no fabricated success, no coder
jargon, full keyboard/a11y support, and identical behavior on browser and desktop. Every
existing working affordance is preserved or improved.

---

## P13 — Editor-first creative capabilities (what coder tools don't have) — [lens §2.5]

The §2 phases build the engine; P13 builds the capabilities that make it a *video editor's*
agent rather than a code agent wearing a timeline. These come straight from the lens and
have no real Cursor/Windsurf analog.

- [~] **P13.1** **Variations / A-B compare** (lens §2.5.4): a first-class "give me N options"
      path — the same request runs the proposer 2–3× (varied prompt/seed) into **parallel
      candidate patches**, presented as A/B/C the editor previews and picks *one* to apply
      (the rest discarded, nothing committed). Reuses the existing patch-branching + preview
      machinery; the new piece is a multi-candidate review surface. This is how creatives
      actually work — comparatively — and it's absent today. — **Edit-mode slice SHIPPED
      (2026-07-11, H1.5)**: scoped to `edit` mode only (Cmd+K / the sidebar's "Edit" mode) —
      the one genuinely model-driven single-proposal path in this codebase; recipe/
      planned-edit/agent runs are deterministic or already-converged, so "variations" of
      them would be the identical result run twice (never fabricated, never offered).
      `Orchestrator.editVariations` reuses the exact same `assemble()`/`assembleEdit()`
      path a single `edit()` call uses, per real candidate (`EDIT_VARIATION_COUNT = 2`,
      each its own `provider.complete()` call sampled at a different `temperature` — the
      provider abstraction's existing knob, no new sampling machinery). Non-streaming under
      the hood (`streamEdit(..., { variations: true })` delegates to a private
      `streamEditVariations`): a `stream()` transport has no channel for real token `usage`
      on its terminal chunk, and honest combined cost across every candidate is the whole
      point, so every candidate call goes through `complete()`. `DiffEvent`/`DiffNode` gained
      an optional `variants` (all candidates; `edit` stays the first/primary one, so every
      pre-existing single-proposal consumer is unaffected). `EventNode.tsx`'s `DiffCard`
      renders a Take A/B tab row only when `variants.length > 1`, re-pointing ONE
      `toReviewCard`/`AiReviewPlayer` at whichever tab is selected (never N simultaneous
      player instances); Accept applies the SELECTED candidate and the card states the
      other was discarded — never left pending. Opt-in via a new "Show 2 alternatives"
      toggle, **off by default** (edit mode + browser only — hidden entirely with an
      Electron bridge present, since desktop doesn't thread `variations` over its IPC
      contract yet); the toggle's own hint states the cost implication before the user
      opts in. A `usage` event now also fires for a variations run (streamEdit's
      single-proposal path still doesn't emit one — unchanged, pre-existing behavior),
      carrying the REAL summed cost of every candidate call, picked up by the existing
      per-turn cost chip with no new UI plumbing. **Deferred** (documented, not silently
      dropped): desktop IPC threading (P6 cross-surface parity is the natural home);
      variations for recipe/planned-edit/agent modes (out of scope — see rationale above);
      concurrent/parallel candidate calls (this slice runs candidates sequentially — real
      cost, real distinct calls, simpler code; P8's "visibly concurrent" work is a separate
      concern from this feature's core value).
- [x] **P13.2** **Creative-intent vocabulary** (lens §2.5.3): make the router/planner fluent in
      editor language that maps to existing ops — "punchier", "tighten", "let it breathe",
      "cut to the reaction", "hold on her face", "match the music", "build energy". A curated
      intent→operation mapping (extends the recipe router) so common creative phrasing is
      recognized deterministically where possible, planned where not — and *never* answered
      with "I don't understand that operation." — **First slice SHIPPED (2026-07-11,
      H1.5c)**: `kernel/router.ts` adds a curated `CREATIVE_PHRASES` list, checked before the
      generic topic+action loop so phrasing that shares no vocabulary with an existing
      recipe's signature ("tighten this up" has no `improve_pacing` topic word) is still
      recognised with zero model calls. Wired: **"punchier"/"punchy"/"tighten this
      (up)"/"tighten it up"/"snappier"/"build (the) energy" → `improve_pacing`** (all
      describe the same thing the recipe already does — faster cuts, less drag — and reuse
      its own aggressiveness-keyword extraction).
      **Closed out for H1 (2026-07-11)**: re-investigated the three remaining phrases with zero
      new model dependency in scope (router stays a deterministic matcher) — one was
      reclassified as already-correct, two are confirmed permanently out of reach without new
      capability this codebase doesn't have, so no new phrase was mapped and none was forced
      onto a recipe that can't honestly satisfy it:
      - **"match the music"** — reclassified, not left unmapped: it already correctly falls
        through to `kind: 'plan'` (no shared `RECIPE_SIGNATURES` vocabulary, no selection
        reference), and `plan` genuinely *can* satisfy it — the Planner reaches the existing
        beat-sync montage leaves (`montage-leaves.ts`: `detect_beats`/`detect_scenes` → beat
        grid → shot placement, P3.1/P11.1). It was never "nothing to route to"; it needs one
        model call to select shots, so `plan` (not a zero-model `RECIPE_SIGNATURES` entry) is
        the honest, correct, and only routing. Docs previously implied a gap here — corrected.
      - **"let it breathe"/"add some space"** — re-verified by reading `synthPacingOps`
        directly (the leaf `improve_pacing` runs): it only ever emits `ripple_delete` ops and
        doesn't even read the `aggressiveness` param it's handed (a pre-existing dead
        parameter, noted for a future cleanup, out of scope here). No recipe/leaf in this
        codebase can *insert* pacing room (hold, freeze, slow-down) — this needs a genuinely
        new recipe (new leaf + synthesis logic deciding where/how much to loosen), not a param
        reversal. Stays permanently unmapped until that recipe is built (separate, tracked
        engineering work, not this slice).
      - **"cut to the reaction"/"hold on her face"** — confirmed needs shot-level content
        understanding (which shot shows a face/reaction) this codebase has no vision/
        classification layer for. Horizon 2 (`FRAMEPILOT-AI-PRODUCT-PLAN.md` H2.1). Stays
        permanently unmapped until that layer exists.
      No behavior change beyond the routing comments/tests above (`match the music` already
      routed to `plan` before this pass — only its documentation was wrong). P13.2 is closed
      as far as Horizon 1 goes; the two still-unmapped phrases are tracked as follow-on work
      (a new "loosen pacing" recipe, and Horizon 2 shot-content understanding), not silently
      dropped.
- [~] **P13.3** **The point-react-refine loop** (lens §2.5.3): elevate "click a moment on the
      timeline/player → say what's wrong → AI adjusts *that moment*" to a first-class flow (not
      just Cmd+K on a selection). Threads the clicked time/clip as scoped context (P8.7) and
      keeps the conversation anchored to that moment across refinements. This is the editor's
      primary loop and should feel as fast as scrubbing. — **Clip-based trigger SHIPPED
      (2026-07-11, H1.5c)**: right-clicking a clip → "Ask AI about this clip" selects it and
      opens the shared `CommandPalette` pre-scoped to that selection (see **P12.2**'s `Cmd+K`
      entry above — same component, same request path). Follow-up refinement isn't a new
      mechanism: it reuses the AI sidebar's existing `active conversation ?? create new` logic
      in `runTurn`, so after a quick edit lands the user keeps refining in the now-visible
      sidebar composer against the same conversation. **Deferred**: clicking a raw point in the
      timeline/preview player (rather than a clip) to scope to a timecode is not built — that
      affordance remains open future work under this item.
- [ ] **P13.4** **Export / delivery intelligence** (lens §2.5.7): make `export_reels` and the
      Export flow **platform-aware** — 9:16 / 1:1 / 16:9 targets, loudness normalization,
      burned-in vs. sidecar captions, per-platform duration/spec hints — surfaced as
      recipe-level actions ("export for Reels", "export for YouTube") rather than a raw render
      dialog. Render stays MoviePy-only behind the wall; this is the *intelligence* on top.
- [ ] **P13.5** **Automate-mechanical / assist-creative framing** (lens division of labor):
      ship the mechanical recipes (remove silence, captions, beat-sync, audio-normalize,
      punch-in) as the aggressively-promoted "does the boring stuff instantly, free" tier, and
      position the planner/agent as the "creative co-editor you review." Surface this split in
      discovery (P12.9) so users reach for the free instant tools first.

**Acceptance:** an editor can ask for **two openings** and pick by watching; speaks in
**creative language** and gets edits, not "unknown operation"; **clicks a moment and refines
it** conversationally; **exports to a platform spec** in one step; and the mechanical grunt
work is instant and free while the creative work is a reviewable proposal — the product
*feels* built for editing, not coding.

---

## Appendix A — Long-horizon autonomous runs (exploratory, deferred)

> **Separated by decision (2026-07-10):** this is *not* part of the mature-bar Definition of
> Done. It is a forward-looking capability to design carefully after the P0–P12 bar is met,
> because it changes the run-safety and supervision model. Kept here so it isn't lost.

Today one submit = one bounded run (≤8 steps, op caps, spin guard). A long-horizon mode
would let an autonomous run **checkpoint and continue toward a stated goal across multiple
bounded segments** — e.g. "make this a polished 45s reel" proceeding through
analysis → cut → caption → pacing → export as one supervised arc rather than requiring
re-prompts between each.

- [ ] **A.1** Goal state + progress model: a persisted objective the run advances across
      segments, with an explicit "done / stuck / needs-input" verdict per segment.
- [ ] **A.2** Segment boundaries as checkpoints: each segment is a bounded run (existing caps
      apply) that hands off a checkpoint; the user can inspect/pause/redirect between segments.
- [ ] **A.3** Escalating supervision: cheap segments auto-continue; high-blast-radius or
      low-confidence segments pause for approval (reuses **P11.3** gating + **P12.4** card).
- [ ] **A.4** Hard safety envelope: total-run budget/step ceilings, a global spin/no-progress
      guard across segments, and an always-available Stop that leaves a clean checkpoint.
- [ ] **A.5** UX: a goal/progress surface in the HUD (extends **P12.3**) showing segments done,
      current segment, and remaining budget — honest about what's autonomous vs. gated.

**Acceptance (when/if pursued):** "make this a polished 45s reel" runs as one supervised,
budgeted, interruptible arc across segments — never a runaway, never fabricated, always
resumable — with the user able to inspect and redirect at every segment boundary.

---

## Appendix B — Content understanding / vision (the frontier differentiator, deferred)

> **The honest frontier (lens §2.5.5):** the most valuable thing an editor's AI could do is
> *understand what's in the footage* — faces, emotion, action, composition, on-screen text —
> so it can make **story** decisions ("cut to her reaction", "use the shot where he smiles",
> "find the B-roll of the ocean"). This is where a video agent genuinely surpasses a code
> agent, and it's the biggest moat. It is deferred, not ignored: build order says the engine
> ships before the AI that calls it, and this engine (vision models) doesn't exist yet.

Today `detect_faces` / `generate_mask` are **registered-but-dark** (`available:false`,
"engine TBD"), there is **no transcription engine** (transcript is data-only), and there is
no frame-content understanding. P4.4 delivers footage search from transcript + scene cuts;
this appendix is the visual/semantic layer beyond that.

- [ ] **B.1** Transcription engine: a real speech-to-text sidecar endpoint so transcript
      (and thus captions, footage search, hook detection) works on raw footage that arrives
      without one — the cheapest, highest-value step and a prerequisite for much of P2/P13.
- [ ] **B.2** Visual content tags: land the dark `detect_faces` (and shot-type/composition
      tags) behind a real engine, ingested into the semantic index (P4) so the planner can
      reason about *who/what* is on screen, not just when cuts happen.
- [ ] **B.3** Emotion/action/moment detection: reaction shots, laughs, emphasis, energy — the
      signals a story editor cuts on — as analysis tools feeding the planner.
- [ ] **B.4** Multimodal footage search: "the wide shot of the ocean at sunset" over visual
      embeddings, superseding the transcript-only P4.4 for shots without dialogue.

**Acceptance (when/if pursued):** the agent can honor a story-level request — "cut to the
best reaction after the punchline" — by actually understanding the footage, with every new
analysis engine shipping *before* the AI capability that depends on it (build-order §1.1),
and never fabricating a detection it can't make.
