# Visual Understanding — the agent knows the footage, the edit, and the screen

> **Sub-plan of [`plan/PLAN.md`](../PLAN.md).** Read `AGENTS.md` and `CLAUDE.md` first.
> **Status:** `[ ]` proposed · **Created:** 2026-09-07 · **Owner:** maintainer · **Branch:** `plan/visual-understanding`
> **Primary target:** the Electron desktop app with the sidecar. Browser-only gaps are deferred; desktop regressions are not.
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

**One sentence:** compile everything the agent needs to know about every asset into a
per-shot ledger at import time, with no key and no model for the first tier, join that
ledger into the timeline the agent already reads, and let deterministic solvers turn facts
into color, transition and placement decisions, so the language model never has to look at a
frame to edit and never has to guess a number.

## Why this plan exists

Four to five months of orchestration work produced a 34k-line kernel that plans, guards,
budgets and verifies well, and an agent that is blind. Across every golden run recorded
under `reports/golden/`, the model read the timeline JSON 713 times and looked at a frame
13 times. It never called `measure_color`. It edits a spreadsheet of clip ids.

The diagnosis in [`00-DIAGNOSIS.md`](./00-DIAGNOSIS.md) shows this is not a prompt problem
and not a retrieval problem. It is a state-representation problem with one hard gate at the
root: **nothing is ever indexed unless the user has pasted an NVIDIA or TwelveLabs key**
(`apps/web-editor/src/editor/visualIndex.ts:74`, `engine/python/framepilot_engine/service.py`
`/brain/visual/index`). On the default install the visual index is empty, so every surface
built on it (footage map, `search_visual`, `describe_footage`, caption FTS) answers
`not_indexed`, and the clip row the model reads is `c12[0–4.2s]` and nothing else
(`packages/ai-sdk/src/context-builder.ts` `renderTrackClips`).

## The decision, in one table

| Layer                              | What it is                                                                                                                | Where it runs                                               | Cost scales with                    | Status today                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| **Shot ledger, tier 0 (measured)** | scene cuts, per-shot luma/contrast/saturation/white-balance, motion, black/freeze, sharpness, phash                       | ffmpeg, one decode pass per asset, sidecar                  | footage minutes, once               | scenes + phash exist; the rest does not; gated on keys |
| **Tier 1 (embedded)**              | SigLIP image+text vectors, zero-shot labels (shot size, subject kind, setting), person identity clusters, duplicate takes | onnxruntime in a capability pack                            | footage minutes, once               | NVIDIA hosted only, key-gated                          |
| **Tier 2 (described)**             | one structured caption per shot: subject, action, setting, camera, mood, on-screen text                                   | llama.cpp + small VLM in a capability pack; hosted fallback | footage minutes, once, background   | hosted captioner only, key-gated, free text            |
| **Timeline projection**            | every timeline second → the shot it shows → its facts; cut-pair deltas between neighbours                                 | `kernel/semantic-index`, pure TS                            | O(clips shown), per revision        | slices exist; no join to footage facts                 |
| **Model surfaces**                 | clip rows carry facts; `get_clips`, `list_edit_boundaries`, briefing PICTURE line; project digest                         | `context-builder`, `briefing`, tools                        | bounded by the existing clip budget | rows carry id + times only                             |
| **Solvers**                        | `match_color`, `normalize_exposure`, look intents; transition policy from cut-pair deltas; b-roll ranking                 | `editor-core` + engine measurement                          | O(pairs on the timeline)            | model guesses numbers and kinds                        |
| **Sampled verification**           | deterministic `shot_match` on flagged cuts; vision review only where numbers cannot decide                                | existing `temporal-evidence` + `vision-review`              | ≤ 4 cut pairs per apply             | routes exist; no caller                                |

Nothing here changes `project.fp.json`. The ledger is brain data (ADR 0058: derived,
rebuildable, sidecar-written). Color lands as the existing `apply_color_grade` operation;
transitions land as the existing transition effect. No timeline schema migration.

## Non-negotiable rules for this plan

1. **Tier 0 needs no key, no model, no network.** If ffmpeg runs, the ledger exists. This is
   the single change that ends blindness on the default install.
2. **Perception cost is paid per asset, once, keyed by content hash and tier version.** No
   per-turn frame, no per-decision model call. A run reads text.
3. **The language model never emits a number for a grade or picks from fifty transition
   names.** It states intent and a reason; the solver picks values from measurements and
   the tool applies the existing operation.
4. **Pixels are looked at only to verify, only at flagged cuts, only after deterministic
   checks cannot decide.** Never in planning, never by default.
5. **Facts carry provenance and confidence.** `measured` facts are exact; `labelled` and
   `described` facts name their model and score. The briefing renders them differently.
6. **Indexing never blocks an edit.** A run reads what exists plus a coverage fact.
7. **Reuse before build.** Brain tables, paced-slice jobs, `analysis_results`, the semantic
   index, `temporal-evidence`, `vision-review`, capability packs, the transition catalog and
   the color contracts all exist. This plan wires and extends; it does not re-found.

## Files

| File                                                                   | Content                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`00-DIAGNOSIS.md`](./00-DIAGNOSIS.md)                                 | Evidence, hop by hop, with file citations. Why prior plans did not produce results.                    |
| [`01-ARCHITECTURE.md`](./01-ARCHITECTURE.md)                           | The ledger record, brain schema v4, the tier contract, the projection join, token budgets, scale math. |
| [`02-TIER0-SHOT-LEDGER.md`](./02-TIER0-SHOT-LEDGER.md)                 | Phase VU1: one ffmpeg pass per asset, import hook without a key, job priority, status.                 |
| [`03-MODEL-SURFACES.md`](./03-MODEL-SURFACES.md)                       | Phase VU2: clip-row facts, timeline projection slice, cut-pair deltas, briefing, digest, tools.        |
| [`04-SOLVERS-COLOR-TRANSITIONS.md`](./04-SOLVERS-COLOR-TRANSITIONS.md) | Phases VU3–VU4: `match_color`, `normalize_exposure`, look intents, transition policy, b-roll ranking.  |
| [`05-LOCAL-PERCEPTION-PACKS.md`](./05-LOCAL-PERCEPTION-PACKS.md)       | Phases VU5–VU6: SigLIP + SFace pack, llama.cpp VLM pack, structured captions, hosted parity.           |
| [`06-VERIFICATION-AND-EVAL.md`](./06-VERIFICATION-AND-EVAL.md)         | Phase VU0 (baseline first) and VU7: metrics, labelled fixtures, golden cases, sampled vision review.   |
| [`07-SCALE-AND-OPERATIONS.md`](./07-SCALE-AND-OPERATIONS.md)           | Phase VU8: 10-hour libraries, 1000-asset projects, resource governor, resumability, eviction.          |
| [`08-REMOVE-DEFER-RISKS.md`](./08-REMOVE-DEFER-RISKS.md)               | What this plan removes, what it defers, ask-before-acting items, risks.                                |

## Phase order and gates

| Phase | Name                   | Depends on | Exit evidence                                                                                                                                                    |
| ----- | ---------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VU0   | Baseline and contracts | —          | blindness metrics recorded on `main`; labelled fixture set; ledger ADR accepted; ask-list resolved                                                               |
| VU1   | Tier 0 shot ledger     | VU0        | every mission fixture has a ledger with no key configured; per-shot stats within tolerance of the labelled set; import → ledger under 2× real-time on the M1 Pro |
| VU2   | Model surfaces         | VU1        | clip rows carry facts; `frames_seen_per_edit` unchanged or lower; target resolution on the visual golden cases up; token delta measured                          |
| VU3   | Deterministic color    | VU1        | `match_color` closes the measured luma/chroma gap on `mission-montage` to within tolerance and verifies by re-measurement; golden case passes                    |
| VU4   | Transition policy      | VU2        | `add_transition` with a reason picks from the policy table; a continuity cut gets no transition; golden case passes                                              |
| VU5   | Tier 1 local pack      | VU1        | offline `search_visual` works with no key; zero-shot shot-size accuracy on the labelled set; person clusters on `talk-1080p-98s` + `camera-4k60-40s`             |
| VU6   | Tier 2 local VLM pack  | VU5        | structured captions on every fixture shot; hosted captioner emits the same JSON; background indexing of the whole fixture set finishes without the UI stalling   |
| VU7   | Sampled verification   | VU2, VU3   | post-apply `shot_match` on flagged cuts; vision review fires only on undecidable pairs; findings land as working-state facts                                     |
| VU8   | Scale and operations   | VU1–VU6    | 10-hour synthetic library and 1000-asset project indexed within budget; pause during render; resume after kill; eviction                                         |
| VU9   | Closure                | all        | docs, ADRs, changelog, plan reconciled; the golden gate carries the new metrics                                                                                  |

VU1, VU2 and VU3 are the first vertical slice and need no new model, no new dependency, and
no capability pack. They are where "context aware instead of vague trimming" first becomes
visible on the default install. Do them first and measure before starting VU5.

## Scale, in numbers

Ten hours of footage at one shot every five seconds is 7,200 shots.

| Item                | Size or time                                                                                     | Basis                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Tier 0 pass         | ~1× real-time per core at 160px decode, so ~2.5 h on 4 workers, background                       | ffmpeg `scale=160:-2` + `signalstats,scdet,siti` single pass |
| Ledger rows         | 7,200 × ~1.5 KB ≈ 11 MB                                                                          | JSON per shot in SQLite                                      |
| Tier 1 vectors      | 7,200 × 768 × 4 B ≈ 22 MB                                                                        | SigLIP base                                                  |
| Tier 1 pass         | ~30 ms/shot on M1 Pro CPU via onnxruntime, ~4 min total                                          | keyframe only                                                |
| Tier 2 pass         | 1–3 s/shot on M1 Pro Metal with a 2.2B Q4 VLM, 2–6 h background, timeline-referenced shots first | one call per shot, 1–3 keyframes                             |
| Prompt cost per run | +0 frames; +≤ 90 chars per shown clip; +≤ 600 tokens project digest                              | bounded by the existing clip budget                          |

Every figure above is a target to be measured in VU0/VU8, not a claim. The point is the shape:
the expensive work is O(footage) and cached forever; the per-run work is O(clips shown).

## Relation to other plans

- `plan/MEDIA-INTELLIGENCE.md` (complete) built the sampler, NVIDIA embeddings, hosted captions,
  the vector store and the three tools. This plan keeps all of it and removes the key gate in
  front of it.
- `plan/media-intelligence-closure/` (shipped 2026-08-28) fixed preparation correctness, the
  time base and the panel. Its §2.5 gap list ("nothing about shot quality… no subject/person
  presence… no duplicate detection") is exactly what tiers 0 and 1 deliver.
- `plan/AI-FOOTAGE-INTELLIGENCE-E2E.md` (Pegasus footage map, grounded proposer) is
  superseded for the built-in backend by the ledger; the TwelveLabs arm stays optional.
- `plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` P3 ("scene understanding service") is the
  pixel-accurate mask/depth/track layer. This plan is the shot-level fact layer beneath it and
  deliberately does not do segmentation or depth.
- ADR 0114 (capability packs) is the distribution vehicle for tiers 1 and 2.
