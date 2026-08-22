# FramePilot Run Transcript Gap Analysis

**Run:** `cce4755e-adc4-417c-b553-8cdd49011fe5` · project `project_skating_vlog` · model `claude-opus-5` · mode `agent`
**Window:** 2026-08-21T14:18:05Z → 14:46:44Z · 1360 events · 9 turns · **final status `failed`**
**Source:** `run.md` (75,256 lines) · repo at `37647d2` (post `refactor/framepilot-95-runtime-convergence` merge)

---


---

## Close-out status (2026-08-22)

Every finding below has been actioned. Nine were real and are fixed with tests; two were
mis-read by this analysis and are corrected; two are recorded as deliberate non-changes with
the reasoning stated. Commits are on `fix/run-gap-analysis-closeout`; decisions are recorded in
**ADR 0135** (transition under-layer + crop parity) and **ADR 0136** (a run that can be held to
what it was asked).

**Verification.** ai-sdk 3161, engine 2597, web-editor 2429 tests green; ruff, mypy, eslint and
tsc clean; per-package coverage green. `pnpm verify` passes every gate except `test:visual`,
which fails **two AI-sidebar screenshots for reasons unrelated to this work**: the same two fail
on a clean `main` checkout (where in fact seven panels fail), and both diffs show
character-identical text ghosted by ~1px down the panel — a font-metric shift on this machine,
not a content change. None of the copy changed here appears in either snapshot. The snapshots
have been regenerated twice before (`64e4db1`, `b19438c`), which is consistent with
environment-sensitive baselines; regenerating them is a separate call and was not done here.

| ID | Status | Where |
|---|---|---|
| GAP-001 | **Fixed** — transition ramps carry the neighbour's handle (or held edge frame) in the render and both monitors | `render/compiler.py`, `PreviewPlayer.tsx`, `webcodecs-preview-engine.ts`, `preview/held-frame.ts` · ADR 0135 |
| GAP-002 | **Fixed** — relevance decided before groundedness; a proposal with no picture boundary passes untouched | `kernel/beat-grid/beat-alignment.ts` |
| GAP-003 | **Fixed** — crop fills the frame in both monitors; `cropClipPath` deleted with the approximation | `preview/crop-fill.ts` · ADR 0135 |
| GAP-004 | **Fixed** — checkable acceptance read from the request, recorded on the objective, checked by a new `shot_count` check; one failure reason for record and diagnostic | `acceptance.ts`, `critic.ts`, `kernel/conductor.ts` · ADR 0136 |
| GAP-005 | **Fixed** — desktop reads the session digest per run; an answered `ask_user` writes a durable note | `ai-stream.ts`, `main.ts`, `run-controls.ts`, `editor/ai.ts` |
| GAP-006 | **Fixed** — a provider-reported truncation retries once and is never published as the run's last word | `orchestrator.ts`, `providers/langchain-chat.ts`, `providers/types.ts` · ADR 0136 |
| GAP-007 | **Fixed** — an empty step retries in place, then fails honestly | `orchestrator.ts` · ADR 0136 |
| GAP-008 | **Partly fixed, partly corrected** — a montage built with no content evidence now says so in its report; the claimed missing `footageMap` producer **does exist** (see corrections) | `orchestrator.ts` |
| GAP-009 | **Fixed** — a memo hit re-attaches its picture (the key carries the revision, so a hit proves it is current); `withReplayedImageNote` deleted | `orchestrator.ts`, `tool-executor.ts` |
| GAP-010 | **Fixed as documentation + parity, not as one number** — the two gates measure different signals, so both values now live in one table with their reasons and a cross-language parity test | `perceptual-thresholds.ts`, `validation/perceptual_thresholds.py` |
| GAP-011 | **Fixed** — one steering attempt per defect class; completion amended when findings remain; "Deterministic self-check" | `review-findings.ts`, `orchestrator.ts`, `kernel/conductor.ts` · ADR 0136 |
| GAP-012 | **Fixed** — skip lines carry only the rejection reason (the count was already accurate); review steering is no longer echoed verbatim | `orchestrator.ts`, `kernel/conductor.ts` |
| GAP-013 | **Fixed** — an empty scene analysis carries its own reading and points at content evidence | `sidecar-executor.ts` |
| GAP-014 | **Corrected** — the dual tool surface is by design (see corrections); the measured prompt cost is real and left alone as a maintainer scope decision | measured: 78 descriptors ≈ 15,710 tokens/request; `apply` trims to 58 ≈ 12,317 |
| GAP-015 | **Fixed** — every gap above ships with the tests it was missing, and two engine tests that encoded the defect were rewritten | see each commit |

### Corrections to this analysis

Two findings above overstated what was missing. They are corrected rather than quietly dropped:

- **`ContextInput.footageMap` has a producer.** `apps/desktop/electron/main.ts` wires
  `footageMapFor` with `cachedOnly: true` — deliberately, so a cold project gets no map block
  instead of stalling every run on a billable Pegasus round-trip. What was actually missing was
  `sessionContext` (no producer at all — now wired) and any warm map for *that* project. The
  browser build has no sidecar and so no map, which is its documented gap.
- **`autonomous-tools.manifest.json` is not a competing surface.** Its own header states it is
  the smaller public surface for the autonomous orchestrator, MCP projection, UI metadata and
  the generated Python mirror, while the full `TOOL_REGISTRY` remains the interactive catalog.
  The 15.7k-token cost of the interactive surface is confirmed, and stage scoping trims it only
  at `apply` — but that is a deliberate design ("the model decides when it is ready to edit"),
  not drift, and changing it is a scope decision rather than a defect fix.

### What remains open (not fixed, and why)

Stated plainly so the close-out does not overclaim:

- **A cancelled run's working state is still not restorable by a following run.** What is now
  durable is the part that was doing the damage — the editor's answers and decisions, through
  the session digest. A new turn still builds its own plan from the current timeline, which is
  the intended design; resuming a run's ledger remains available only through the checkpoint the
  UI already offers.
- **A rebuild still drops per-clip look.** `delete_range` + `add_clip` over the same span does
  not carry the old clips' crop forward, and no heuristic was added to make it: silently
  mutating a proposal to preserve state the model did not ask for is a worse failure mode than
  the one it fixes. The durable answer ("full-bleed vertical crop") is what now survives to tell
  the next run what to re-apply.
- **Findings still settle after the completion summary is written.** The summary is amended when
  findings remain, but the ordering itself was not changed — draining every review before the
  summary would reintroduce the multi-minute wait the detached reviewer exists to remove.
- **No assertable lint over user-facing event copy.** The two offenders found in this run are
  fixed at their source; a general "no internal ids in any user-facing string" check over the
  event stream is a reasonable follow-up and was not built.
- **No end-to-end golden run in the shape of this transcript** (long uncut take + music →
  vertical 30s). Each defect is covered by a test at its own layer; a fixture-backed whole-run
  golden would need real media and a long scripted provider, and is the natural next step if
  this class of regression recurs.

### Deliberate non-changes

- **No automatic mix limiter** (GAP-010). Clipping is a real defect and the review catches it,
  but inserting automatic gain staging would silently change the mix an editor set. The gates
  now agree in writing about which signal each measures; enforcement stays where it is.
- **No overlap-based transition model** (GAP-001). Making `add_transition` genuinely overlap two
  clips needs the one-clip-per-time-per-track invariant relaxed, a schema migration, and a
  rethink of every adjacency-reasoning operation. The under-layer reproduces the visible
  semantics with no schema change; ADR 0135 records where this ends up if it is ever needed.

---

## 0. Run timeline (established from the transcript)

| Turn | Request | Outcome |
|---|---|---|
| 1 | "best moments … 30s Instagram story, transitions/effects" | 9 clips + 9 crops applied (rev 11→13). `ask_user` blocked **139.9 s** on an aspect-ratio question; editor answered "Full-bleed vertical crop". Ended **cancelled** with `⚠️ Review could not run: Temporal evidence acquisition was cancelled.` |
| 3 | *(no user message — a brand-new run on the same prompt, 17 s later)* | `delete_range 3–30s` then 7 fresh `add_clip`s **with no crop**. Reported `Self-check: All checks passed` + "Applied 8 edits". |
| 4 | "best transitions/effects + Rise_Up, zoom properly, beat synced, retain to the last segment" | 33 edits applied (music, 8 crops, 14 transitions, 3 punch-ins, 3 text overlays, gain). **8 proposals skipped** by the beat grid. Music added ×2 and deleted ×1 inside the same run. Two review findings (audio peak, black frames). |
| 6 | "clips are minimized … extremely many black spaces around" | ~20 k lines of re-reads; three successive framing theories (scale 3.2 → 1.78 → 1.02); 40 edits applied. Review finding (turn 17) black frames **still unresolved**, published 42 ms *after* the run reported `completed`. |
| 8 | "20+ best moments, aggressively beat sync" | `⚠️ The model returned an empty response … Retryable: true` → run **failed**, state discarded. |
| 9 | *(user re-sent the identical prompt)* | 6 model steps, 104 s final think, then a **truncated sentence** — "Rebuilding the 30 seconds as a 23-shot" — no tool call, zero operations. `blockedOn: VERIFICATION_INCONCLUSIVE`, `verifications[0] = { passed: false, detail: "Passed with 1 warning(s)." }`. Timeline unchanged. |

Session cost: `$0.19 → $0.55 → $0.96` in notices plus `$0.231` and `$0.277` on the two failed turns. Zero renders, zero exports, no footage understanding call in 28 minutes.

---

## GAP-001: Every transition renders a black flash, because the ramp runs on the incoming clip with nothing beneath it

**Status:** Confirmed gap
**Severity:** Critical

**Run evidence**
Turn 4 added 7 catalog transitions at the 7 cuts (whip-pan-left ×4, glitch ×2, cross-dissolve, circular wipe). Every subsequent perceptual review reported black frames at exactly those cuts, and only those cuts:

> `edit_range_90: Unexpected black frame(s): 90, 91, 92. edit_range_195: … 195, 196, 197. edit_range_300: … 300. edit_range_405: … 405. edit_range_525: … 525, 526, 527. edit_range_615: … 615, 616, 617. edit_range_735: … 736, 737.` (review finding, turn 11; repeated at turns 17, 21)

At 30 fps those frame indices are **3.0 s, 6.5 s, 10.0 s, 13.5 s, 17.5 s, 20.5 s, 24.5 s** — the exact cut list of the turn-4 timeline (`Checking the edit timing`, L17597). Seven cuts, seven findings, one to three frames each. Findings 11/17/21 all say `Resolved: false`.

**Code evidence**
* `packages/editor-core/src/transitions.ts:78` `transitionWindow()` — `case 'start': default: return { inSeconds: duration, outSeconds: 0 }`, and `DEFAULT_TRANSITION_ALIGNMENT` is `start`. So the whole ramp sits **after** the cut, on the incoming clip; `applyAddTransition` (`packages/editor-core/src/operations.ts:1459`) writes no `transition_out` effect at all when `outSeconds <= EPSILON`.
* `engine/python/framepilot_engine/render/compiler.py:458` `_apply_catalog_transition()` — for the `"in"` role: `alpha = alpha * revealed`. At `progress ≈ 0`, `revealed ≈ 0`, so the incoming clip is fully transparent.
* `compiler.py:806` composites with `CompositeVideoClip([...], size=target, bg_color=(0, 0, 0))`. The outgoing clip is butt-joined (`clip.end == next.start`) and already inactive at the cut instant, so the only thing under the transparent incoming clip is the black background.
* Geometry transitions behave the same way for a different reason: `whip-pan-left` has `"travel": 0.85` (`render/transition_catalog.json:1658`), so the incoming picture starts 85 % off-canvas over black — hence 3 flagged frames for whips/glitches versus 1 for the opacity/wipe reveals.
* The preview reproduces it: `apps/web-editor/src/preview/engine/webcodecs-preview-engine.ts:748` erases the outgoing half with `destination-out` on a cleared canvas.

**Gap**
FramePilot has no transition *handles* and no clip overlap. A "cross dissolve" dissolves from black, not from the previous shot; a whip pan whips in from black. `transitionEligibility` only checks that a cut exists and clamps the duration — nothing requires the outgoing clip to still be live during the ramp, and nothing extends it into handle material (the source has 575 s of footage available, so handles are physically possible on every cut here). `plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md:426` lists "insufficient transition handles" as an unbuilt Tier-E scenario, which matches.

**Impact**
Every transition the agent (or a human) adds puts a 1–3 frame black flash at the cut, in preview **and** in export. This is the defect that consumed the run: it is what the perceptual review kept reporting, what the steering kept demanding be fixed, and what the agent could never fix because the fault is in the transition model, not the proposal. It also silently makes the product's headline "tasteful transitions" claim false.

**Recommended fix**
Give a transition real handles: on apply, either (a) extend the outgoing clip by `outSeconds`/`durationSeconds` into its source handle and overlap it with the incoming clip on the same track, or (b) default alignment to `centre` and require the operation to consume handle material from both sides, failing eligibility honestly when a clip has no handle left. The renderer then has a live layer beneath the reveal and `alpha * revealed` composites against picture instead of `bg_color`.

**Tests needed**
* `engine/python/tests/test_render_compiler.py`: a two-clip butt-joined timeline with a cross-dissolve — assert no sampled frame in the ramp has `blackRatio >= 0.98`, and that the ramp's midpoint is a blend of both source colours.
* Same for one geometry transition (`whip-pan-left`) and one wipe.
* `packages/editor-core`: `add_transition` on clips with no handle material must fail eligibility with a named reason; with handles it must produce overlapping spans and invert cleanly.
* Preview parity test asserting the canvas at the ramp midpoint is not the background colour.

---

## GAP-002: The beat grid rejects proposals that contain no picture boundaries at all

**Status:** Confirmed gap
**Severity:** High

**Run evidence**
The turn-4 completion message says `**Skipped:** 8 proposed changes did not validate (… Reframed clip raw_skating.mp4 ×8; rejected by the beat grid: this step cuts to detected beats, but the analyzed audio asset "asset_rise_up" is not on the timeline and this proposal does not place it …)`. The rejected step was **eight `set_clip_crop` calls** (L11621–11691) — the vertical reframe the editor had explicitly asked for. The same `failureReason` is carried in 20+ subsequent run-state snapshots. The model then started deleting and re-adding the music inside single runs (`Delete clip Rise_Up.mp3` L18349, `Adding a clip Audio 1` L20158, narration "I'll put the music back under the cut") to satisfy a gate whose message tells it to "place the music on an audio track in this same proposal".

**Code evidence**
`packages/ai-sdk/src/kernel/beat-grid/beat-alignment.ts:268` `alignBeatBackedBoundaries()`:

```ts
const resolved = resolveGrid(projectGrid, rawBeats, operations);
if ('error' in resolved) return { ok: false, error: resolved.error };   // ← fires first
const grid = resolved.grid;
if (grid.length === 0) return { ok: true, operations, snapped: 0 };
const boundaries = structuralBoundaries(project, operations);
if (boundaries.length === 0) return { ok: true, operations, snapped: 0 };  // ← never reached
```

`resolveGrid` returns the ungrounded error before anyone asks whether the proposal has a single governed boundary. `structuralBoundaries` only ever looks at `add_clip` / `trim_clip` / `split_clip` on picture tracks — `set_clip_crop`, `punch_in` keyframes, `add_transition`, text overlays and gain contribute nothing. Gate call site: `packages/ai-sdk/src/orchestrator.ts:3197`, which rejects the **whole turn**.

**Gap**
Once a run has called `detect_beats`, *any* proposal is rejected wholesale while the analyzed asset is off the timeline — including proposals with zero cuts to check. The gate is a turn-level veto over work it has no opinion about.

**Impact**
The user's central request across turns 4–6 (fix the vertical framing) was blocked by a music-alignment rule. It also teaches the model to churn the music bed (delete + re-place) on every step, which is how the run ended up with the audio track being added twice and deleted once inside one turn, and why the peak-level finding appeared at all.

**Recommended fix**
Compute `structuralBoundaries` first; if it is empty, return `{ ok: true }` before touching `resolveGrid`. Keep the ungrounded rejection only for proposals that actually declare picture boundaries. Optionally scope the veto to the offending operations rather than the turn.

**Tests needed**
* `beat-alignment.test.ts`: a crop-only proposal, a keyframe-only proposal and a transition-only proposal each pass while `detect_beats` evidence exists and the asset is absent.
* A mixed proposal (crops + off-grid `add_clip`) is still rejected, and the reason names only the cuts.
* Existing test `rejects an ungrounded montage when nothing places the analyzed asset` (L167) must keep passing — it only covers `add_clip`, which is why this shipped.

---

## GAP-003: `crop` is a mask in preview and a zoom-to-fill in the render

**Status:** Confirmed gap
**Severity:** High

**Run evidence**
Turn 6's request is the symptom verbatim: *"the actual clips are minimized and not properly fit to the vertical it looks like they are minimized with extremely many black spaces around."* The agent's own diagnosis — "the crop rectangles are right for 9:16, but the cropped picture is being drawn at its fitted size instead of filling the tall frame" — is a correct description of the **preview**, and it then "fixed" it with compensating scale keyframes: `punch_in fromScale: 3.2 / toScale: 3.42` (L51364-51438), then `1.78/1.84` (L55213-55287), settling on `1.02` (L60267-60341). Meanwhile `get_frame` — which renders through the engine — returned `width: 224, height: 400` (L50950), i.e. a full-bleed 9:16 frame with no letterbox.

**Code evidence**
* Render: `engine/python/framepilot_engine/render/compiler.py:169` `_apply_crop()` genuinely crops the source (`vfx.Crop`), and `_place_video_clip` (`compiler.py:318`) then scales the **cropped** frame by `min(target_w/clip_w, target_h/clip_h)` — for a 0.3164×1.0 crop of 640×360 that is ≈5.33, filling 1080×1920.
* Preview (canvas): `apps/web-editor/src/preview/engine/webcodecs-preview-engine.ts:826` clips to the crop rect and then `drawContain(picture2d, -cw/2, -ch/2, cw, ch)` — the full 16:9 frame letterboxed, with a window cut out of it.
* Preview (DOM): `apps/web-editor/src/components/PreviewPlayer.tsx:740` uses `cropClipPath`, documented at `apps/web-editor/src/editor/selectors-base.ts:1595`: *"This masks the element to the cropped region in place — it does NOT zoom the region to fill the frame the way the engine's actual render does … deferred per plan/PLAN.md H1.2h."*

**Gap**
The known-and-documented deferral is not a neutral approximation: it inverts the render-vs-preview rule in the dangerous direction. What the editor sees (tiny picture floating in black) is strictly worse than what will export, so both the human and the agent are driven to "correct" something that is already correct.

**Impact**
Directly produced the user's complaint and two full turns of thrash. Worse, the compensating `scale` keyframes are real timeline state that the render **also** applies on top of its own fill scale (`_place_video_clip`'s `base_scale * effective_scale(t)`), so a preview-driven fix over-zooms the export. The 3.2× keyframes were proposed and at least partially applied before being superseded — a preview artefact wrote wrong data into the project.

**Recommended fix**
Implement zoom-to-fill crop in both preview paths (scale the cropped rect to cover the frame box, composing with the H4 transform), or — if that stays deferred — make `set_clip_crop` surface an explicit "preview is approximate; the render fills the frame" affordance to both the UI and the agent, and add a runtime guard that refuses/flags a `scale` keyframe whose only justification is compensating for a crop.

**Tests needed**
* Canvas/DOM preview unit test: a 0.3164×1.0 crop on a 16:9 source paints edge-to-edge, no background pixels at the frame edges.
* Parity test comparing preview geometry with `_place_video_clip`'s scale for a cropped clip.
* `engine/python/tests/test_render_compiler.py`: crop + `scale` keyframe > 1 over-zooms (documents the compounding) — assert the intended pixel mapping explicitly.

---

## GAP-004: The run objective is always the raw prompt, so verification is tautological — and its reported detail contradicts its verdict

**Status:** Confirmed gap
**Severity:** High

**Run evidence**
Every run-state snapshot in 28 minutes carries:

```json
"objective": { "request": "<the user's message>", "outcome": "<the same message>", "provisional": true,
  "acceptance": [{ "id": "criterion_1", "description": "<the same message>" }] },
"decisions": [{ "id": "decision_1", "decision": "<the same message>", "evidenceIds": [], "status": "committed" }]
```

`provisional` is `true` in the first snapshot (14:18:07) and still `true` in the last (14:46:44). The final verification reads:

```json
"verifications": [{ "criterion": "can you use at least of 20+ different best moments…", "passed": false, "detail": "Passed with 1 warning(s)." }]
```

**Code evidence**
* `packages/ai-sdk/src/kernel/conductor.ts:884` seeds `setObjective(created, { outcome: objectiveText, acceptance: [{ description: objectiveText }], provisional: true })`, commenting that it "yields to the first real interpretation instead of permanently occupying the slot".
* `grep -rn "setObjective(" packages/ai-sdk/src` returns exactly two hits: the definition (`kernel/working-state.ts:1002`) and that one seed site. **There is no producer of a non-provisional objective anywhere.** The interpret stage has no way to record an interpretation, so the placeholder is permanent.
* `kernel/conductor.ts:1569` `recordVerification(..., detail: !planReconciled ? 'The committed plan still has incomplete deliverables.' : r.summary)` — the `detail` branch ignores the `deliveredWork` case entirely, so a run that failed for "no traceable mutation" is filed with the Critic's `"Passed with 1 warning(s)."` summary next to `passed: false`.

**Gap**
The objective/acceptance/decision/verification ledger is modelled in the schema and enforced by `stageEntryViolation`, but nothing populates it with anything except the user's literal words. Verification can therefore only ever answer "did any operation succeed", never "did we deliver 20+ moments, 30 s, beat-synced". `objective.provisional` is dead state.

**Impact**
* The Critic cannot check the request's actual acceptance conditions, so a 6-shot montage satisfies "20+ moments" and a black-flashing cut satisfies "make the video nice".
* The user-facing failure is self-contradicting ("passed: false … Passed with 1 warning(s)"), which is exactly the kind of incoherence the goal document calls out.
* `decision_1` with `evidenceIds: []` means no editorial decision in the whole run is traceable to evidence, defeating the determinism story the roadmap claims.

**Recommended fix**
Add the missing interpret-stage producer: a first-turn effect (or a required tool) that records `outcome` + decomposed, checkable `acceptance` criteria (duration, shot count, aspect, platform, music sync) and clears `provisional`. Feed those criteria to `critic.ts` as the check list. Fix the `detail` branch to name the real reason for each failure mode.

**Tests needed**
* A run whose first turn records an interpretation leaves `provisional: false` and multiple acceptance criteria; a run that never does is refused entry to `plan` (or reported as un-interpreted).
* `onVerifyResult` unit test: `deliveredWork === false` ⇒ `detail` says no traceable mutation, never the Critic summary.
* Critic test: acceptance criterion "≥20 shots" fails on an 8-shot timeline.

---

## GAP-005: A cancelled or failed run is replaced by a fresh run with empty memory, and the replacement can undo the work the user approved

**Status:** Confirmed gap
**Severity:** High

**Run evidence**
Turn 1 (`runId be64b5c0`) applied 9 clips + 9 crops after asking the editor a blocking question and receiving "Full-bleed vertical crop", then ended `cancelled`. Turn 3 appears **17 seconds later with no user message** and a completely fresh state (`runId e9a0855a`, `version: 2`, `facts: []`, `stage: interpret`, `baseProjectRevision: 22`). Its first act was `delete_range 3–30s` (L4882) followed by 7 `add_clip`s carrying **no crop at all** (L5564). The editor's answered question, the 9 applied crops and all 5 recorded facts from turn 1 were gone.

**Code evidence**
`kernel/conductor.ts:866` builds `initialWorkingState(...)` per run and only restores when `ao.resume && ao.resume.ops.length > 0` (`const restored = resuming ? parseWorkingState(ao.resume?.working) : null`). Nothing persists a run's `RunWorkingState` (facts, decisions, `ask_user` answers, applied operations) against the conversation/project for the *next* run, and no invariant carries a per-clip look (crop) across a delete/re-add of the same region. The `ask_user` answer exists only inside the previous run's action log (`orchestrator.ts:380`).

**Gap**
Run-scoped memory is not durable across attempts within one conversation, and there is no continuity rule that a rebuild of a region preserves the reframe/look the user already accepted.

**Impact**
This is the origin of the user's turn-6 complaint: the crops the editor explicitly chose were deleted by the automatic follow-up run, so the picture really was 16:9 inside a 9:16 canvas. It also means every cancellation or provider hiccup pays for the same reconnaissance again (turn 3 spent 45 s + 37 s of thinking re-deriving what turn 1 knew).

**Recommended fix**
Persist `RunWorkingState` per (conversation, project) and restore it for a continuation run at the same or higher project revision; carry answered `ask_user` questions and the accepted look forward as facts. Make `delete_range` + `add_clip` over the same span preserve per-clip crop/transform unless the model asks otherwise (or refuse the rebuild and require `trim`/`move`).

**Tests needed**
* Cancel mid-run, resume: the new run starts with the prior facts, decisions and answered questions, and does not re-ask.
* A rebuild of a cropped span keeps the crop (or the run reports that it dropped it).

---

## GAP-006: A text-only turn silently ends the run, and a truncated sentence becomes the user's last word

**Status:** Confirmed gap
**Severity:** High

**Run evidence**
Turn 9's final model step (after 104.2 s of thinking) emitted `Rebuilding the 30 seconds as a 23-shot` — mid-sentence, no tool call, `Used tokens: 0`, request id `…:assistant:seg-6`. The run immediately went to verify, found no operations, and terminated: `⚠️ This run ended without applying anything — it could not verify that it had done what you asked, so your timeline is unchanged.`

**Code evidence**
`packages/ai-sdk/src/orchestrator.ts:5127`:

```ts
if (turn.calls.length === 0) {
  if (!turn.text.trim()) { /* empty ⇒ ProviderError */ }
  log.push(`Step ${index}: ${turn.text}`);
  yield emit.assistant(segmentId, turn.text);
  return turnBase(index, emit.seq(), { done: true });
}
```

Any non-empty text with no calls is accepted as `done`, regardless of stage. There is no completeness check on the text (a message ending mid-clause is indistinguishable from a finished answer) and no stage-aware guard — the run's own memory at that moment said `stage: analyze`, `remainingObjectives: 1`, `nextAction: "Continue analyze: finish the analysis the plan depends on."`. `ResilientProvider.stream` retries only *before the first chunk* (`providers/resilient-provider.ts:110`), so a mid-stream truncation is not retried either.

**Gap**
"The model stopped talking" is treated as "the model is finished", even when the run has an unsatisfied objective, is not in `verify`/`complete`, and the text is not a complete sentence.

**Impact**
The user's last impression of a 28-minute session is a sentence fragment plus "nothing was applied". Three and a half minutes and $0.28 of analysis in that turn were discarded.

**Recommended fix**
Treat a text-only turn as terminal only when the stage machine says the run may finish (`verify`/`complete`, or objectives satisfied). Otherwise retry the step once with a bounded nudge, and if it recurs, fail with the honest reason instead of publishing the fragment. Detect truncation (no terminal punctuation / provider `finish_reason` other than `stop`) and never surface a truncated segment as the final assistant message.

**Tests needed**
* Text-only turn at `analyze` with pending objectives ⇒ retried, not finalized.
* Truncated stream (finish_reason `length`/dropped) ⇒ retried; on repeat, a failure event, not the partial text.
* Text-only turn at `verify` with objectives satisfied ⇒ still completes normally (no regression).

---

## GAP-007: "Retryable: true" is a label, not a behaviour

**Status:** Confirmed gap
**Severity:** Medium

**Run evidence**
`⚠️ Error 14:42:34 — The model returned an empty response — no answer and no tool call. This is usually the provider dropping the request (overloaded or rate-limited). Retryable: true` → `Run status: failed`. The run had already accumulated 10 facts and 7 model calls ($0.231). Nothing retried; the user re-typed the same prompt 5 seconds later, starting a fresh run with empty memory (see GAP-005).

**Code evidence**
`orchestrator.ts:5115` throws `new ProviderError(detail, 'server')` when `state.cumulativeOps.length === 0`. That throw propagates out of the turn loop and fails the run; `ResilientProvider`'s retry wraps only the provider call itself, and this condition is detected *after* the stream completed successfully (a 200 with no content), so no retry policy ever sees it.

**Gap**
No step-level retry for a dropped/empty step, and no preservation of the run's working state when the throw unwinds — despite the event telling the user the failure is retryable.

**Recommended fix**
Retry the empty step in-loop with backoff (bounded, e.g. 2 attempts) before failing; on final failure, persist the working state so a retry resumes rather than restarts. If the UI's retry affordance exists, make it resume the run id instead of submitting a new user message.

**Tests needed**
* A step whose provider returns empty once is retried and the run continues.
* Two consecutive empties fail the run with the working state persisted and restorable.

---

## GAP-008: Nothing in the loop gives the agent perceptual knowledge of the footage — and it narrated a "footage map" it never had

**Status:** Confirmed gap
**Severity:** High

**Run evidence**
* The bin summary the agent recalled: `duration: 575.9s · resolution: 640x360 · loudness: not analyzed · scenes: not analyzed · silence: 49% silent (203 silent ranges) · transcript: not transcribed`.
* `detect_scenes(threshold 0.4)` → `{ "cuts": [] }`.
* Total footage-understanding calls in 1360 events: **zero**. `grep -n "footage_map\|map_footage\|describe_footage\|search_visual\|twelve" run.md` matches exactly one line — the agent's own narration at L72880: *"the footage map gives chapters, but I need to see what's actually in frame at each source point."*
* On that basis it chose 9, then 7, then 23 source spans (`114–118 s`, `260–264 s`, `505–508.5 s` …) and described them to the user as "the fall", "the gear break", "the ski section", "closing on the final run".
* Its only pixels were three `get_frame` calls (1.5 s, 15.0 s, 18.5 s) — two of which returned "not attached to this turn" (GAP-009).

**Code evidence**
* `packages/ai-sdk/src/domain-tools/media.ts:131-190` registers `search_visual`, `describe_footage`, `map_footage` (available, `capabilities: ['analysis','visual']`), and `index_media`.
* `index_media` is declared orchestrator-owned lifecycle work (`tool-scope.ts:44` `IMPLICIT_ONLY_TOOL_NAMES`, enforced by `autonomous-tool-contract.ts:80` "index_media is implicit lifecycle work and cannot be model-facing") — but **no runtime path invokes it**: the only production callers of indexing are `apps/web-editor/src/components/MediaBin.tsx:908` (`autoIndexImportedAssets`, fire-and-forget at import, gated on an NVIDIA/TwelveLabs key) and `FootageUnderstandingPanel.tsx:555` (a user-driven panel). The agent run neither ensures nor triggers understanding.
* `ContextInput.footageMap` (`context-builder.ts:123`, rendered at :471) has **no producer**: `footageMapDigest` (`apps/web-editor/src/editor/visualIndex.ts:177`) is exported and never called. The "footage map" context tier is dead in the shipped path.
* The registry offers no gate that a content-dependent selection must cite visual evidence; `alignBeatBackedBoundaries` is the only editorial invariant in the runtime.

**Gap**
Rich perceptual understanding exists as tools, routes, schemas and skills, but (a) it is never prepared for the run, (b) it is never placed in context, and (c) nothing requires the agent to use it before claiming "best moments". The agent is structurally limited to metadata + three thumbnails, and it filled the void with confident prose.

**Impact**
This is the "context awareness is shallow" concern, demonstrated: the deliverable's core value ("take the best moments") was produced by guessing timestamps, and the user was told those guesses were grounded in a footage map. That is a fabricated evidence claim reaching the user.

**Recommended fix**
Warm understanding at ingest and *ensure* it at run start (an implicit `ensureMediaUnderstanding` before the first content-dependent stage), feed the resulting digest into context via the existing `footageMap` tier, and add a gate in the same class as the beat grid: a proposal that selects source spans from unindexed footage must either cite `search_visual`/`describe_footage`/`get_frame` evidence per span or be reported as unevidenced (not silently narrated as grounded). Cache per asset so edit-time reads are lookups, not analyses.

**Tests needed**
* A run over an unindexed asset either triggers ensure-understanding or reports honestly; assert the tool call happens.
* Context assembly includes a footage-map section when a digest exists (and a producer exists at all).
* A montage proposal over unindexed footage is flagged/refused; the same proposal with cited evidence passes.
* Prompt/eval regression: the model may not claim a map it did not read.

---

## GAP-009: `get_frame`'s memo tells the model "you already saw it" one turn after the image was stripped from context

**Status:** Confirmed gap
**Severity:** Medium

**Run evidence**
14:33:05 — `get_frame(18.5)` → `"note": "The frame itself is attached to this turn as an image."`
14:33:34, same run (`b1938036`), next step — `get_frame(18.5)` → `"(cached)"` and `"note": "This image was already rendered earlier in this run and shown to you then, so it is NOT attached to this turn — only the facts above are. Answer from what you saw…"`
Immediately after, the agent asserted the black-surround diagnosis and spent two turns acting on it, while the very same tool result reported `width: 224, height: 400` (a full-bleed 9:16 frame).

**Code evidence**
* `packages/ai-sdk/src/tool-executor.ts:100` `withReplayedImageNote()` produces that note for any memo hit.
* `orchestrator.ts:4108-4122` (question route) and the agent route's `pendingFrames` handling attach frames to exactly **one** following request and then rewrite the message to `(Those images were attached to an earlier turn and are no longer shown.)`.

**Gap**
The run memo is per-run while image retention is per-turn. After one turn, the picture is provably absent from context, yet the memo instructs the model to answer from it and states that asking again is futile. The model cannot re-acquire the evidence for that moment for the rest of the run.

**Impact**
Vision-grounded reasoning silently degrades into recollection, then into invention. Here it produced a wrong diagnosis that drove ~20 k transcript lines of thrash and wrote compensating keyframes into the project.

**Recommended fix**
Make the memo image-aware: if the stored image is no longer in the request window, re-attach it (cheap — it is cached) instead of replaying a note; or scope the memo to the window in which the image is still present. Never tell the model to read a picture the assembler has stripped.

**Tests needed**
* Repeat `get_frame` at the same time after the image was stripped ⇒ the image is re-attached (or the note explicitly says the evidence is gone and a re-render is required).
* Assert the note and the actual request content can never disagree.

---

## GAP-010: Two uncoordinated perceptual gates with incompatible thresholds

**Status:** Confirmed gap
**Severity:** Medium

**Run evidence**
Review finding (turn 18): `edit_audio_0: Audio peak 0.08913551514039704 dBFS exceeds -0.1 dBFS.` → steering → the agent applied an unrequested gain change ("Bringing the music bed down so the mix stops clipping"). The black-frame findings (GAP-001) fired on single frames, while the same render would pass export validation.

**Code evidence**
* Temporal review: `packages/ai-sdk/src/temporal-review.ts:842` sets `maxPeakDbfs: -0.1`; `temporal-review.ts:305` fails on any sample with `blackRatio >= 0.98`.
* Export validation: `engine/python/framepilot_engine/validation/render_validation.py:93` `max_audio_dbfs` default **+1.0** ("absorbs codec overshoot"); `max_black_ratio` default **0.95 of the whole render duration**.
* Mix: `render/compiler.py:809` `composite.with_audio(CompositeAudioClip(audio_layers))` — layers are summed with no gain staging, headroom or limiter, so a full-scale music bed plus footage audio clips by construction.

**Gap**
The same two concerns are policed by two gates 1.1 dB and several orders of magnitude apart. The strict one drives model steering; the lenient one decides whether an export ships. And nothing prevents the clipping in the first place.

**Impact**
Steering the model to fix something the export validator considers fine costs turns and produces edits the user did not ask for; conversely a defect the review would catch can ship if the review is skipped. Peaks above 0 dBFS are a real mix defect the runtime should prevent, not litigate.

**Recommended fix**
Single source of truth for perceptual thresholds shared by both gates, with an explicit rationale per threshold. Add automatic gain staging (or a limiter) when placing a music bed under existing audio, so the agent is not asked to hand-tune levels.

**Tests needed**
* One shared threshold table consumed by `temporal-review.ts` and `render_validation.py` (parity test in the existing `test_brain_client_ts_parity.py` style).
* Placing a 0 dBFS music bed under footage audio yields a mix peak below the shared ceiling without model intervention.

---

## GAP-011: Perceptual findings are re-steered without limit, arrive after completion, and never affect the run's verdict

**Status:** Confirmed gap
**Severity:** Medium

**Run evidence**
* The identical black-frame finding was delivered as steering at 14:31:41 and 14:37:09 and re-filed as findings at turns 11, 17 and 21, all `Resolved: false`.
* `ℹ️ Self-check: All checks passed.` at 14:38:45.502 → `Run status: completed` at 14:38:45.504 → `🔍 Review finding (turn 17): … Unexpected black frame(s) …` at 14:38:45.546. The run reported success 42 ms before publishing its own unresolved perceptual failure, which no later turn ever consumed.
* Turn 1: `⚠️ Review could not run: Temporal evidence acquisition was cancelled. Your edits are applied and validated, but were not perceptually checked.` — the edits stayed.

**Code evidence**
* `packages/ai-sdk/src/review-findings.ts:440` `markDelivered()` only appends; resolution requires a *later clean review of an overlapping region* (`resolveDeliveredThroughCleanReview`, :383). There is no attempt counter, no "already tried and failed" signal to the model, and no escalation path for a finding that is structurally unfixable by the agent.
* `orchestrator.ts:4264` `steerFindings()` pushes the same text again whenever the finding is live.
* `kernel/conductor.ts:1499` emits `Self-check: ${r.summary}` from the Critic only; the temporal review's verdict never enters `verificationPassed`.

**Gap**
The review is a detached reader with no bound on repetition, no lifecycle tie to run completion, and no authority over the run's outcome. A defect it can prove is present cannot stop the run from reporting success.

**Impact**
The run burned most of turns 4–6 in a steering loop over GAP-001, then told the user the work was done while its own evidence said otherwise. Conversely, a cancelled review lets unvalidated edits stand with only a warning.

**Recommended fix**
Cap re-delivery per finding (deliver once, then escalate: report to the user as a known defect and stop steering); block `complete` on unresolved *authoritative* findings, or downgrade the completion message to "applied with N open findings"; drain reviews before emitting the completion verdict so a finding can never land after it.

**Tests needed**
* The same finding is steered at most N times; the N+1th escalates instead.
* A run with an unresolved authoritative finding does not report a clean `Self-check`/`completed`.
* Findings settle before the completion event is emitted (ordering test).

---

## GAP-012: Harness internals reach the user as product copy

**Status:** Confirmed gap
**Severity:** Medium

**Run evidence**
Shown verbatim in the transcript UI:
* `ℹ️ Steering applied: "Perceptual review of the edits you already applied found the following. Fix only these, then carry on with the request: 1. edit_audio_0: Audio peak 0.08913551514039704 dBFS exceeds -0.1 dBFS."`
* Finding lineage: `temporal:revision=34, temporal:render-settings=temporal-evidence:540x960@30:captions=true, temporal:decision=fail, temporal:request=representative_0_0, …`
* `**Skipped:** 8 proposed changes did not validate (Recalling what it found → {"assets":[{"id":"asset_raw_skating","path":"media/project_skating_vlog/raw_skating.mp4",…}],"folders":[]}; Reframed clip raw_skating.mp4; … rejected by the beat grid: …)` — a read tool's raw JSON presented to the user as a failed proposed change.
* `⚠️ Review could not run: Temporal evidence acquisition was cancelled.`

**Code evidence**
* `orchestrator.ts:5479` interpolates `args.rejectionReasons.join('; ')` into the user-facing summary, and those reasons are whole-turn notes: `conductor.ts:1315` pushes `r.note`, which `applyAgentTurn` builds as `notes.join('; ')` over **every** tool call in the turn, reads included (`orchestrator.ts:3185` `baseNote`).
* `orchestrator.ts:4264-4271` pushes the internal steering prompt, which the UI renders as a notice.
* `packages/ai-sdk/src/kernel/narration.ts` — the only narration boundary — filters *leading assistant sentences* for run chatter. It does not cover notices, findings, lineage strings or skip reasons.

**Gap**
The narration boundary is one-sided: model prose is sanitised, harness prose is not. Internal identifiers (`edit_audio_0`, `edit_range_300`, `representative_1_449`), subsystem names ("Temporal evidence acquisition"), raw floats and raw tool JSON are user-visible.

**Impact**
Exactly the "reads as broken / breaks the illusion of a professional editing assistant" symptom in the goal document, and the skip line actively misinforms (it names read tools as failed changes and inflates the count).

**Recommended fix**
Route every user-facing string through one presentation layer: derive skip reasons from the *rejection* only (not the turn note), translate findings into editorial language ("a black frame at the 10 s cut"), keep lineage in the details popup, and never surface steering prompts as notices.

**Tests needed**
* Skip line contains only rejection reasons and counts only rejected operations.
* No user-facing event body matches internal id patterns (`edit_(range|audio)_\d+`, `temporal:*`) — an assertable lint over the event stream, in the spirit of `narration-boundary.run.test.ts`.

---

## GAP-013: "0 scene cuts" is recorded as knowledge, with no absence-of-evidence handling

**Status:** Likely gap (behaviour confirmed; ffmpeg's result not independently verified)
**Severity:** Medium

**Run evidence**
`detect_scenes(asset_raw_skating, threshold 0.4)` → `{ "cuts": [] }`, filed as `fact_4 { kind: "footage", statement: "Detecting scene cuts in raw_skating.mp4 → Found 0 scene cuts" }`. On the strength of that, the agent selected 9 spans from 575 s of footage with no other content signal. It re-ran `detect_scenes` in turns 8 and 9 and got the same nothing.

**Code evidence**
`engine/python/framepilot_engine/analysis/scenes.py:54` runs one ffmpeg pass with a fixed `threshold` and returns whatever `showinfo` printed; `run_logs` raises on non-zero exit/timeout, so an empty list means "ffmpeg reported no frame over 0.4" — plausible for a continuous single-take vlog. There is no lower-threshold retry, no fallback to `visual_sampler`/shot-boundary sampling, and the tool result carries no "this means no information" signal. `tool-classification.ts` files it as an ordinary analysis fact.

**Gap**
An analysis that legitimately returns nothing is indistinguishable, to the model and to the fact ledger, from an analysis that confirmed structure. Nothing routes the run to a different evidence source when the cheapest one is silent.

**Impact**
The single most consequential decision in the run (which 30 seconds of 575 to keep) was made with no usable evidence, while the run's memory recorded a satisfied "footage" fact.

**Recommended fix**
Make an empty analysis explicit in the result (`"cuts": [], "interpretation": "no hard cuts detected — continuous take; use visual sampling to find moments"`), and either retry at a lower threshold or hand off to visual sampling/understanding before span selection.

**Tests needed**
* Empty `detect_scenes` result carries the no-information interpretation and is not filed as an established footage fact.
* A run over cut-free footage escalates to a content-evidence path instead of proceeding to span selection.

---

## GAP-014: Every turn rebuilds its understanding from zero, and it shows in the clock

**Status:** Confirmed gap
**Severity:** Medium

**Run evidence**
Thinking blocks: 44.5 s, 43.3 s, 45.2 s, 37.2 s, 104.2 s. Per-turn context manifests are `system contract (135) + 8 thin narration turns (20–85 each) + user request (3013) + tool definitions (15710)` — the tool schemas are 5× the size of everything else combined. Each turn re-ran the same reconnaissance: `get_timeline` 9×, `get_clip` ~20×, `detect_beats` 6×, `find_cuts` 5×, `get_clips` 10×, `load_skill` 6×. Turn 6 alone spans ~33 k transcript lines of reads before its first edit.

**Code evidence**
* `orchestrator.ts:2200` `agentMessages()` builds a stable head + one volatile message per turn; project state reaches the model only inside that volatile block, and the run's cross-turn continuity is the bounded action log plus the briefing. The rich tiers in `context-builder.ts:455-517` (timeline summary, footage map, transcript slice, project memory, visual index status) depend on inputs the app largely does not supply (see GAP-008 for `footageMap`).
* The consolidated 24-tool surface in `autonomous-tools.manifest.json` (`search_media`, `analyze_media`, …) exists and is contract-tested, but the run was offered the legacy per-operation registry — `detect_scenes`, `detect_beats`, `set_clip_crop`, `punch_in` — i.e. 15.7 k tokens of schemas. Two tool surfaces coexist; only the wide one is live.
* The run memo marks repeat reads non-novel, but `kernel/conductor.ts:1327` only counts that as "no progress" for the stall streak — nothing shortens the rediscovery itself.

**Gap**
There is no pre-warmed, cached project understanding at the start of a turn, and the model pays for a maximal tool surface on every request. The convergence work has consolidated the *contract* but not the *live* surface.

**Impact**
The "spends too long thinking and assembling context" symptom, quantified: minutes of latency and most of the token spend went to rediscovery, not editing.

**Recommended fix**
Assemble a warm turn-0 context (timeline digest + bin/analysis state + footage digest + prior decisions) so the first edit needs no reconnaissance; cut the live tool surface to the consolidated manifest so schemas cost a fraction of the prompt; make `session-warmup` responsible for having analysis ready before the run starts.

**Tests needed**
* `time-to-first-edit` regression: first mutating operation within N model steps on a warm project.
* Context assembly asserts the timeline/bin/footage tiers are present in agent mode.
* A parity test that the live agent surface equals the consolidated manifest (or an explicit, documented exception list).

---

## GAP-015: The tests around these paths pass while the behaviour fails

**Status:** Confirmed gap
**Severity:** Medium

**Run evidence / code evidence**
* `packages/ai-sdk/src/kernel/beat-grid/beat-alignment.test.ts:167` covers the ungrounded rejection only for an `add_clip` proposal. No case exercises a crop-only / keyframe-only / transition-only proposal — the case that actually occurred (GAP-002).
* `engine/python/tests/test_render_compiler.py:797` proves a crop shows the right sub-region, and :829 proves crop + transform "renders without error" — neither asserts the composited frame at a **transition boundary** is not black (GAP-001), and nothing asserts preview/render crop parity (GAP-003).
* `grep -rn "setObjective(" packages/ai-sdk/src` shows the objective ledger has one writer, yet the working-state suite exercises `provisional` as if a replacement path exists (GAP-004).
* `review-findings.precision.test.ts` covers supersession/resolution but not repeat-delivery bounds or ordering against run completion (GAP-011).

**Impact**
Four of the highest-severity findings here are in code that is under test — the tests describe the intended contract and skip the shape the runtime actually produces. That is why a heavily-tested kernel still produced a run that applied a black-flashing cut, blocked the requested reframe, and reported success next to its own failure.

**Recommended fix**
Add the specific cases listed under each gap above, and add one end-to-end golden run over the shape of this transcript (uncut long take + music, vertical target) asserting: crops survive a rebuild, a transition boundary is not black, a crop-only proposal applies while beats are known, and the completion verdict agrees with the findings.

---

## Gap Summary

| ID | Severity | Area | Gap |
|---|---|---|---|
| GAP-001 | Critical | Render / editor-core | Start-aligned transitions with no handles composite over black — a 1–3 frame black flash at every cut, in preview and export |
| GAP-002 | High | Agent runtime (beat grid) | Ungrounded-grid rejection fires before boundary collection, so crop/keyframe/transition-only proposals are vetoed |
| GAP-003 | High | Preview vs render | `crop` masks in preview but zooms-to-fill in the render; drove wrong "fix" keyframes into the project |
| GAP-004 | High | Orchestration / verification | Objective + acceptance are always the raw prompt (`provisional` never replaced); verification is tautological and its detail contradicts its verdict |
| GAP-005 | High | Run lifecycle / memory | A cancelled/failed run is replaced by an empty-memory run that deleted the user-approved crops |
| GAP-006 | High | Turn loop | A text-only (and truncated) turn silently ends the run mid-stage and becomes the user's last word |
| GAP-007 | Medium | Reliability | Empty provider response is labelled retryable and never retried; run state discarded |
| GAP-008 | High | Footage understanding | Understanding is never prepared, never in context, never required — "best moments" were guessed and a footage map was narrated that was never read |
| GAP-009 | Medium | Evidence / vision | `get_frame` memo claims "you already saw it" after the image was stripped from context |
| GAP-010 | Medium | Validation policy | Temporal review and export validation disagree on peak (−0.1 vs +1.0 dBFS) and black (1 frame vs 95 % of duration); no mix gain staging |
| GAP-011 | Medium | Review lifecycle | Unbounded re-steering of an unfixable finding; findings land after completion; findings never affect the verdict |
| GAP-012 | Medium | UX / narration boundary | Steering prompts, internal ids, lineage strings and raw tool JSON shown as product copy |
| GAP-013 | Medium | Analysis | Empty `detect_scenes` recorded as knowledge with no fallback |
| GAP-014 | Medium | Context / performance | Per-turn rediscovery, 15.7 k tokens of legacy tool schemas, 40–104 s thinking blocks; two tool surfaces coexist |
| GAP-015 | Medium | Tests | Tests cover the intended contracts and miss the shapes the runtime produces |

## Areas Reviewed

- [x] Agent/orchestration (`kernel/conductor.ts`, `orchestrator.ts`, `kernel/working-state.ts`, `stage-policy.ts`)
- [x] Model/tool calling (`tool-registry.ts`, `tool-scope.ts`, `tool-executor.ts`, `autonomous-tools.manifest.json`, `domain-tools/*`)
- [x] Runtime invariants (`kernel/beat-grid/beat-alignment.ts`, `critic.ts`, `temporal-review.ts`, `review-findings.ts`)
- [x] State management (run working state, run memo, evidence store, image retention)
- [x] IPC/API boundaries (sidecar routes for visual/temporal evidence — routing read, transport not exercised)
- [x] Frontend (`PreviewPlayer.tsx`, `webcodecs-preview-engine.ts`, `selectors-base.ts`, `MediaBin.tsx`)
- [x] Backend/render (`render/compiler.py`, `transition_catalog.json`, `validation/render_validation.py`, `validation/temporal_evidence.py`, `analysis/scenes.py`)
- [x] Persistence (project revisions, idempotency keys, working-state durability)
- [x] Error handling (empty response, cancelled review, rejected turns, provider retry policy)
- [x] Tests (targeted: beat alignment, render compiler crop, review precision)
- [ ] CI (not inspected — out of the run's evidence path)
- [x] Configuration (understanding keys / auto-index gating)
- [x] Types/schemas (objective/acceptance schema vs producers; temporal evidence contract)
- [x] Documentation/rules (`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §5.2, §12.2 corroborate GAP-001/010)

**No gap found:** patch integrity held throughout. Every mutating call was validated against the speculative working copy before the turn assembled (`applyAgentTurn` → `assembleEdit`), operations carry idempotency keys and before/after revisions, revisions advanced monotonically (11→13→…→34), the `ask_user` round trip worked end to end, transition duration clamping behaved as documented, the run memo correctly suppressed repeat reads, and cost/usage accounting was accurate per turn. The reducer never applied an invalid patch, and no timeline corruption is visible in the transcript.

## Biggest Risks

1. **GAP-001** — every transition ships a black flash. It is the defect the run could not escape, and it is user-visible in the final export.
2. **GAP-003 + GAP-005** — the preview lies about crop, and an automatic follow-up run deleted the crops the user had approved. Together they produced the user's actual complaint and wrote wrong keyframes into the project.
3. **GAP-002** — a music-alignment rule vetoes unrelated work, blocking the exact fix the user asked for and teaching the model to churn the audio bed.
4. **GAP-008** — without prepared footage understanding, "best moments" is guesswork narrated as evidence. No amount of orchestration hardening fixes that.
5. **GAP-004 + GAP-011** — the run cannot tell the truth about itself: acceptance is a tautology, the completion verdict ignores perceptual failure, and the failure message contradicts itself.

## Missing Test Coverage

* Non-black composite through a transition ramp (per transition family) — render and preview.
* Crop geometry parity between preview and `_place_video_clip`.
* Beat-grid pass-through for proposals with no picture boundaries.
* Crop/look preservation across `delete_range` + `add_clip` rebuilds of the same span.
* Working-state durability across cancel → continuation, including answered `ask_user` questions.
* Text-only / truncated / empty model turns at a non-terminal stage.
* `get_frame` memo vs image-retention window agreement.
* Shared perceptual thresholds between `temporal-review.ts` and `render_validation.py`.
* Finding re-delivery bounds and finding-vs-completion ordering.
* User-facing event copy lint (no internal ids, no raw tool JSON, rejected-op counts exact).
* An end-to-end golden run shaped like this transcript (long uncut take + music → vertical 30 s).

## Transcript Claims Without Code Evidence

* **"the footage map gives chapters"** (L72880) — no footage-understanding call occurred in the run, and `ContextInput.footageMap` has no producer. Unsupported claim.
* **Editorial labels for chosen spans** ("the fall", "the gear break", "the ski section", "closing on the final run") — no content evidence exists for any of them; three frames were rendered, two of which were not attached to the turn.
* **"Self-check: All checks passed" (turn 6)** — true only of the Critic's deterministic battery; the run's own perceptual review reported unresolved black frames 42 ms later.
* **"Applied 33 edits … Skipped: 8 proposed changes did not validate"** — the 8 were one crop step rejected by the beat grid. **Correction:** the COUNT is accurate (`rejectedOpCount` sums `turnOpCount`, which counts mutating operations, and that step carried eight `set_clip_crop` ops); what was wrong is the reason string, which pastes the whole turn's model-facing note — a read tool's raw JSON included — ahead of the actual reason. Only the reason was fixed.
* **`verifications[0].detail: "Passed with 1 warning(s)"` next to `passed: false`** — the detail describes the Critic, not the actual failure (`deliveredWork === false`).
* **"Retryable: true"** on the empty-response error — nothing retries it.

## Recommended Fix Order

1. **GAP-001** — transition handles/overlap. Highest user-visible severity, self-contained in `editor-core` + `compiler.py`, and it removes the review loop that dominated this run.
2. **GAP-002** — reorder the beat-grid gate (a three-line change) so unrelated work stops being vetoed.
3. **GAP-003** — crop zoom-to-fill in preview (or an explicit approximation contract), so neither the human nor the agent is chasing a preview artefact.
4. **GAP-005** — durable working state across attempts + look preservation on rebuild; this also stops re-paying for reconnaissance.
5. **GAP-006 / GAP-007** — turn-termination and retry honesty; cheap, and they stop losing whole runs.
6. **GAP-004 / GAP-011** — real objective interpretation and acceptance criteria, then let the review's verdict bind the completion report.
7. **GAP-008** — ingest-time understanding + a grounding gate for content-dependent selection (the largest piece; sequence it after the runtime tells the truth, per the goal document's own conflict note).
8. **GAP-009 / GAP-010 / GAP-012 / GAP-013** — evidence-window correctness, one threshold table, presentation boundary, absent-evidence semantics.
9. **GAP-014 / GAP-015** — warm context + single live tool surface, backed by the tests listed above.

## What is proven, likely, and still needs human verification

**Proven from code + transcript together**
GAP-001 (frame indices match the cut list exactly; `outSeconds = 0` and `alpha * revealed` over `bg_color=(0,0,0)`), GAP-002 (ordering in `alignBeatBackedBoundaries`, rejected crop-only step in the log), GAP-003 (both preview paths documented as masks; render scales the cropped frame; `get_frame` returned 224×400), GAP-004 (one `setObjective` producer; `provisional: true` in every snapshot), GAP-005 (fresh run id/empty facts, then `delete_range 3–30` + uncropped re-adds), GAP-006 (`turn.calls.length === 0 && turn.text` ⇒ `done`; truncated final message), GAP-007 (throw with no retry path), GAP-009 (memo note vs one-turn image retention), GAP-010 (both threshold defaults), GAP-011 (repeat steering, post-completion finding, `verificationPassed` excludes the review), GAP-012 (verbatim user-facing strings).

**Likely, reasoned from code with one inference**
GAP-008 — the *absence* of any understanding call is proven; that understanding *would* have been available in this environment depends on whether an NVIDIA/TwelveLabs key was configured. The structural gaps (no runtime ensure, no context producer, no grounding gate) hold either way.
GAP-013 — the handling gap is proven; whether ffmpeg genuinely found no cut in this particular file is not independently verified.
The intermediate 3.2× / 1.78× scale keyframes: the transcript shows them proposed, and turn 6's applied summary counts 24 keyframe operations across three steps, so at least some over-zoom state reached the project transiently. Whether the final project retains only the 1.02 set needs a look at `project.fp.json`.

**Requires human verification**
* Open `media/project_skating_vlog/project.fp.json` at revision 34 and confirm the surviving crop + `scale` keyframe set per clip, and whether the music bed is present.
* Export the current timeline and watch the 7 cuts: confirm the black flashes and confirm whether the picture is correctly framed or over-zoomed.
* Re-run `detect_scenes` on `raw_skating.mp4` manually at thresholds 0.4 / 0.2 / 0.1 to settle GAP-013.
* Confirm what understanding backend (if any) was configured for this session, to size GAP-008's remediation.
* Confirm whether turn 3 was an automatic continuation or a UI action, to pin the exact entry point for GAP-005.
