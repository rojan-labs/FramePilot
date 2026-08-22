# FramePilot Run Gap Analysis — Run 2 (`e6d5ba92`)

**Run:** `e6d5ba92-00a9-4993-bb56-13aecc33d4e4` · project `project_skating_vlog` · model `claude-opus-5` · mode `agent`
**Window:** 2026-08-22T07:52:41Z → 08:09:00Z · 714 events · 2 user turns · **final status `completed`**
**Cost:** 226,450 tokens · **$2.43** · 16 model calls in turn 1 alone
**Code under test:** this run executed **after** the previous analysis's fixes landed (proof in §1), so it is a clean re-test as well as a new investigation.

The previous report covered run `cce4755e`; that close-out is preserved in git history, `plan/PLAN.md` and ADRs 0135/0136. This file is the new run.

---

## Close-out status (2026-08-22, same day)

Nine of the eleven findings are fixed with tests; two are deferred with the reasoning stated.
Decisions are in **ADR 0137** (the authority split) alongside 0135/0136 from the previous pass.

| ID | Status | Where |
|---|---|---|
| GAP-201 | **Fixed** — `reframe_coverage` fails a cut where some shots are reframed and the rest are not, naming them; a portrait frame with no reframing at all warns | `critic.ts` |
| GAP-202 | **Fixed** — "every/per/across clip" + a treatment is read as a criterion; `treatment_coverage` fails naming the shortfall | `acceptance.ts`, `critic.ts` |
| GAP-203 | **Fixed (labelled, not yet enforced)** — every signal carries `from: supplied \| measured here`, so a chapter the run never read is no longer echoed back as a citation. Reading signals from the evidence store by handle is ADR 0137's stated next step | `proposers/edit-signals.ts` |
| GAP-204 | **Fixed** — the seven rules and their scores are gone; `read_edit_signals` reports measurements in time order and the agent chooses the move | ADR 0137 |
| GAP-205 | **Fixed** — the grid snaps near-misses, reports a far miss, and refuses one only when the run declared `hardSync` on `detect_beats` | `kernel/beat-grid/beat-alignment.ts` |
| GAP-206 | **Fixed** — `get_clips` rows carry `cropped` and `graded` | `domain-tools/timeline.ts` |
| GAP-207 | **Fixed** — `agentTools` applies the `implicitOnly` filter, plus the scope test that was missing | `orchestrator.ts`, `tool-scope.test.ts` |
| GAP-208 | **Fixed** — the browser session reads visual status, cached footage map and session digest, fail-soft, with the composition unit-tested | `editor/projectUnderstanding.ts`, `editor/ai.ts` |
| GAP-209 | **Fixed** — a request for a rendered file is recorded as a criterion and the report points at Export | `acceptance.ts`, `orchestrator.ts` |
| GAP-210 | **Deferred** — the revision gap needs host plumbing on both surfaces (browser + desktop) to avoid re-creating the parity split GAP-208 just closed, for a Medium finding whose main consequence — stale crops going unnoticed — the new coverage checks now catch | — |
| GAP-211 | **Deferred** — still unresolved whether the editor's timeline labels lanes the way the agent's cards do; a shared label helper is the fix if they disagree | — |

**A note on what is NOT claimed.** GAP-203 is labelled rather than enforced: `read_edit_signals`
still takes its signals as arguments, so `from: 'supplied'` is an honest label, not a guarantee
that a citation was earned. A model determined to assert a chapter it never read can still do
so; what it can no longer do is have the runtime dress that assertion up as evidence.

---

## 0. What the editor asked for, and what arrived

The brief was unusually explicit — twelve numbered requirements, one flagged as a repeat failure:

> **Vertical Reframe (critical — this was wrong last time)** … Do not letterbox or pillarbox — no black bars, no shrunk/floating clip in the middle of the frame. Every clip must be reframed to fill the full 1080×1920 vertical canvas … plus a **subtle dynamic zoom/pan (Ken Burns style) per clip** … Each clip's crop should be chosen individually.

Measured against the delivered timeline (47 clips, 30.000s, read from the run's own final `get_clips`):

| Brief requirement | Delivered | Evidence |
|---|---|---|
| ≥50 distinct moments | **met** (54 placed, 47 survive) | 54 `add_clip` ops |
| 30s, 0.4–1.2s average with occasional 1.5–2s holds | **met** (30.000s, mean 0.638s, range 0.4–2.206s) | final clip list |
| Mixed transitions, not repeated back to back | **met, minimally** (5: whip-pan, dissolve, whip-pan, dissolve, dissolve) | 5 `add_transition` ops |
| **Every clip reframed to fill 1080×1920** | **NOT met** — 18 crop ops over **14 distinct clips**; at most 9 of 47 final clips carry a crop, and the sampled `clip__…_0` provably carries none | 18 `set_clip_crop` ops; `get_clip` payload |
| **Per-clip Ken Burns zoom/pan** | **NOT met** — **1** clip | 1 `add_keyframes` op; all 47 final clips report `keyframeCount: 0` |
| Light grade across clips for consistency | **NOT met** — **1** clip | 1 `apply_color_grade` op, on `clip__…_0` |
| Speed ramp on 2–3 strong moments | **NOT met** — none | no `set_clip_speed` op |
| **One final rendered 30s vertical MP4** | **NOT met, and never mentioned** | no `render_preview` / `export_video` call |

The run reported `Deterministic self-check: All checks passed`, `**Applied 70 edits**`, and terminal status **completed**.

Every craft treatment that did land — the grade, the keyframes, the first crops — landed on **`clip__…_0` and the opening few clips**. The run polished the first two seconds and stopped, and nothing in the runtime noticed.

---

## 1. Previous fixes: confirmed live

Stated first because it changes how the rest of this report should be read — these are not hypotheses, they are visible in this transcript.

| Fix | Live evidence in this run |
|---|---|
| Acceptance criteria read from the request (ADR 0136) | Run state, turn 1: `"provisional": false`, `criterion_1: "The finished sequence runs about 30s."`, `criterion_2: "The cut uses at least 50 distinct shots."` — both **passed** at revision 104 |
| `shot_count` Critic check | The 50-shot condition was actually checked, not assumed |
| "Deterministic self-check" wording | `ℹ️ Deterministic self-check: All checks passed.` — no longer implies the perceptual review passed too |
| Skip line carries only the rejection reason | `**Skipped:** 7 proposed changes did not validate (rejected by the beat grid: … Off-grid: 2.330 …)` — no read-tool JSON, where the previous run pasted a media-bin dump |
| Empty `detect_scenes` carries its own reading | The payload delivered: *"No hard cut was detected anywhere in this asset … Scene detection therefore tells you nothing about WHERE the interesting moments are. Ground any selection in content evidence — map_footage / describe_footage / search_visual …"* |
| Unevidenced-montage caveat | Fired **twice**, correctly: *"Heads up: these 50 shots were chosen from timings alone — nothing was read about what is actually in the footage."* The editor's next message was *"dont choose the clips according to timing / choose from footage map"* — the caveat surfaced the exact defect the editor then complained about |

**Likely, needs verification:** the perceptual review produced **no findings at all** this run, on a cut carrying 5 transitions. In the previous run the identical situation produced `Unexpected black frame(s)` at every one of seven cuts. There is also no `Review could not run` warning, which is what an unavailable reviewer emits. The consistent reading is that reviews ran and came back clean — i.e. ADR 0135's transition under-layer is working in production — but a clean review emits no events, so the transcript cannot distinguish "ran clean" from "was never wired on this surface". Verify from the run's lifecycle records, or by reintroducing a black ramp and confirming the finding returns.

---

## GAP-201: The brief's critical requirement went undelivered, and no check can see it

**Status:** Confirmed gap · **Severity:** Critical

**Run evidence**
The editor flagged reframing as the repeat failure (*"critical — this was wrong last time"*). The agent narrated it as done, twice:

> *"Reframing the sequence now — every clip gets its own 9:16 crop window out of the horizontal frame so the picture fills the full 1080×1920 canvas with no bars"*
> *"Reframing every shot to fill the vertical canvas — a 9:16 window carved out of the 16:9 source, no bars, positioned per shot"*

It applied 18 `set_clip_crop` ops across **14 distinct clips** (4 were re-crops of one clip), then completed. The final timeline has 47 clips. Joining the cropped ids against the final list leaves at most 9 — and that is an over-count, because 6 `delete_range` ops cleared 0–5.2s and the re-added clips inherit the same derived ids without the crop. `get_clip` on `clip__layer_video_1_asset_raw_skating_0` returns no `crop` field at all.

**Code evidence**
* `packages/ai-sdk/src/critic.ts` — `CheckId` is `request_match | duration_target | shot_count | caption_alignment | safe_area | audio_clipping | black_frames | temporal_evidence | vision_review | missing_assets | export_settings`. **There is no check that a picture clip fills the target frame.**
* `engine/python/framepilot_engine/render/compiler.py` — `_place_video_clip` fits a clip's picture inside the canvas (`min(target_w/clip_w, target_h/clip_h)`). A 16:9 clip with no crop in a 9:16 sequence therefore renders with black bars top and bottom, by design, in the export and (since ADR 0135) identically in the monitor.

**Gap**
Letterboxing is the most common short-form delivery defect, it is a pure geometry property of the timeline against the sequence resolution — no pixels, no model, no render needed — and nothing checks it. The Critic will fail a run for being 3 seconds off a duration target while passing one that ships black bars on 38 of 47 shots.

**Impact**
The editor's single most emphasised requirement failed twice in a row and the run called itself successful both times. It is also why the previous run's agent thrashed: with no check to satisfy and no way to observe crop state (GAP-206), "did the reframe land?" is unanswerable from inside the run.

**Recommended fix**
Add an `aspect_fill` check to `critic.ts`: for every picture clip, compute the effective source aspect after `crop` and compare it against the sequence aspect within a tolerance; report the count and the first few offending clip ids. Fail when any picture clip would letterbox in a sequence whose aspect differs from its source's — that is never what a vertical delivery wants. Expose the same predicate as a read (GAP-206) so the agent can fix its own work.

**Tests needed**
* A 16:9 clip with no crop in a 9:16 sequence fails `aspect_fill`; the same clip with a full-height 9:16 crop passes.
* A 16:9 clip in a 16:9 sequence passes untouched (no false positive on same-aspect projects).
* A deliberately letterboxed clip (crop aspect ≠ sequence aspect) fails, and the message names the clip.
* Mixed timeline: the check reports 38-of-47 rather than a bare boolean.

---

## GAP-202: "Every clip" is satisfied by one clip — coverage is never measured

**Status:** Confirmed gap · **Severity:** Critical

**Run evidence**
Against a brief demanding per-clip treatment: `apply_color_grade` **1**, `add_keyframes` **1**, `set_clip_crop` 18 ops over 14 clips — out of 47–54 clips. The grade and the keyframes landed on the same clip, `clip__…_0`. Every final clip reports `keyframeCount: 0`. The run then passed its self-check and completed.

**Code evidence**
* `packages/ai-sdk/src/acceptance.ts` reads exactly two conditions: a duration and a minimum shot count. Both are **counts of the whole**, so both were satisfied.
* `packages/ai-sdk/src/kernel/conductor.ts#onVerifyResult` — completion requires `r.ok && planReconciled && deliveredWork`, where `deliveredWork` is "at least one operation succeeded".
* Nothing derives a per-clip coverage expectation from a request, and no check compares "clips treated" against "clips present".

**Gap**
The completion gate asks *did anything happen* and *are the two headline numbers right*. A brief dominated by "every clip", "per clip", "across clips" is structurally invisible to it. The agent's front-loading behaviour — polish the opening, then move on — is exactly the failure that gate cannot see.

**Impact**
The most common shape of a real editing request ("do X to all of it") cannot be verified, so the success signal is uninformative for precisely the briefs users write. With GAP-201 the editor receives a "completed" run whose deliverable is a letterboxed, ungraded, static cut.

**Recommended fix**
1. **Coverage as an acceptance condition.** Extend `acceptance.ts` to read "every/each/all clip" plus a treatment noun (crop/reframe, grade, zoom/pan/motion, speed) into a `coverage` criterion, and add a Critic check that counts clips carrying that treatment. Keep extraction conservative, like the duration and shot-count readers.
2. **A coverage line in the completion report** whenever a treatment landed on fewer than half the picture clips — *"the grade is on 1 of 47 clips"* — in the same spirit as the unevidenced-montage caveat, and honest even when no criterion parsed.

**Tests needed**
* "grade every clip" over a 10-clip timeline with 1 graded clip ⇒ criterion recorded, check fails, report names 1/10.
* "grade the opening" ⇒ no coverage criterion (no false positive).
* All 10 treated ⇒ passes.

---

## GAP-203: `propose_edits` manufactures provenance from whatever the model types

**Status:** Confirmed gap · **Severity:** High

**Run evidence**
In turn 3 — *after* the editor said "choose from footage map" — the agent called `propose_edits` with model-authored arguments:

```
chapters: [{"t0":0,"t1":18,"title"…, highlights: [{"t0":0,"t1":18,"label"…, verticalTarget…
```

and received back candidates that read as evidence:

```json
{ "kind": "punch_in", "t0": 113, "t1": 123,
  "why": "salient highlight — a push-in makes it land",
  "cite": "highlight \"Snowboarder Falls\" 113.0–123.0s", "score": 1.45 }
```

It then told the editor: *"Rebuilding the shot selection around the actual moments in the run — the gear-up banter, the drop-in, the fall, the break, and the final descent."*

**`map_footage` was never called in this run.** Nor `describe_footage`, `search_visual`, or `get_frame` — 119 tool calls, none of them content evidence. No manifest in the run's 62 context assemblies carries a footage-map block (GAP-208). The chapter titles the editor was shown came from the model's own arguments, round-tripped through a deterministic tool that stamped `cite:` on them.

**Code evidence**
* `packages/ai-sdk/src/domain-tools/timeline.ts:178` — `propose_edits`, described to the model as *"Turn footage understanding into GROUNDED, citable edit candidates … Deterministic — every candidate is real"*.
* `proposeEditsSchema` (same file) takes `chapters`, `highlights`, `silences`, `sceneCuts`, `verticalTarget` **as inputs from the model**, all optional.
* `packages/ai-sdk/src/proposers/candidate-proposer.ts:167` — ``cite: `highlight "${h.label}" ${h.t0.toFixed(1)}–${h.t1.toFixed(1)}s` ``. The citation is a re-render of the argument.
* The module header states a contract it cannot keep: *"the model chooses taste while the proposer guarantees each option is real and citable"*. It guarantees the option is **well-formed**, never that it is real.

**Gap**
The one tool whose entire purpose is grounding accepts ungrounded input and returns it in the vocabulary of evidence. A hallucinated chapter list becomes a scored, cited candidate list, which becomes user-facing narration about what is in the footage.

**Impact**
Worse than no grounding: it *simulates* grounding — for the model (which now has "cited" candidates to plan from), for the editor (told about "the gear-up banter"), and for anyone later reading the run record. It also undercuts the unevidenced-montage caveat, which fired correctly while the narration beside it confidently contradicted it.

**Recommended fix**
Make grounding structural rather than nominal. `propose_edits` should not take chapters/highlights as arguments: it should read them from the run's evidence store — where a real `map_footage` result is recorded — by handle, and refuse honestly (naming what to call) when the run holds none. If the argument form must stay for other callers, every candidate's `cite` must carry the evidence id it came from, and a candidate without one must say so in words both the model and the editor see (`"cite": "unverified — supplied by the model, not read from the footage"`).

**Tests needed**
* Model-supplied chapters with no matching evidence ⇒ refusal, or candidates explicitly marked unverified; never a bare `cite:`.
* With a recorded `map_footage` result ⇒ candidates cite its evidence handle.
* An eval over the transcript catching narration of chapter titles the run never read (this run would fail it).

---

## GAP-204: The runtime owns editorial taste through hardcoded rules — the design objection, made concrete

**Status:** Confirmed gap (architecture) · **Severity:** High

**Run evidence**
`propose_edits` returned five `punch_in` candidates whose entire rationale is the constant string *"salient highlight — a push-in makes it land"*, scored 1.45, 1.40, 1.35, 1.30, 1.30, then `reframe` candidates reading *"vertical target — center the subject on this highlight"* at 1.25 and 1.20. The agent's editorial choice was reduced to picking from a ranked list whose ordering was decided by arithmetic in the runtime.

**Code evidence** — `packages/ai-sdk/src/proposers/candidate-proposer.ts#proposeCandidates`, seven hardcoded rules:

| Rule | Trigger | Emitted move | Score |
|---|---|---|---|
| 1 | `silence.duration ≥ MIN_DEAD_AIR_SEC` | `cut` | `min(1, dur/5) + 1` |
| 2 | every highlight | `punch_in` | `(h.score ?? 0.5) + 0.5` |
| 3 | chapter title matches `REVEAL_WORDS` regex | `punch_in` | `0.7` |
| 4 | transcript emphasis word | `punch_in` | `0.6` |
| 5 | long chapter with no highlight | `speed` ramp | `0.5` |
| 6 | long chapter matching `NARRATION_WORDS` | `broll` | `0.4` |
| 7 | `verticalTarget` set | `reframe` on every highlight | `(h.score ?? 0.5) + 0.3` |

The same shape appears at the validation end in `packages/ai-sdk/src/kernel/beat-grid/beat-alignment.ts`: *every* interior picture cut in a beat-backed montage **must** land within 0.08s of a detected onset or the whole turn is rejected (GAP-205).

**Gap**
Editorial judgement — which move suits which moment, and how strongly — is encoded as regexes over chapter titles and hand-tuned constants. That is the "if/else path" objection, and it is accurate. Note the direction of the inversion: the **model** supplies the perception (it types the chapters), the **code** supplies the taste (which move, how good). That is backwards from the stated architecture, where the runtime guarantees mechanical correctness and the model decides craft.

**Impact**
A ceiling and a floor at once. The ceiling: no rule produces a choice its author did not anticipate, so "a push-in on every highlight" is the best this path can ever suggest, however good the model gets. The floor: because the scores look like evidence, a model that defers to them inherits the rules' taste and stops exercising its own — visible here, where the run's editorial output was five identical punch-in rationales.

**Recommended fix — the split that keeps determinism where it belongs**
Do not delete the deterministic layer; **change what it is for.** Three categories, each belonging in exactly one place:

1. **Facts the runtime must supply** (the model cannot compute these and must never guess): onset times, silence ranges, scene cuts, source↔sequence mapping, clip geometry, "this cut is 124ms from the nearest onset". Keep these as tools, and add the measurements the model currently has to infer.
2. **Guarantees the runtime must enforce** (objectively broken regardless of taste): invalid ranges, overlaps, missing assets, a transition on a non-cut, a clip shorter than a frame, a crop outside 0..1, a letterboxed clip in a vertical delivery (GAP-201). Rejections here are correct.
3. **Judgements only the agent may make**: which moment is best, which move suits it, whether 124ms off an onset matters *here*, whether this shot earns a push-in. The runtime's job is to make these cheap, visible and reversible — never to make them.

Concretely: retire `candidate-proposer.ts`'s rules 2–7 as *proposals* and re-expose their inputs as *measurements* — a `describe_moment`-style read returning onset distance, motion energy, silence, scene-change proximity and highlight overlap for a span, with no `kind`, no `why`, no `score`. Keep rule 1's shape as a fact ("3.2s of silence here"), not a `cut` candidate. The model then chooses, and the guarantee layer checks that what it chose is legal — which is what GAP-205 argues the beat grid should have been all along.

**Tests needed**
* The measurement read returns the same numbers the proposer used, with no move/score/`why` fields.
* An eval: identical measurements plus two different briefs produce different editorial choices (the current proposer cannot — its ranking is brief-independent).
* Guarantee-layer tests unchanged and still green: legality is still enforced.

---

## GAP-205: The beat grid overrode the cut rule the brief stated

**Status:** Confirmed gap · **Severity:** High

**Run evidence**
The brief asked for **visual** rhythm — *"Cut points should land on natural rhythmic/visual beats (motion peaks, hits, reaction snaps) so the edit is ready to beat-sync once music is dropped in"* — with no music on the timeline. In turn 3 the editor added *"music sync"*, the agent placed a bed and called `detect_beats` (311 onsets, ~103 BPM), and the grid rejected seven proposed changes:

> `rejected by the beat grid: every interior picture cut in a beat-backed montage must land on a detected onset. Off-grid: 2.330 (nearest detected onset 2.206); 2.330 (nearest detected onset 2.206); 3.500 (nearest detected onset 3.715); 3.500 (nearest detected onset 3.715).`

Misses of **124ms** and **215ms**, against a snap window of 80ms. The agent complied: the delivered timeline opens 2.206s / 1.509s / 1.485s — the onset grid, not the motion peaks the brief asked for, and a 2.2s opening hold in a cut whose stated average was 0.4–1.2s.

**Code evidence**
`packages/ai-sdk/src/kernel/beat-grid/beat-alignment.ts` — `SNAP_WINDOW_SECONDS = 0.08`; anything beyond it is a hard turn-level rejection. The rule engages purely on evidence-gathering (`detect_beats` was called) and knows nothing about what the editor asked for. Its own doc frames this as a guarantee: *"the runtime disposes"*.

**Gap**
A mechanical-accuracy rule is enforcing an editorial policy the editor did not choose and cannot express. "Every interior cut lands on an onset" is one legitimate style among several; the brief named a different one, and the grid has no way to hear that. The previous pass fixed this rule's *ordering* bug (it was vetoing crop-only proposals); this run shows the deeper issue is its *authority*.

**Impact**
The editor's stated rhythm was silently replaced by a quantised one, a turn was spent on rejections, and the brief's pacing spec was violated by the correction. This is not an argument for deleting the rule — ADR 0132 records the real defect it closed (a montage placed uniformly, off every beat, because nothing checked). Both failures are real; the rule is on the wrong side of the GAP-204 split.

**Recommended fix**
Move the grid from category 2 (guarantee) to category 1 (fact) plus a **declared** intent:
* Always report the measurement: each proposed cut's distance to the nearest onset, in the tool result the model already reads. A model told "this cut is 124ms late; the onset is at 2.206" can decide, and usually will.
* Keep snapping near-misses inside the window — mechanical accuracy the model cannot reach by arithmetic, cheap and lossless.
* Reject only when the run has **declared** it is cutting to the grid (the agent's own plan/decision says so, or the editor asked for hard sync). Absent that, an off-grid cut is a reported measurement in the completion account, not a veto.

**Tests needed**
* Off-grid cut with no declared hard-sync intent ⇒ applies, and the report says it is off-grid by N ms.
* Same cut with declared hard sync ⇒ rejected as today, naming the nearest onset.
* Near-miss inside the snap window ⇒ still snapped, in both modes.
* ADR 0132's original defect still surfaces — as a reported measurement rather than silence.

---

## GAP-206: The model cannot see whether a clip is cropped

**Status:** Confirmed gap · **Severity:** Medium (root cause of two runs of reframe thrash)

**Run evidence**
The agent called `get_clips` 12 times and `get_clip` 4 times across 47 clips, and never established which clips carried a crop. Its final `get_clips` rows look like this:

```json
{ "id": "clip__layer_video_1_asset_raw_skating_0", "trackId": "layer_video_1",
  "assetId": "asset_raw_skating", "start": 0, "end": 2.206,
  "sourceStart": 2.5, "sourceEnd": 4.706, "effectCount": 0, "keyframeCount": 0 }
```

**Code evidence**
`packages/ai-sdk/src/domain-tools/timeline.ts:54` — `clipRow` returns id, trackId, assetId, start, end, sourceStart, sourceEnd, optional `speed`, `effectCount`, `keyframeCount`. **`crop` is absent, and unlike effects and keyframes it has no count or flag standing in for it.** `blendMode` and the colour grade are likewise invisible. The deep read (`get_clip`) returns the whole clip and does include `crop` — at one tool call per clip.

**Gap**
Crop is the one clip property with no cheap observability, and it is the property this editor cares most about. Answering "which of my 47 clips still need reframing" costs 47 deep reads, so in practice the agent never asks and reframes blind.

**Impact**
Directly explains both runs' framing behaviour: apply some crops, lose track, re-apply, narrate completion. It also makes GAP-201's fix only half-useful — a check that fails the run does not help much if the agent cannot then find the offending clips cheaply.

**Recommended fix**
Add `cropped: boolean` (or the rect — it is four numbers) plus `graded: boolean` and `blendMode` to `clipRow`, and name them in `get_clips`' description. Better still, add the derived flag the work actually needs: `fillsFrame: boolean`, computed from the crop against the sequence aspect, so "which clips still letterbox" is one call.

**Tests needed**
* `get_clips` exposes crop state; cropped and uncropped clips are distinguishable in one call.
* `fillsFrame` is false for a 16:9 clip with no crop in a 9:16 sequence, true with a full-height 9:16 crop.
* The description names the new fields — a projection nobody knows about is not observability.

---

## GAP-207: `index_media` is offered to the model, against two explicit contracts

**Status:** Confirmed gap · **Severity:** Medium

**Run evidence**
Not exercised in this run (nothing called it), which is what makes it latent rather than visible.

**Code evidence**
* `packages/ai-sdk/src/tool-scope.ts:44` — `IMPLICIT_ONLY_TOOL_NAMES = ['index_media']`, documented as *"Orchestrator-owned lifecycle tools that must never be model-selected"*, filtered in `selectTools`.
* `packages/ai-sdk/src/autonomous-tool-contract.ts:80` — throws `'index_media is implicit lifecycle work and cannot be model-facing.'`
* `packages/ai-sdk/src/orchestrator.ts#agentTools` builds its descriptors with its own predicate and **never applies the `implicitOnly` filter**. Verified against the built package: `agentTools('agent')` returns 78 descriptors **including `index_media`**.

**Gap**
A contract asserted in two places, enforced in one, and violated by the surface that matters most — the interactive agent, the only one with a live editor in front of it.

**Impact**
A model can start a paced, billable indexing job as an ordinary tool call, inside a run whose budget and cancellation semantics assume it cannot. The failure is silent and expensive rather than loud.

**Recommended fix**
Apply the `implicitOnly` predicate inside `agentTools` (one line), and add a test asserting no model-facing scope — `agent`, `question`, `action-recovery`, and each stage — contains any `IMPLICIT_ONLY_TOOL_NAMES` entry. That test is what was missing; the filter existing in one path was mistaken for the contract holding.

**Tests needed**
* `agentTools(scope)` excludes every implicit-only name, for all scopes and stages.
* `selectTools` behaviour unchanged.

---

## GAP-208: No footage understanding reached this run's context, on any of 62 assemblies

**Status:** Confirmed gap · **Severity:** High

**Run evidence**
Every context manifest carries the same four section labels: `system contract`, `conversation` (per turn), `user request`, `tool definitions`. Across 62 assemblies there is **no** `footage map`, `visual index status`, `session context`, `project memory` or `timeline summary` section. The editor asked for the footage map explicitly in turn 3; the agent never called for one and was never handed one.

**Code evidence**
* `apps/desktop/electron/main.ts` wires `visualStatusFor`, `footageMapFor` (`cachedOnly: true`) and — since the previous pass — `sessionContextFor`. Those fill the corresponding tiers in `context-builder.ts`.
* `apps/web-editor/src/editor/ai.ts#BrowserAiSession.run` builds its `ContextInput` from `project`, `projectRevision`, `userPrompt`, `history`, `selection`, `interaction`, `userMemory`, `pinned` — **none of the three understanding tiers**. The browser path has no producer for them at all.
* `packages/ai-sdk/src/context-builder.ts:455-517` renders every tier it is given, so the tiers themselves are not the problem.

**Gap**
Whichever surface ran this session supplied none of the three understanding blocks. On the browser path that is structural — the previous pass's fix reached only the desktop hub, so the two surfaces now differ in what the agent knows about the project. On the desktop path it would mean all three readers returned nothing, which for `visualStatusFor` (which reports "not indexed" as a status) would itself be a defect worth chasing.

**Impact**
The agent had no map, no index status and no project memory, so "choose from footage map" had no map to choose from — and the model filled the hole by inventing chapters (GAP-203). This is the mechanism behind "context awareness is shallow": not a missing capability, a missing hand-off.

**Recommended fix**
Give the browser session the same three readers the desktop hub has, from the sidecar URL it already resolves (`configuredEngineBaseUrl`) — `createVisualStatusDigester`, a `cachedOnly` footage-map digest, `createSessionContextDigester` — each best-effort and fail-soft exactly as on desktop. Then assert parity in a test so the surfaces cannot drift again. When no map exists, the visual-status line must say so in words the model will act on, since that is the only signal that calling `map_footage` is worthwhile.

**Tests needed**
* Browser session with a configured sidecar: the assembled context contains visual-status, footage-map and session-context tiers.
* Browser session with no sidecar: no tiers, no error, run proceeds.
* A parity test over the two sessions' `ContextInput` keys.

---

## GAP-209: A brief whose deliverable is a rendered file completes without one, and without saying so

**Status:** Confirmed gap · **Severity:** High

**Run evidence**
The brief's Deliverable section: *"One final rendered 30s vertical MP4 … silent (music to be added afterward)."* The run made no `render_preview` or `export_video` call, said nothing about rendering, and reported `completed` with *"Applied 70 edits"*. It also placed a 30s music bed in turn 3 — defensible, since that message asked for "music sync", but the original brief asked for a silent deliverable and nothing reconciled the two.

**Code evidence**
`packages/ai-sdk/src/sidecar-executor.ts:1049` — a tool with no sidecar route settles as `failed` with *"is not runnable from the AI panel yet — use the Export dialog."* Render and export have no route. The deliverable is unreachable from the agent **by design** — a reasonable product decision that appears nowhere in the run's account of itself.

**Gap**
The run cannot produce the artefact the brief names, does not attempt it, does not mention it, and its completion criteria do not include it. Two acceptance criteria (duration, shot count) passed, so the verdict was "completed".

**Impact**
The editor is told the job is done and has no file. Every requirement the run cannot satisfy is invisible in its own report — the opposite of the honest-completion work in ADR 0136.

**Recommended fix**
1. **Read the deliverable as a criterion.** Extend `acceptance.ts` to recognise a requested render/export ("rendered MP4", "export", "deliver a file"). It will not be satisfiable from the agent — which is the point: the completion report then says, once and plainly, *"this asks for a rendered file; the AI panel cannot render — use Export"*.
2. **Say it when the model never tried.** A run whose objective names a deliverable and which made no render attempt carries that line whether or not the criterion parsed.

**Tests needed**
* A brief naming a rendered deliverable ⇒ criterion recorded; completion report names the Export route.
* A brief with no deliverable language ⇒ unchanged.
* An attempted `export_video` ⇒ the existing honest refusal, unchanged.

---

## GAP-210: The project moved 44 revisions between turns and the run never knew

**Status:** Confirmed gap · **Severity:** Medium

**Run evidence**
Turn 1 finished at project revision **104**. Turn 3 opened with `baseProjectRevision: 148`. Forty-four revisions — including the disappearance of turn 1's 50-clip build from `layer_video_2` and the appearance of 47 clips on `layer_video_1` — happened outside these runs. The agent read the result as if it were its own work and reported edits against it without noting the change.

**Code evidence**
`packages/ai-sdk/src/kernel/working-state.ts` tracks `baseProjectRevision` / `currentProjectRevision`, and every decision carries `reconsiderIf: "The project revision changes outside this run or verification disproves it."` — a condition recorded but never evaluated. Nothing compares a new run's base revision against the previous run's final revision, and nothing surfaces the delta.

**Gap**
The run's own durable state names the exact hazard and no code checks it. A 44-revision gap is indistinguishable from a clean continuation.

**Impact**
Part of GAP-201's crop loss is explained here: crops applied in turn 1 were on clips that no longer existed by turn 3, with no signal to re-check. More generally, an agent that cannot tell "someone else edited this" keeps reporting on a timeline it does not understand.

**Recommended fix**
On run start, compare the current project revision against the last revision this conversation observed (the run store already persists it). When they differ, state it in the briefing as a fact — *"the project moved 44 revisions since your last turn; your earlier edits may no longer exist"* — and mark revision-dependent facts from prior runs stale rather than carrying them forward.

**Tests needed**
* A run whose base revision exceeds the conversation's last observed revision records the gap as a fact.
* No gap ⇒ no note.
* Stale timeline-dependent facts from a prior run are not presented as current.

---

## GAP-211: Track labels may not match what the editor sees

**Status:** Needs verification · **Severity:** Low

**Run evidence**
Every card read "Video 2" — *"Added clip Video 2 · 0s–2.33s"* — while the arguments show `trackId: "layer_video_1"`. The final timeline has 47 clips on `layer_video_1` and 0 on `layer_video_2`.

**Code evidence**
`packages/ai-sdk/src/names.ts:50` — `projectNames` labels tracks `"${typeLabel(type)} ${n}"` where `n` counts **array position within type**. This project orders `layer_video_2` before `layer_video_1`, so `layer_video_1` becomes "Video 2".

**Gap / what to check**
Only a defect if the editor's timeline labels lanes differently (by id, say). If the UI also labels by array position the two agree and there is nothing to fix. I could not locate the UI's lane-label helper, so this is unresolved.

**Recommended fix (if they disagree)**
Derive one shared label helper from a single source — ideally a real track name field — and use it in both the timeline UI and the agent's cards.

---

## Gap Summary

| ID | Severity | Area | Gap |
|---|---|---|---|
| GAP-201 | Critical | Critic / delivery | The critical reframe requirement went undelivered and no check can see letterboxing |
| GAP-202 | Critical | Acceptance / completion | "Every clip" is satisfied by one clip — coverage is never measured |
| GAP-203 | High | Grounding | `propose_edits` turns model-typed chapters into `cite:`d "grounded" candidates |
| GAP-204 | High | Architecture | Editorial taste lives in seven hardcoded rules with magic scores (the design objection, confirmed) |
| GAP-205 | High | Runtime authority | The beat grid overrode the cut rule the brief stated; 124ms misses were fatal |
| GAP-208 | High | Context | No footage-map / visual-status / session-context tier reached this run at all |
| GAP-209 | High | Deliverable | A brief demanding a rendered MP4 completed with no render and no mention |
| GAP-206 | Medium | Observability | The model cannot see whether a clip is cropped without one deep read per clip |
| GAP-207 | Medium | Tool scope | `index_media` is offered to the model despite two contracts forbidding it |
| GAP-210 | Medium | Run continuity | 44 external revisions between turns, unnoticed and unreported |
| GAP-211 | Low | UX | Track labels may not match the editor's lanes (needs verification) |

## Areas reviewed

- [x] Agent/orchestration · [x] Model/tool calling · [x] Tool scope + contracts · [x] Runtime invariants (beat grid, proposer)
- [x] Acceptance/verification · [x] Critic checks · [x] Context assembly (all 62 manifests) · [x] Grounding path
- [x] Render semantics (crop/fill, transitions) · [x] Persistence/revisions · [x] Reporting/honesty surfaces · [x] Tests around each finding

**No gap found** in: the patch/validation path (all 10 applied patches validated and committed cleanly, 84 operations, no invalid op reached the timeline); the pacing arithmetic (30.000s exactly, 47 clips, mean 0.638s — the brief's spec, met precisely); duration and shot-count acceptance (recorded and correctly checked); rejection-reason presentation (clean); the empty-analysis reading; the unevidenced-montage caveat (fired twice, correctly, and drove the editor's next instruction).

## Biggest risks, in order

1. **GAP-201 + GAP-202** — the delivered edit fails the editor's most emphasised requirement, and the completion gate is structurally unable to notice. Same defect class as last run from a different direction: previously the crops were lost, now they were never applied to most clips.
2. **GAP-203 + GAP-208** — the agent has no footage understanding in context, no tool result to ground in, and one tool that will dress its guesses up as citations. A wiring-and-contract problem, not a model problem.
3. **GAP-204 + GAP-205** — the runtime decides taste and then enforces it. Fixing the ordering bug last pass did not touch the authority question, which is what distorted this run's rhythm.
4. **GAP-209** — a run can report success without producing the artefact the brief names.

## Recommended fix order

1. **GAP-201** `aspect_fill` check + **GAP-206** crop visibility in `get_clips`. Together they make the flagship defect both detectable and fixable, and they are the smallest changes here.
2. **GAP-202** coverage criteria + a coverage line in the report — turns "every clip" briefs from invisible into checkable.
3. **GAP-207** one-line `implicitOnly` filter in `agentTools`, plus the missing scope test.
4. **GAP-208** browser-side context parity, then **GAP-203** structural grounding for `propose_edits` — the map has to arrive before citing it can mean anything.
5. **GAP-209** deliverable criterion + honest "cannot render here" line.
6. **GAP-205** move the beat grid from veto to measurement + declared intent; then **GAP-204** re-expose the proposer's rules as measurements. Last because they are the largest change and want their own review — see the split in GAP-204.
7. **GAP-210** revision-gap fact; **GAP-211** resolve the label question.

## Proven / likely / needs human verification

**Proven** (transcript and code both read): GAP-201 (18 crops over 14 clips, 47 final, `get_clip` shows no crop, no `aspect_fill` check exists), GAP-202 (1 grade, 1 keyframe set, all final clips `keyframeCount: 0`), GAP-203 (`propose_edits` schema takes the chapters; `cite` re-renders them; zero content-evidence calls in 119), GAP-204 (the seven rules are in the file), GAP-205 (the rejection text, the snap window, the delivered onset-aligned durations), GAP-206 (`clipRow` omits crop), GAP-207 (measured against the built package: `index_media` is in `agentTools('agent')`), GAP-208 (62 manifests, four section labels), GAP-209 (no render call; no sidecar route), GAP-210 (revision 104 → 148).

**Likely:** the perceptual review ran clean this session, which would confirm ADR 0135's transition fix in production — five transitions, no black-frame findings, where the previous run produced them at all seven cuts.

**Needs human verification:**
* Which surface ran this session (browser vs desktop), which decides whether GAP-208 is "browser has no producers" or "desktop readers returned nothing".
* Whether reviews ran at all (see above) — check the run's lifecycle records.
* Open the delivered project at revision 152 and count clips carrying a `crop`: the ≤9-of-47 figure is derived from operation ids and one sampled clip, not from the file.
* Whether the editor's timeline lanes are labelled the way the agent labelled them (GAP-211).
* What produced the 44 revisions between turns — manual editing, or another session.
