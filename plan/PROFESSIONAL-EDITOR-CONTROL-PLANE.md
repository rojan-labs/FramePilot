# Professional Editor Control Plane

**Status:** `[~]` active  
**Started:** 2026-08-12  
**Branch:** `codex/professional-editor-control-plane`  
**North star:** every professional edit FramePilot supports is discoverable, referentially
unambiguous, deterministic, reversible, observable, and verified through one execution policy.

## 1. Reframe: the real problem

Literal request: add editor context, a target resolver, EditIR, professional compilers, one
execution graph, registries, reviewers, controllers, and evals.

That list describes symptoms. The underlying problem is that the model currently crosses from
natural language to low-level tools before FramePilot has established an authoritative answer to
three editor questions:

1. What is the editor looking at and manipulating right now?
2. What professional edit does the request mean?
3. Did the resulting temporal work actually achieve the editorial objective?

Five whys:

1. Why can “move this three frames” be unreliable? The tool receives a range, not the full live
   interaction state.
2. Why does the tool need to infer “this”? No deterministic resolver owns referents.
3. Why can a valid patch still be an amateur edit? Primitive operations do not encode professional
   edit semantics or invariants such as duration preservation.
4. Why do routes behave differently? Recipes, one-shot edits, planned edits, and agent runs enter
   execution at different abstraction levels.
5. Why can the system declare success too early? Technical validation proves legality, but a single
   frame or patch diff cannot prove timing, tracking stability, color continuity, or audio intent.

Actual goal:

> FramePilot must operate a professional editor state machine: bind user language to authoritative
> editor state, compile professional commands into validated reversible primitives, execute them
> through one policy, and judge the temporal result against explicit evidence.

## 2. Current-state evidence

| Boundary          | Current strength                                                                                                                                               | Concrete gap                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Manual editing    | `apps/web-editor/src/editor/store.ts` routes edits through validate → apply → record.                                                                          | Live playhead and clip selection are UI state, not a complete AI interaction contract.                                                                 |
| AI context        | `packages/ai-sdk/src/context-builder.ts` has bounded timeline, transcript, memory, history, footage map, visual status, pinned clips/assets, and a time range. | `ContextInput` lacks selected clip/track/effect/keyframe refs, source-monitor state, inspector focus, visible range, and explicit revision provenance. |
| Tool execution    | `packages/ai-sdk/src/tool-context.ts` sandboxes tools to project, range selection, and skills.                                                                 | Mutating tools can receive a guessed ID from a model; no resolver verdict or ambiguity policy is required.                                             |
| Editing mechanics | `packages/editor-core/src/operations.ts` provides typed immutable reversible primitives; `patch.ts` validates and inverts.                                     | Professional operations such as roll, slip, slide, insert, and overwrite are not first-class semantic commands with invariants.                        |
| Time              | `packages/ai-sdk/src/frame-time.ts` snaps authored timing; `packages/editor-core/src/timeline-map.ts` owns source↔sequence mapping.                            | The intent boundary still accepts generic seconds and does not distinguish source, sequence, and frame domains.                                        |
| Cut structure     | `packages/editor-core/src/edit-boundaries.ts` derives real adjacent cut points and handle information.                                                         | It is not yet the authoritative resolver/compiler input for roll and transition-adjacent commands.                                                     |
| Orchestration     | `packages/ai-sdk/src/kernel/agent-graph.ts` is the sole LangGraph agent runtime with pure conductor decisions.                                                 | Recipe, one-shot edit, planned-edit, and agent facades still compile/execute at different levels and have documented surface parity gaps.              |
| Verification      | `packages/ai-sdk/src/critic.ts`, `verify.ts`, and engine validation cover technical outcomes; `get_frame` supplies composited evidence.                        | No first-class temporal review request/result contract aggregates multi-frame, scope, motion, tracking, and audio evidence.                            |
| Desktop boundary  | `packages/shared-types/src/ipc.ts` and `apps/desktop/electron/ai/ai-stream.ts` validate history, a simple time range, memory, and run options.                 | Rich interaction context is not a versioned, bounded, fail-closed wire contract.                                                                       |

## 3. Constraints and non-goals

Real constraints:

- Preserve the five invariants in `AGENTS.md`: no original-media mutation, typed operations,
  validation before apply, render validation, and patches requiring human control.
- Preserve the build order. Compiler mechanics land on the existing patch/render foundation before
  broader agent automation.
- Browser, Electron, MCP, and automation must converge on serialisable contracts; live callbacks
  remain host-side.
- Every frame-changing command must be deterministic at rational frame rates and reversible.
- No schema field is added to persisted projects merely to carry ephemeral interaction state.
- No new dependency without license review.

Non-goals:

- Rebuilding the timeline/patch engine.
- A parallel “AI project mutation” path.
- Full Fusion/After Effects 3D compositing in this initiative.
- Cosmetic UI whose only purpose is to imply capability.
- Letting the model calculate coupled edit mechanics or infer missing referents silently.

Unknowns to resolve with implementation evidence:

- Whether editor command contracts deserve a new `@framepilot/editor-intent` package after P0, or
  can stay within `editor-core` without creating dependency pressure.
- Which temporal checks can remain deterministic and which require a vision-capable reviewer.
- Whether track targeting should use persistent role metadata or derive role from content until the
  project schema has a migration-backed need.

## 4. Lateral alternatives

### A. Bigger tool registry

Add roll/slip/slide tools directly to the existing registry and improve descriptions. This is the
smallest diff, but leaves referent ambiguity and duplicates professional mechanics at every tool
entry point.

### B. New editor-intent/editor-context packages immediately

Create the final-looking package tree first, then migrate all callers. Boundaries are visually
clean, but ownership would be based on aspiration rather than measured dependencies and would
front-load monorepo churn.

### C. Contract spine with vertical proofs — chosen

Introduce the smallest authoritative contracts in their present owners, then prove one complete
host → context → resolver → command → compiler → patch → verify path. Extract packages only when
the proven dependency graph demands it. This treats architecture as an executable contract.

### D. Event-sourced editor brain

Resolve “this/that/again” entirely from the edit event log, like a database projection. It is
powerful for history and replay but cannot replace current selection, playhead, inspector focus, or
source-monitor state; use it later as one resolver evidence source.

### E. Invert the agent: command palette first

Require every UI/manual action to emit an `EditorCommand`, then let AI call the same commands. This
would guarantee parity, but forcing all mature manual interactions through a new semantic layer
before the compilers are proven creates unnecessary migration risk.

### F. Constraint-added ontology generation

Define each editor property once and generate inspector metadata, tool schemas, validation docs,
and eval fixtures. This is the best long-term anti-drift mechanism, but it depends on stable command
and capability contracts; starting here would encode today’s inconsistencies.

## 5. Convergence matrix

Scores: 5 is best. “Migration” scores low when migration cost is high.

| Approach                     | Goal fit | Complexity | Risk | Maintainability | Migration | Reversible |
| ---------------------------- | -------: | ---------: | ---: | --------------: | --------: | ---------: |
| A. Bigger registry           |        2 |          4 |    2 |               1 |         5 |          3 |
| B. Packages first            |        4 |          2 |    2 |               4 |         1 |          3 |
| C. Contract spine            |        5 |          4 |    4 |               5 |         4 |          5 |
| D. Event-sourced brain       |        3 |          2 |    3 |               4 |         2 |          4 |
| E. Commands for all UI first |        4 |          1 |    2 |               5 |         1 |          3 |
| F. Generated ontology first  |        4 |          2 |    3 |               5 |         2 |          4 |

Killed now: A cannot solve the semantic problem; B and E front-load churn; D is incomplete; F is
sequenced after contract stabilization. Wildcard: F becomes the winning architecture when P0 has
at least ten stable professional commands and duplicated property contracts can be measured across
schema, inspector, tools, and render validation.

## 6. Target architecture and ownership

```text
Host editor state
  -> EditorInteractionContext (ephemeral, serialisable, revision-stamped)
  -> TargetResolver (pure evidence ranking; resolved | ambiguous | unresolved)
  -> EditorCommand (professional semantic contract in frame/source/sequence domains)
  -> Domain compiler (pure mechanics + preconditions)
  -> Patch<AnyOperation> (existing editor-core boundary)
  -> validate/apply/invert (existing editor-core authority)
  -> preview/render evidence
  -> technical + temporal/perceptual review
  -> commit or bounded repair through the same command pipeline
```

Ownership rules:

- `apps/web-editor`: capture live UI state only; never resolve or compile editing semantics.
- `packages/shared-types`: dependency-free, versioned IPC projection of interaction context.
- `packages/ai-sdk/editor-context`: interaction context, referent syntax, resolver policy, context
  projection, and model-facing summaries.
- `packages/editor-core`: professional command contracts and deterministic compilers because they
  depend on timeline mechanics and emit existing operations. No model/provider imports.
- `packages/ai-sdk/kernel`: one lifecycle policy and domain-controller orchestration.
- `engine/python`: deterministic analysis/render evidence; never AI-owned project mutation.

## 7. Contract rules

### EditorInteractionContext

- Ephemeral and revision-stamped; never persisted in `project.fp.json`.
- Carries sequence id, playhead frame/seconds, primary selection, selected clip/track/effect/
  keyframe/mask/transition refs, time range, visible timeline range, inspector focus, source monitor,
  preview-visible clips, and bounded recent edit refs.
- All IDs are treated as untrusted references and checked against the exact project revision.
- Browser builds it from the live editor store at turn submission. Desktop re-validates the wire
  shape, bounds arrays/strings, then verifies references against authoritative project state.
- A stale revision may support read-only discussion but cannot authorize a mutation.

### TargetResolver

- Pure function of project + interaction context + structured target query + bounded reference
  memory/evidence.
- Returns a discriminated result: `resolved`, `ambiguous`, or `unresolved`; never picks silently when
  two candidates have equal authority.
- Evidence precedence: explicit IDs/pins > direct selection > playhead hit/edit point > inspector or
  source-monitor focus > bounded recent edit references > semantic/subject evidence.
- Mutating commands require `resolved`; ambiguous results become one precise user question.

### EditorCommand / EditIR

- Commands express editorial intent and invariants, not primitive patch choreography.
- V1 time deltas are integer frames. Boundary types distinguish sequence edit points from source
  media ranges.
- Each compiler returns either a validated patch candidate plus compiler facts, or a typed rejection
  naming missing handles, lock/sync conflict, overlap, range, or stale-context cause.
- Compilers are pure and deterministic. The model never calculates coupled trim/move operations.

### Execution and review

- Every route enters the same lifecycle stages. Recipes are precompiled command plans, not a bypass.
- Micro-edits may auto-commit only after resolver, compiler, validation, and undo construction pass.
- Larger edits execute on a working copy and require technical plus objective-specific review.
- Repair is bounded and re-enters at command/compile, never by mutating a rendered artifact.

## 8. Delivery slices and acceptance gates

### P0.1 Interaction context + target resolver `[x]`

- [x] Define serialisable interaction context and typed resolver result/query contracts.
- [x] Capture live playhead and selected clip IDs in the browser at the turn boundary.
- [x] Lift real effect-layer selection, keyframe-lane selection, and source-monitor playhead/marks
      into the same snapshot without persisting panel state in the project.
- [x] Version, validate, and bound the same context over Electron IPC; the resolver can now recheck
      authoritative project revision at mutating call sites.
- [x] Add deterministic clip, track, range, and edit-point resolution with explicit ambiguity.
- [x] Inject a bounded interaction summary into model context and the interaction snapshot into tools.
- [x] Tests prove `this`, `these`, `here`, `before this cut`, stale revision, missing IDs, selected
      tracks/ranges, equal candidates, effect/keyframe filtering, and source-monitor IPC bounds
      without relying on model output.

Gate: the same fixture resolves identically in browser and desktop and no mutating tool receives an
unresolved free-form referent.

### P0.2 Professional command kernel `[x]`

- [x] Define `EditorCommand` V1 with revision-bound frame-domain inputs and typed compiler outcomes.
- [x] Implement roll, slip, slide, ripple trim, insert, overwrite, replace, lift, extract, J-cut,
      and L-cut compilers against editor-core. The cross-runtime `set_clip_media` primitive preserves
      replace-edit state.
- [x] Validate source handles, locks, linked A/V sync, collisions, and duration invariants.
      J/L commands prove explicitly named audio/video pairs share assets and an aligned cut before
      moving only the sound boundary.
- [x] Every command tests compile, apply, invert, and exact project restoration, including rational
      rates, authority, locks, handle rejection, gap behavior, three-point edits, and linked media.
- [x] Expose commands through domain-owned AI tools only after compiler tests pass. The first
      `professional_edit` module resolver-gates roll/ripple/slide/lift/extract and delegates all
      choreography to `compileEditorCommand`. Slip/insert/overwrite/replace now consume the validated
      interaction-v2 source clock, source marks, selected destination, and playhead without model IDs
      or positions. J/L cuts resolve an aligned source-linked picture/sound boundary and accept only a
      semantic direction plus positive frame magnitude.
- [x] Recheck the captured interaction revision against the host-authoritative project revision at
      every professional controller boundary. Project-only changes now fail stale even when the
      timeline revision happens not to move. Multi-command tools assemble one combined patch,
      validate it, apply it, construct its exact inverse, and prove content restoration before any
      operation leaves the domain module.

Gate: outcome evals pass at integer and rational frame rates; the LLM supplies intent/parameters but
never primitive choreography.

### P1.1 Unified execution `[~]`

- [x] Define one `EditorRun` stage/event vocabulary: understand, resolve, inspect, plan, compile,
      execute, verify, review, repair, finalize. The schema, per-route policy, and pure transition
      reducer enforce run/route identity, monotonic sequence, forward progress, terminal finality,
      and repair-only re-entry.
- [~] Adapt recipe, edit, planned-edit, and agent routes into the lifecycle without golden-session
  drift; delete paths only after parity evidence. All browser, desktop, recipe, planned-edit,
  and auto-router mutation handoffs now enter `streamEditorRun`; desktop recipe and planned-edit
  requests cross the validated main-process IPC boundary instead of executing locally or refusing.
  A four-route matrix proves
  exact legacy event parity. A separate serialisable lifecycle channel now projects live legacy
  events into reducer-valid stages, including explicit failed/cancelled termination, without
  changing UI events. Desktop persists those records in its existing per-run WAL before
  settlement and replays them through snapshot recovery. MCP durable policy parity has landed:
  its document-level guarantees (ordered application, exact reversal, monotonic revisions,
  lost-update conflict) are pinned against the shared patch engine. Browser routes now always
  publish lifecycle stages and enter temporal review; an unconfigured reviewer releases only an
  explicitly unverified human-review proposal. Auto-commit requires the positive `verified`
  disposition, so missing legacy markers cannot bypass the gate. Browser-local durable
  persistence remains — the renderer has no equivalent of the desktop WAL, so a browser run
  cannot yet be replayed after a reload. Route drivers stay compatibility internals until it lands.

  **Shape of the remaining work, from reading the seam (2026-08-12).** This is smaller than
  "build a second WAL". `RunStore` (`apps/desktop/electron/ai/run-store.ts`) is already
  abstracted over a `RunStoreIO` interface of pure string I/O — read/append/checkpoint/snapshot/
  quarantine/list — and every Node call sits below it in `FileRunStoreIO`. The store itself
  (validation, per-run write lanes, sequence and project-identity conflicts, WAL bounds,
  quarantine, snapshot recovery) is host-agnostic today. So:

  1. Move `RunStore`, `RunStoreIO`, `RunMigrationRegistry`, `pageRunEvents`, and the two error
     classes into `packages/ai-sdk`; leave `FileRunStoreIO` in desktop. The browser then inherits
     the guarantees as the _same code_, not a parallel implementation that has to be re-proved.
  2. Add a browser IO adapter. `localStorage` is the pragmatic first target over IndexedDB: it
     exists in jsdom, so the adapter is testable without a new dependency, and the WAL is already
     bounded per run (`MAX_DURABLE_RUN_WAL_CHARS`) with a retention sweep. The trade-off to state
     in the ADR is the ~5 MB origin budget shared with the rest of the app — durability across a
     reload, not a general-purpose archive. IndexedDB is the upgrade path when size demands it,
     and behind the same interface it is a swap rather than a rewrite.
  3. Wire it at the seam that already exists: `BrowserAiSession` (`apps/web-editor/src/editor/ai.ts`)
     passes `onLifecycleEvent` into `streamEditorRun`, so appends need no new plumbing, and
     `recover`/`recoveryConversationId` are already optional members of `AiSession` that only the
     desktop implements — implementing them in the browser is the whole user-visible change.

  Deliberately deferred rather than forgotten: this is a browser-only gap, and `CLAUDE.md` makes
  the desktop app the product focus with browser-only gaps explicitly acceptable to defer.

- [x] Give browser, desktop, and MCP one serialisable command/effect policy. A cross-host parity
      fixture proves the browser/desktop registry path and the MCP editing session produce identical
      operations, identical validation issues, and the same editorial diff for the same call, and
      that an illegal command is refused by both while committing nothing. Interaction-dependent
      (`hostUiOnly`) tools are now refused **by name** at the session boundary with a typed
      `host_ui_only` error, not merely omitted from the advertised tool list — hiding a tool was
      never enforcement, since any client can name it directly.
- [x] Preserve cancellation, approvals, replay, recovery, idempotency, costs, and event ordering.
      Each host keeps its own proof and the cross-host fixture pins the shared invariants:
      `editor-run-lifecycle.test.ts` holds ordering, monotonic sequence, and terminal finality;
      `editor-run-adapter.test.ts` settles cancellation during evidence acquisition as cancelled,
      never completed; `run-coordinator.test.ts` persists lifecycle records beside UI events, replays
      them through recovery, and stays terminal after a sourced cancel; `cross-host-parity.test.ts`
      proves an ordered command sequence lands the same timeline on every host and that undo
      restores the exact prior content while revisions stay monotonic so stale references still fail.

Gate: **partially met** — `packages/mcp-server/src/cross-host-parity.test.ts` produces equivalent
operations, validation, and editorial outcome across hosts, and the per-host lifecycle suites above
cover terminal-event equivalence. Browser reload recovery remains the unmet durability clause.

### P1.2 Capability/property registry + domain tools `[x]`

- [x] Register capability id, domain, applies-to kinds, value/unit/bounds/default, keyframeability,
      inspectability, editability, compiler, verifier, inverse path, operation types, and
      availability reason. The first truthful manifest derives all 12 professional commands plus
      shipped motion, color, and audio property bounds from runtime editor-core contracts.
- [x] Split tool ownership by timeline, media, motion, color, tracking/mask, audio, captions,
      graphics, project, and verification while keeping one generated public manifest. All ten
      families now own their specs in `packages/ai-sdk/src/domain-tools/`, composed into the single
      `TOOL_REGISTRY`. `tool-registry.ts` went from 2,591 lines to 431; what remains declared there
      is the agent's _session_ surface — project state, evidence recall, skill loading, frame grabs,
      and asking the human — which is how a run works rather than what it edits, and which no
      editing domain owns.

      The split is by domain **across kinds**, not by the kind-grouped arrays the file was already
      shaped into. That distinction was the whole point: captions alone spans read and mutate, and a
      caption rule changed in one array and missed in the other reads to a user as a bug in
      captions. Each family took the helpers with exactly one caller family, so the registry loses
      the constant along with its last user instead of keeping a shared-looking one.

      Two facts kept it safe. `toolDescriptors` sorts by name before serialising (an explicit
      prompt-cache invariant), so composition order cannot reach a provider; and the generated
      tool-parity fixture regenerated byte-identical at every step, which is what proves these were
      moves rather than edits.

      **Three bugs surfaced, all the same shape — a check that quietly compares less than it claims
      to.** (1) Moving `seconds` away from its `coerceNumericString` wrapper compiled and read
      identically while silently rejecting the string-encoded numbers several providers emit; the
      registry shape test caught it, and primitives now move with their coercion. (2) The Python
      cross-language parity test read `tool-registry.ts` as source text, so a moved tool *stopped
      being compared* rather than started failing — it now reads the domain modules too, and the
      host-only exclusion is complete instead of "inline declarations only". (3) Reading those
      modules as one concatenated string then let a file's last spec body absorb the next file's
      first flag, dropping `remove_marker` out of the compared set; a file boundary is now a hard
      boundary for that scan. Each passed green while its coverage shrank, which is the failure mode
      worth watching for in any future move.

- [x] Detect drift between property schema, tool schema, compiler, docs, and eval fixtures. Runtime
      tests fail on duplicate ids, tool availability/mutation drift, omitted compiler commands, and
      professional intent/command mismatch. The published scorecard's per-domain and total counts
      are now checked against the live registry, so documentation cannot silently overstate the
      product, and eval fixtures are reconciled against runnable cases in both directions.

Gate: every advertised mutable capability has a compiler, validator, inverse path, verifier, and
test; unavailable capabilities are explicit.

### P1.3 Temporal/perceptual reviewer `[~]`

- [x] Add versioned, revision-bound frame/range/comparison/scope/motion/audio evidence requests and
      results with strict lineage, window coverage, and result-family validation.
- [x] Use bounded beginning/middle/end representative frames plus critical temporal windows chosen
      from professional command compiler facts; J/L cuts additionally request their sound boundary.
- [x] Implement deterministic checks for transform smoothness, crop bounds, black/isolated-flash
      frames, explicit comparison continuity, legal scopes, audio peaks/discontinuities, and tracker/
      mask jitter. Acquire their measurements from one bounded compilation of the live project.
- [x] Add vision review only for semantic objectives that deterministic evidence cannot judge.
      `reviewVisionObjectives` answers questions a number cannot settle — is the subject still
      framed, is the incoming camera on the same moment — and is deliberately kept from becoming the
      reviewer: never the default, additive in the Critic so a vision pass can fail a clean review
      but never rescue a failed one, `cannot_tell` settling as unverified rather than as a pass, no
      configured reviewer being a refusal instead of an assumption, and at most four distinct frames
      in one call with no retry loop. Every failure mode — no reviewer, an unacquirable frame, a
      malformed verdict, a thrown error — lands on unverified; the only route to a pass is a
      well-formed pass verdict over frames that were actually looked at.
      The contract and Critic composition are complete, but `reviewVisionObjectives` still has no
      production run caller. Normal edit routes therefore must not claim subject-framing or semantic
      judgement; wiring explicit semantic objectives into the unified gate remains open.
- [x] Record evidence lineage, project revision, render settings, and reviewer decision. The engine
      returns a self-validating compiler-settings identity and the unified EditorRun persists it with
      revision, exact request ids, and decision in its durable review stage.
- [x] Gate successful edit/recipe/planned-edit/agent/auto settlement on the same temporal Critic pass;
      missing acquisition fails closed and cancellation remains cancellation.
- [x] Stage validated run diffs until temporal review passes, so desktop auto-commit never persists a
      perceptually rejected or cancelled edit.
- [x] Add one bounded repair from concrete failed evidence through the ordinary typed tool → validated
      patch pipeline, then require a second temporal pass before releasing either staged patch.

Gate: **partially met** — intentionally broken deterministic temporal fixtures fail for the right
reason and bounded repair closes a repairable failure without bypassing the patch pipeline. It is
not fully met until declared semantic objectives invoke the vision reviewer in production.

### P2 Domain controllers `[~]`

- [x] Timeline: cutting, pacing, source/sequence targeting, linked sync, multicam.
      `TimelineEditObjective` now resolves authoritative source/sequence state into command batches;
      evidence-linked A/V edits preserve sync by default, deliberate desync is explicit, and
      ambiguous companions fail closed. A render-backed objective fixture proves the
      picture cut is frame-accurate (frame 29 outgoing, frame 30 incoming) with continuous sound
      across the boundary, measured from real decoded media. Multicam is now schema-backed and
      executable: schema v18 adds project-scoped `angleGroups`, where a group is a set of cameras
      that filmed the same moment and each angle carries the source offset that lines it up with the
      others (ADR 0112). Membership is derived from the media a clip plays rather than stored per
      clip, so it cannot drift from what is actually rendered; an asset claimed by two groups is
      refused instead of resolved. `switch_angle` cuts at the playhead, maps the position through both
      angles' offsets so the incoming camera resumes on the same instant rather than the same
      timestamp, and compiles to `split_clip` + `set_clip_media` — the primitives replace edits
      already used — with an exact inverse. The switch changes picture only: sound is untouched, so a
      camera change is never an audible jump in room tone, and no edit point moves in time. Sync
      offsets are authored; absent is not zero, and an unsynced angle, an ungrouped asset, a retimed
      clip, or a camera that was not rolling each fail closed naming the fix. A second render-backed
      fixture proves the mapping the only way pixels can: the incoming camera's content encodes when
      you are in its recording, so the correctly synced instant and the un-offset one measure as
      different colours. Automatic sync detection stays deliberately unavailable.
- [x] Motion/keyframe: selected-property animation, easing, continuation, transform constraints.
      `professional_motion` now resolves one live clip/property into revision-bound clip-frame commands;
      `animate_to` evaluates the playhead value, `continue` extrapolates a selected trajectory, and
      optional frame-by-frame canvas-cover checks reject black-edge transforms. The compiler owns
      property/timing/lock validation plus exact inverse construction. A render-backed objective
      fixture proves the trajectory is strictly increasing and evenly paced while no rendered sample
      reveals the canvas.
- [x] Color: reference-shot selection, shot grouping, base correction, matching, skin preservation,
      scope and temporal consistency evidence. `professional_color` resolves one or many live clip
      targets and compiles explicit bounded adjustments into a stable per-clip primary correction
      node while preserving separate creative looks. A render-backed objective fixture measures the
      same shot graded and ungraded through the real render path, proving positive exposure actually
      lifts the image and that scopes stay legal. `measure_color` stores opaque run-scoped handles
      from complete temporal scope statistics, and `match_reference` derives restrained primary
      corrections only after source, revision, clip, completeness, and occlusion checks pass. Derived
      deltas accumulate onto the primary correction already visible in the measurement, with contract
      clamping; the model-facing contract is a flat provider-compatible object whose cross-field
      validator still forbids mixed modes. Rendered 8-bit min/max samples alone are not treated as
      proof of highlight/shadow preservation. Shot grouping expands one resolved shot into every clip
      cut from the same source recording — a fact about the footage, where a similarity threshold
      would regroup the moment a grade lands; multicam needs no special case because an angle _is_
      one recording. Skin preservation is measured, not asserted: `measure_color` now also reports
      the pixels a documented RGB skin qualifier selects, as `skin_*` channels with a coverage ratio,
      and a match asked to protect skin scales its white balance back until skin **warmth** (red:blue
      ratio) stays inside 8%. Coverage below 2% is a refusal naming the reason, never a silent "no
      drift", and a measurement predating the skin channels refuses too. The tolerance is on warmth
      rather than hue because the render-backed fixture said so — a large temperature push rotates a
      skin tone's hue by about a degree while moving its red:blue ratio by more than half, so the
      first version of this constraint would have guarded nothing.
- [~] Tracking/mask: point/object/face/region/planar/segmentation targets that can drive transforms,
  masks, local color, graphics attachment, and reframe. The first vertical slice resolves one
  live shot and its existing canonical rectangle/ellipse mask, compiles editor-authored bounds
  and correction keyframes into a reversible canonical manual tracker, and adds bounded
  inside-frame/acceleration/jitter evidence to the unified temporal gate. Canonical masks and
  tracks replace by ID across TS/Python. A render-backed objective fixture proves the tracked
  region stays fully inside frame and advances without jitter. Automatic face/object, point,
  planar, segmentation, and tracked transform/local-color/graphics/reframe consumers remain; the
  registry reports automatic CV tracking unavailable instead of simulating it.
- [x] Audio: dialogue/music/SFX roles, J/L edits, ducking, loudness, EQ/dynamics, automation, and
      discontinuity review. The first vertical slice resolves selected clips into revision-bound
      `mix_clip_audio` commands for bounded gain, mute, peak normalization, and frame-based fades.
      Selection-authored ducking treats the primary clip track as the bed and requires exactly one
      other selected audio-capable sidechain track, so neither track IDs nor dialogue/music roles
      are guessed. The compiler merges omitted canonical mix settings, returns an exact inverse,
      and shares self-duck/missing-sidechain rejection plus fade-curve persistence across TS/Python.
      Changed mixes request beginning/middle/end peak and discontinuity evidence, including
      embedded audio on video tracks. A render-backed objective fixture measures the same bed with and
      without the compiled mix, proving the gain reduction survives into the render, the result is
      peak-safe, and the fade makes the opening measurably quieter than the body. Schema v17 adds an
      authored `Track.role` (dialogue/music/sfx) mirrored in Python, with a deliberately no-op
      migration: roles are never inferred from track or file names, and absent stays unknown
      (ADR 0111). Role-isolated evidence now works on top of it: a `dialogue`/`music`/`sfx` request
      compiles a role-muted copy of the timeline and measures that role alone, and a render-backed
      fixture proves the isolated peak sits below the combined mix without being silence. Asking for a
      role no track carries fails closed with the missing-label reason instead of returning quiet.
      Role-based ducking now expresses the instruction directly: `duck_roles` with `bedRole`/
      `sidechainRole` ducks every clip of one authored role under the single track carrying the other,
      needing no selection. Missing or duplicated role labels fail closed with the label as the fix.
      Integrated loudness is measured per role through ffmpeg's `ebur128` against a delivery target,
      with the reviewer failing readings in either direction. Fixing that path also fixed a latent
      bug where any audio window past roughly 1.4s measured as digital silence with no error.
      EQ, dynamics, and gain automation now complete the strip (ADR 0113). All three extend the one
      canonical `audio_gain` effect rather than adding effect types, and a lane is written to that
      effect's existing `Effect.keyframes` with property `gainDb` — the schema's own lane shape, read by
      the keyframe evaluator both runtimes already share, so no persisted shape changed and no schema
      version moved. The renderer runs one stated order: mute → normalize → EQ → compressor → fader
      (gain or automation, fades, ducking). Gain is a fader move, so the compressor threshold sees the
      clip at its recorded level and lowering a clip does not silently stop it compressing; a lane
      supersedes the static level rather than multiplying with it, and authoring both — in one command,
      or on a clip that already has a lane — is refused naming the fix. EQ is a zero-phase magnitude
      curve from the analog RBJ prototypes through the real FFT (no group delay to shift sound against
      picture, no cramping near Nyquist), and the compressor detects peaks in 1 ms blocks, which is also
      the contract's minimum attack so no authored attack is one the export rounds away. Three
      render-backed fixtures prove each reaches the output: a high-pass silences the fixture tone while
      the ungraded copy stays audible, compression pulls the settled peak down without reaching silence,
      and a lane's -40 dB opening measures 20× quieter than its own unity ending — which also
      distinguishes "the lane ran" from "the static gain won" and from "the two multiplied". A lane
      additionally requests its quietest and loudest authored points as evidence, because the middle of
      a clip proves nothing about a ride that dips at 0:03. **Code review caught two defects in this
      slice** (2026-08-13): `adjust_audio` rebuilt the canonical effect from the operation alone, so
      the legacy gain-only tool — which emits exactly `{clipId, gainDb}` — silently deleted an EQ,
      compressor, or lane authored moments earlier, contradicting this file's own doc comment; both
      runtimes now carry processors forward and removal is said explicitly with an empty band or
      point list. And the `eq`/`compress` intents accepted `gainDb`/fade fields and then dropped
      them, which is the silently-ignored field their own refusal block exists to prevent. The EQ
      also moved to overlap-added blocks: one FFT over a ten-minute stereo bed costs more than a
      gigabyte, and peak memory must not scale with clip length on the desktop media path.

Gate: **partially met** — each controller returns commands, never raw timeline mutation. Timeline,
color, and audio have genuine decoded render proofs; motion trajectory assertions still read stored
keyframes, and the tracking fixture currently proves authored track metadata rather than pixels.
Automatic tracking and its transform/local-color/graphics/reframe consumers also remain open.

### P3 Professional operation evals `[~]`

- [x] Add a capability-derived eval manifest and deterministic fixture projects. The manifest now
      registers one unique fixture id for each of 33 advertised editable capabilities and fails
      drift when a new capability has no row. All 33 registered fixtures now have runnable cases in
      `PROFESSIONAL_EVAL_CASES`, and drift fails in both directions when a registration has no
      executable case or a case has no registration. A one-shot Node-to-Python bridge now stages
      isolated synthetic media, renders the applied project through production acquisition, and the
      opt-in release command requires all 33 rows to earn `verify`.

  **Rendered checkpoint (2026-08-13).** `pnpm eval:professional:rendered` passed 33/33 registered
  rows on a provisioned development machine. The bridge passes the persisted post-edit project;
  a regression assertion prevents the previous revision-mismatch/before-state bug from returning.
  Audio-only projects compile against a deterministic black canvas so their authored mix can be
  measured without inventing picture media.

  **Release-equivalent checkpoint (2026-08-13).** The expanded `pnpm verify` aggregate passed in
  one run: 15/15 workspace typecheck and lint tasks, all workspace coverage suites (including
  AI SDK 3,100 tests and web editor 2,384 tests), Python lint and strict typing across 186 source
  files, 2,512 Python tests with coverage, license scan, 9/9 production builds, 76 functional and
  7 visual Playwright cases, the real export/validation fixture, and the 33/33 rendered scorecard.
  The aggregate exposed and closed two cross-surface regressions before passing: sampling options
  were dropped by three OpenAI-compatible adapters, and six professional tools lacked explicit
  activity-card metadata.

  The remaining P3 work is semantic depth, not transport: add property-specific rendered objectives
  and plausible-wrong negative controls for motion/masks, the full color and audio property roster,
  and intent variants such as `continue`, `match_reference`, grouping, `duck_roles`, and multi-target
  batches. Stored keyframe trajectories and generic black/flash review are not pixel proof that a
  transform, tracker, grade, or processor changed the final audience output correctly.

- [~] Assert outcomes rather than tool-call spellings. The shared evaluator checks the applied
  timeline, exact inverse restoration, canonical project reload, and review plan without
  asserting which low-level tool spelling the model chose. All 33 cases assert real editorial
  results — roll moves only the shared cut, slip preserves clip bounds while shifting source, J/L
  cuts offset only the sound edit, grades land on one canonical primary layer without touching
  unselected shots, omitted mix settings survive, and the tracked region stays inside frame.
- [x] Require resolve, compile, validate, apply, invert, verify, persist/reload, and cross-host
      parity. These stages are mandatory in every manifest row; the shared evaluator currently
      executes validate/apply/invert, persistence, JSON transport parity, and evidence planning. Every
      case additionally executes resolve (through `resolveEditorTarget` or a domain controller) and
      compile (through the domain compiler). Timeline rows now traverse `TimelineController` instead of
      resolving an unrelated query and compiling hard-coded IDs. `verify` is earned only after the
      production acquirer returns revision-matched evidence and `reviewTemporalEvidence` passes; the
      rendered gate requires all 33 rows while the fast deterministic suite remains `not_acquired` by
      design.

  `cross_host` is now defined rather than left ambiguous. It cannot mean "this capability executes
  on every host": professional tools are interaction-dependent and deliberately refused on hosts
  with no validated interaction snapshot, so requiring MCP execution would contradict P1.1's own
  policy. It means the compiled result is host-portable — the patch survives serialisation
  unchanged and applies identically wherever it lands. The evaluator proves the transport half per
  row, and `cross-host-parity.test.ts` proves the shared-engine half: identical operations,
  validation, ordering, and reversal across the browser/desktop path and the MCP session.

- [x] Publish a capability scorecard with unsupported reasons; demos do not count as completion.
      The scorecard reports 33 registered editable rows and one unsupported automatic-tracking row,
      preserving the runtime CV-engine reason and explicitly distinguishing registration from a
      completed rendered eval.

Gate: every advertised professional operation has a green eval row, and release readiness fails on
registry/eval drift.

## 9. Failure, consistency, and recovery policy

- Revision mismatch: fail before compilation and request fresh host context.
- Missing/invalid reference: unresolved; never substitute nearest clip silently.
- Ambiguity: emit ranked evidence and ask one bounded clarification.
- Locked track/insufficient handles/sync conflict: typed compiler rejection with actionable facts.
- Mid-run manual edit: existing authority/rebase policy decides; context and resolver evidence are
  recomputed before any remaining mutation.
- Cancellation: preserve emitted events and working-copy evidence; commit nothing beyond already
  accepted atomic patches.
- Retry: model/analysis effects may retry under existing policy; patch application is idempotent by
  command/run identity or protected by revision checks.
- Perceptual failure: bounded repair command; if still failing, surface evidence and keep the last
  accepted project state.

## 10. Security and observability

- Treat the renderer context as untrusted IPC data: allowlists, finite numbers, array/string caps,
  structural parsing, and authoritative ID/revision checks in main.
- Interaction context contains project-local IDs and UI state only—no media bytes, filesystem paths,
  provider keys, or hidden prompt content.
- Tools remain sandboxed to handed-in data and registered effects.
- Log high-signal stage transitions and rejections through scoped loggers; never log transcript
  bodies or secrets.
- Metrics: resolution outcome/reason, ambiguity rate, stale-context rate, compile rejection reason,
  command latency, patch size, verify/repair count, cross-host parity, and eval pass rate.

## 11. Rollout and rollback

1. Add contracts and dual-write context behind no behavior change.
2. Enable deterministic resolver for new professional commands only.
3. Add one command family at a time; legacy tools remain rollback path until eval parity passes.
4. Adapt execution routes through compatibility facades; golden-session drift blocks deletion.
5. Generate capabilities/tool manifests only after contracts stabilize.
6. Gate auto-commit and controller expansion on objective evals.

Every slice is independently revertible because it either adds a contract/adapter or routes a new
command through the existing patch authority. Persisted project schema changes require a separate
migration-backed decision; none are part of P0.1.

## Proposal

Use the contract-spine approach. It wins because it changes the real control boundary while
preserving FramePilot’s proven deterministic engine, gives each slice an executable acceptance
gate, and keeps package extraction and code deletion reversible until dependency and parity evidence
exist. Start with live context plus deterministic resolution, then land professional command
compilers, converge execution, derive capabilities/tools/evals, and only then scale domain
controllers. Keep the generated ontology as the wildcard: promote it to the primary architecture
once ten stable commands expose measurable cross-surface property drift.
