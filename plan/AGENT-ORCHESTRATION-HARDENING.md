# Agent Orchestration Hardening — the loop that plans, asks, and actually edits

> **Sub-plan of [`plan/PLAN.md`](./PLAN.md).** Branch: `fix/agent-orchestration-core`.
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
> **Last updated:** 2026-07-15

> **Permanent redesign (2026-07-15).** Defects #1 and #2's original fixes (a recon-vs-spin
> dual budget, `NUDGE_TO_EDIT_AFTER` prompt escalation, `MAX_CONSECUTIVE_NO_PROGRESS`, and a
> stack of interacting constants) were replaced wholesale — they did not scale and had an
> off-by-one that stopped runs one turn before the nudge could fire. The orchestration layer
> now decides termination from ONE deterministic fact — *is the run still progressing?* — and
> suppresses redundant reads at the tool layer:
> - **Read memoization** (`HostCallContext.readCache`, orchestrator.ts): a repeat read on an
>   unchanged working copy is served from a per-run memo, marked non-novel ("already in your
>   context"), and the memo is invalidated the instant an edit lands. This is the deterministic
>   replacement for "stop re-reading" prompting — a model can no longer make a redundant read
>   look like fresh work.
> - **Convergence termination** (`STALL_CONFIRM_TURNS = 2`, conductor.ts `onTurnResult`): a turn
>   progresses if it applied an edit, attempted one (a rejected op is a bounded retry), or learned
>   something new. `STALL_CONFIRM_TURNS` consecutive non-progress turns — or an exact-repeat
>   signature — converge the run and stop it honestly. No prompt nudge, no recon budget, no
>   productive/unproductive asymmetry. `DEFAULT_MAX_AGENT_STEPS`/`maxOpsPer*` remain purely as
>   resource rails, not behavioral tuning.
> Both control paths (the streaming Conductor and the legacy `agent()` loop) share the model, and
> the parity harness stays green. The contract (`prompts.ts`) states the current timeline/assets
> are already in context once, statically, in place of the deleted escalation block.

## Why

Two real desktop runs (DeepSeek v4-flash, agent mode, `planFirst`) on project
"Champadevi" (34 stills, 5 text layers, a 20s music bed) drafted a competent 10-step
beat-sync plan and then finalized with **"No changes were made."** — zero ops applied,
twice. Orchestration is the product's core, so these are not cosmetic bugs.

Run 1 root cause (**fixed**, commit `11a4cda`): `load_skill` results were truncated to
~34% of each playbook, so the model re-loaded skills forever. Skills now deliver whole
and stay pinned.

Run 2 (post-fix) got further — 8 skills loaded once each, `detect_beats` returned 366
beats @ 123 BPM — and still applied nothing. Four independent defects remain, below.
Reviewed with an independent model (Fable 5); its corrections are folded in and
attributed inline.

## The defects

1. **The no-progress guard cannot tell reconnaissance from spinning.**
   `MAX_CONSECUTIVE_NO_PROGRESS = 4` counts _any_ turn that applied no edit. All four
   of run 2's turns were productive setup (session context → project state → skills →
   beats+frames → timeline). The run was stopped for doing exactly what it should.
   _Fable correction:_ `NUDGE_TO_EDIT_AFTER = 2` means turns 3–4 already carried the
   blunt "you MUST edit now" instruction and DeepSeek ignored it — so this is ~half
   guard misdesign, ~half model non-compliance. A guard fix alone will not make this
   model edit; the montage tool (§4) is what makes the request class model-proof.

2. **The budgets are mutually incoherent.** `parsePlanLines` allows 12 steps,
   `DEFAULT_MAX_AGENT_STEPS = 8`, the guard fires at 4. The ledger maps turns onto plan
   steps positionally, so a _compliant_ model was structurally guaranteed to leave
   steps undone — and the UI renders those never-run steps as a promise we cannot keep.

3. **The model is blind, and the blindness is persisted.** `AiMessage` is
   `{ role, content: string }`; no multimodal path exists anywhere (no `image_url`, no
   base64). Yet `extract_frames` says "so you can SEE its content… look at them, then
   call commit_vision to record what each shows." A text-only driving model that obeys
   must **fabricate** — and `commit_vision` writes that fabrication to the brain with
   `source='model'` (service.py:2218), where it feeds `search_media`/`find_similar` and
   future sessions. The hallucination compounds. This is precisely what ADR 0055
   prohibits. Known/deferred as ASK-gated in B4.2 — now being hit on desktop, the #1
   target. Separately `/extract-frames` hard-rejects images (422), so on a 34-still
   project there is nothing to see regardless.

4. **The deterministic beat-sync core is unreachable.** `montage.ts`
   (`buildBeatGrid`/`placeCutsOnBeats`, invariant `cuts ⊆ beats`) is built for exactly
   this request. But `streamPlannedEdit` is browser-only, absent from the mode picker
   (`SidebarMode = 'agent' | 'chat' | 'edit'`), and the classifier has no route to it
   (`chitchat | question | recipe | edit`), so every montage-shaped request lands in the
   free-form loop. `placeCutsOnBeats` already cycles multiple assets, but
   `build_shot_list` is single-asset (scene cuts within one video) — 34 stills have no
   scenes, which the code itself flags as the "P3.2 follow-up".
   _Fable, confirmed:_ the free-form tool surface was never the blocker — `add_clip`
   accepts `image` assets and 34 ops sit well inside `maxOpsPerTurn = 100`.

## Decisions taken (product owner, 2026-07-15)

- **Vision:** honest-gate now; do **not** build multimodal yet. Fix the image 422, stop
  advertising sight, and add a **generic LLM-driven ask primitive** so the model can put
  a real question to the user (Claude/Cursor style: "this doesn't exist — continue
  anyway / stop / …") and proceed on the answer. **No hardcoded question text** — the
  orchestration must carry arbitrary model-authored questions and options, including
  cases we have not thought of.
- **Montage:** wire it as a **tool the model calls**, not a flow handler that replaces
  it. The model keeps control of selection/placement; the tool guarantees beat
  alignment. Explicitly _not_ a zero-model-call route.
- **Scope:** one branch, a commit per step, this doc checkmarked as work lands.

## Workstreams

### W1 — Vision honesty (first: prevents the hallucination class, smallest diff)

- [x] **W1.1** Engine: `/extract-frames` on an image returns exactly one frame at t=0
      (an image _is_ its own frame) instead of 422. Check `detect_scenes` (service.py:1760)
      for the same `needs_video` rejection and handle honestly.
- [x] **W1.2** Declare a provider capability (`supportsImages`) on the provider/model
      config; thread it to the agent paths' `toolDescriptors` filter.
- [x] **W1.3** Gate `extract_frames`/`commit_vision` out of the **advertised** tool set
      when the driving model is text-only. **Do NOT remove them from the registry** — the
      MCP surface serves external vision-capable agents that can open the paths (Fable).
- [x] **W1.4** Remove "SEE"/"LOOK at them" wording from `AGENT_MODE_INSTRUCTION`, the
      nudge list, and the tool/digest copy while gated. Restore only when pixels flow.
- [x] **W1.5** Fix the `detect_faces` unavailable message — it currently advertises the
      impossible vision protocol as its replacement (Fable).
- [x] **W1.6** Test: no advertised tool claims perception the active provider lacks;
      engine test that an image asset yields exactly one frame.

### W2 — The ask primitive (generic, model-authored, not hardcoded)

- [x] **W2.1** `ask_user` tool: model supplies `question`, `options[]` (label +
      description), optional free-text. Registry + Python parity.
- [x] **W2.2** ~~Conductor `await_answer` effect~~ — **not needed, and better without it.**
      A question is a TOOL CALL, so the turn that asks simply awaits its own result, exactly
      as a sidecar analysis call already does. The answer then lands in the action log by the
      same route as any other tool result, so the next turn plans from it with no reducer
      change at all. A conductor effect would have added a second pause mechanism for no gain.
- [x] **W2.3** `run-controls`: an `askUser` resolver the host wires; honest default when
      unwired (never a silent deadlock — mirror `awaitApproval`'s degrade).
- [x] **W2.4** Event + reducer node so the question reaches the sidebar and the answer
      feeds back into the loop's next turn.
- [x] **W2.5** Desktop IPC wiring (desktop is the #1 target; not browser-only).
- [x] **W2.6** UI: question card with options; keyboard accessible; cancel/stop path.
- [x] **W2.7** Tests: model asks → run pauses → answer resumes → answer is in context;
      unwired host degrades honestly; abort mid-ask settles `cancelled`.

### W3 — Guard + budget (make legitimate multi-step runs survivable)

- [x] **W3.1** Driver reports per-call facts `{ key, status, fromCache }[]` on
      `AgentTurnResult` (it already knows all three and throws them away).
- [x] **W3.2** Reducer novelty rule (pure): a no-edit turn is _productive_ iff ≥1 call is
      first-seen this run **and** completed/warning **and** not a cache hit. Novelty key:
      read/skill tools → `name + canonical(args)`; **analysis tools → `name + assetId` only**
      (Fable) — so a sensitivity sweep collapses to one key while a different asset stays
      novel. New state: `seenCallKeys`, `reconRemaining`.
- [x] **W3.3** Split the counters: productive no-edit turns decrement a recon budget
      (≈`ceil(maxSteps / 2)`); unproductive ones increment a spin streak whose cap can now
      drop to 2–3 because it only counts genuine spinning. Keep the exact-signature
      `noProgress` list as belt-and-braces.
- [x] **W3.4** `maxSteps = max(default, planLength + 2)` when `planFirst` produced a
      ledger, so the plan can never promise more than the run can execute.
- [x] **W3.5** Parity: mirror in the legacy non-streaming loop.
- [x] **W3.6** Tests + parity harness: N distinct successful uncached recon turns then an
      edit never terminate early; all-cache / all-failed / all-seen turns trip the streak;
      same analysis tool + different args is never novel.

### W4 — Montage as a tool (model-driven, deterministic guarantee)

> **Removed (2026-07-15, product decision).** The entire montage feature this
> workstream shipped — `synthesize_beat_montage` and its Zod/Python schema,
> `montage.ts`/`montage-leaves.ts` (`PLANNER_LEAVES`), the `select_shots` model
> step, and both test suites — was deleted per an explicit user decision to
> remove montage entirely, not iterate on it further. The checklist below is
> left as-is as a historical record of what W4 built and verified; none of it
> exists in the codebase anymore. `detect_beats`/`detect_scenes` and
> `buildBeatGrid` (used by `semantic-index.ts`) were explicitly KEPT — only the
> beat-sync-as-a-tool planner path is gone. The planner path now runs on
> `RECIPE_LEAVES` alone (`propose_edit` + the existing pacing/caption/hook/etc.
> leaves), which absorbed `PLANNER_LEAVES`'s role as the default leaf registry
> in `orchestrator.ts`/`plan-driver.ts`. TS (1359 tests) + Python (962 tests)
> both green after removal; see `plan/PLAN.md`'s 2026-07-15 Agent Orchestration
> Hardening entry for the full reconciliation note.

- [x] **W4.1** Pure stills shot-list leaf: N image assets → N `Shot`s (the flagged P3.2
      gap). Table-tested like its siblings.
- [x] **W4.2** A montage tool the agent calls with ITS chosen params (asset order, beat
      source, every-N-beats, target duration) → beat-aligned ops via the existing
      `place_clips_on_beats` → `synth_montage_ops` → `assemble_patch`/`verify` tail. Model
      decides; the tool guarantees `cuts ⊆ beats`. Not a flow handler.
- [x] **W4.3** ~~Python registry parity~~ — **deliberately not mirrored.** The montage
      tool is pure arithmetic over a grid the caller already has; the engine has no route for
      it and nothing to add. The Python registry mirrors tools the _sidecar_ serves.
- [x] **W4.4** Tests incl. the beat-alignment invariant on a stills project.

### W5 — Tool + thought UI/UX (compact activity feed)

- [x] **W5.1** Tool rows: drop the card chrome for a compact row (icon, title, muted
      secondary), on a rail.
- [x] **W5.2** Collapsed state shows a dimmed 2-line output peek.
- [x] **W5.3** Expanded state shows the full detail.
- [x] **W5.4** Thought block: "Thought for Ns" collapsed → activity list expanded — this
      already existed and already matched the target (`Reasoning`: auto-expands live,
      auto-collapses to "Thought for Ns" on settle, stops fighting a manual toggle). Left
      alone rather than rewritten for the sake of touching it.
- [x] **W5.5** Off-cases preserved, no functionality removed: running/failed/cancelled/
      gated/no-result, plus the details modal + copy affordances.
- [x] **W5.6** Tests: existing EventNode/AiSidebar suites stay green; new states covered.

## Outcome (2026-07-15)

All five workstreams landed on `fix/agent-orchestration-core`, one commit each:

| #   | What                                               | Commit    |
| --- | -------------------------------------------------- | --------- |
| —   | `load_skill` delivered whole + pinned per run      | `11a4cda` |
| W1  | A still is its own frame                           | `8dfd0cc` |
| W1  | Never claim sight the model does not have          | `496f9b1` |
| W3  | Reconnaissance ≠ spinning; plan-aware budget       | `4616eea` |
| W2  | The model asks the editor its own questions        | `3b9ab5c` |
| W4  | A usable beat grid + a tool to cut on it           | `797a646` |
| W5  | Compact tool rows on a rail; the question in place | `276ed27` |

Three defects turned out to be **one defect wearing three hats**: a result the
model needed was silently sliced to fit a character budget — the skill playbook
(34%), the beat grid (33 of 366 beats), and the vision protocol (paths where
pixels were promised). Each looked like a different failure; each ended the same
way, with the model asked to act on something it had never received. The rule
that came out of it, now enforced by tests in all three places: **bound by whole
records with an explicit tail, never by a blind character cut** — and never claim
a capability the current provider does not have (ADR 0055, ADR 0059).

**Verified:** `pnpm test` 3229, `pnpm typecheck`, `pnpm lint` green; engine 957;
ai-sdk at 100% statements/branches/functions/lines package-wide. ADR 0059 added,
ADR 0057 amended, CHANGELOG updated.

**Not done, and honestly so:** ~~the montage tool is unproven against a real model
(scripted-provider tests only) — the next desktop run of the Champadevi prompt is
the real evidence, and it is worth recording here.~~ **Superseded (2026-07-15):**
moot — the montage tool (W4) was removed entirely by product decision before that
real-model run happened; see the note at the top of W4. In-app multimodal remains
deferred (ASK-gated provider work, B4.2); until it lands `extract_frames`/
`commit_vision` stay unadvertised to text-only models by design, and `ask_user`
is the model's route around that gap.

## Definition of done

`pnpm verify` green (typecheck, lint, test, engine suites); 100% coverage on the
deterministic modules touched; ADR(s) + CHANGELOG + this doc updated; a real desktop
re-run of the Champadevi beat-sync prompt lands actual edits (evidence recorded here).

**Superseded (2026-07-15):** the beat-sync-montage-specific half of this DoD
(the Champadevi re-run as evidence for the montage tool) no longer applies — the
montage tool it was meant to validate was removed entirely by product decision
(see W4's note above). The rest of this DoD (`pnpm verify`, coverage, ADR/CHANGELOG/
doc hygiene) still stands and was met at the 2026-07-15 outcome above.
