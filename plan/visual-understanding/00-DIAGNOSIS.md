# 00 — Diagnosis: why the agent is blind, with citations

Every claim cites a file read on 2026-09-07 at `03a2e31` (origin/main) or a report under
`reports/golden/`. Re-check rather than trust.

## 1. The symptom, measured

Tool-name mentions across every golden run report under `reports/golden/` (all sessions,
all replays):

| Tool                                                 | Mentions | What it means                                                |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------ |
| `get_timeline`                                       | 713      | the model re-reads clip geometry constantly                  |
| `render_preview`                                     | 250      | it renders, but a preview is a file the model cannot see     |
| `add_transition`                                     | 28       | it adds transitions without knowing the shots on either side |
| `get_frame`                                          | 13       | it looked at a picture 13 times across ~30 runs              |
| `verify_transitions`                                 | 11       |                                                              |
| `search_visual` / `describe_footage` / `map_footage` | 10 each  | one per run at most, usually zero                            |
| `measure_color`                                      | 0        | never                                                        |
| `apply_color_grade`                                  | 0        | never                                                        |

The ratio of geometry reads to picture reads is about 55:1. The agent is not choosing the
wrong frames. It is not choosing frames.

## 2. The chain, hop by hop

### 2.1 Nothing is indexed without a key

- `apps/web-editor/src/editor/visualIndex.ts:74–76` — `shouldAutoIndex(config)` returns true
  only when an NVIDIA embeddings key or a TwelveLabs key is configured. `autoIndexImportedAssets`
  returns `undefined` at line 95–98 otherwise. This is the only automatic enrolment on the human
  import path.
- `apps/desktop/electron/main.ts` (`enrolStockAsset`): `if (!credentials.twelveLabsKey && !credentials.nvidiaKeys) return;`
  The agent's own stock downloads are likewise not enrolled without a key.
- `engine/python/framepilot_engine/service.py` `/brain/visual/index`: after the TwelveLabs
  check, `resolve_visual_embedder(...)`; when `embedder_res.client is None` the route returns
  `available=True, reason=...` and processes nothing. Sampling (`sample_asset`) and scene cuts
  only run inside `_index_one_asset`, which is only reached with an embedder.
- ADR 0066 made this explicit: "with no key, no frame is ever sent and indexing simply does
  not run." That was the right privacy decision for a hosted embedder. It became the wrong
  default for perception as a whole, because every fact the agent could learn about footage
  was put behind it, including facts ffmpeg computes locally in one pass.

**Consequence:** on a default install the brain has `assets` rows and `analysis_results` rows
from the `quick` warmup (`probe`, `silence` — `analysis/tiers.py` `DEPTH_KINDS`), and no
`visual_spans`, no `visual_captions`, no vectors. Every visual surface answers `not_indexed`.

### 2.2 Even when indexed, the model reads almost none of it

- `packages/ai-sdk/src/context-builder.ts` `renderTrackClips`: a clip renders as
  `` `${c.id}[${round(c.start)}–${round(c.end)}s]` ``. No asset, no name, no content. The
  timeline slice the model reads on every turn carries geometry only.
- The footage map is injected as one text block (`context-builder.ts:1096–1097`,
  `summarizeFootageMap`), whole-second chapters, no asset ids in the lines
  (`plan/media-intelligence-closure/00-DIAGNOSIS.md` §2.5, still true).
- `search_visual` and `describe_footage` return `EvidencePacket{assetId, t0, t1, sceneId,
score, caption, transcriptOverlap}` (`brain/visual_search.py:135`). The caption is the
  free-text output of `CAPTION_INSTRUCTION` ("Describe what is visible on screen in ≤2
  sentences") — no shot size, no camera, no quality, not machine-readable.
- `kernel/semantic-index/semantic-index.ts` derives `shots` from `detect_scenes` results when a
  caller passes an `analysisResults` bag. No caller in `orchestrator.ts` or `kernel/conductor.ts`
  passes one (grep returns nothing outside tests). The shots slice is empty in production runs.
- `kernel/briefing.ts` classifies analysis/sourcing facts as `footage` but the working state's
  evidence list was `[]` in every snapshot of every run (its own comment at line 54).

### 2.3 The tools that would measure exist and are unreachable in practice

- `measure_color` (`sidecar-executor.ts:1118`) drives `/review/temporal-evidence` with a
  `scope` request over up to 300 frames, returning luma/RGB/saturation/skin distributions.
  Called 0 times in every recorded run. It is a pull tool with no consumer: nothing turns its
  numbers into a grade.
- `/review/temporal-evidence` already implements `comparison` requests with
  `check: "transition_continuity" | "shot_match"` (`validation/temporal_evidence.py:104–108`).
  This is the deterministic cut-pair check this plan needs, and nothing calls it after an apply.
- `vision-review.ts` and `vision-evidence-client.ts` implement a bounded, cancellable, frame-
  acquiring semantic review. `grep -rn "createVisionFrameAcquirer\|visionReview"` finds no
  caller outside the modules and their tests.
- `get_frame` (ADR 0096) renders through the export compiler and returns a real image. It is
  the right verification primitive and the wrong planning primitive: it costs a sidecar
  composite plus ~1k image tokens per call, and a budgeted model rationally avoids it.

### 2.4 Numbers and kinds are guessed

- `apply_color_grade` takes numeric `exposure/contrast/saturation/temperature/tint/shadows/highlights`
  bounded by `COLOR_GRADE_PARAMETER_CONTRACTS` (`editor-core/src/edit-value-contracts.ts`). The
  contract bounds the range; nothing supplies a measured baseline. A model asked to "match the
  look" has to invent `temperature: 0.2`.
- `add_transition` (`domain-tools/graphics.ts:387–412`) requires a `kind` that must exist in a
  50-entry catalog (`timeline-schema/src/transition-catalog.ts`, 7 categories) and a positive
  `durationSeconds`. `discover_transitions` returns ids, blurbs and defaults. There is no
  notion of _why_ a transition belongs at a cut, and no fact about the two shots.

### 2.5 The prior plans built the pipeline and left the gate

- `plan/MEDIA-INTELLIGENCE.md` (complete 2026-07-18): sampler, NVIDIA embeddings, hosted
  captions, vector store, three tools. Decision D6/D7 chose hosted providers for everything
  neural; nothing non-neural was in scope, so nothing runs keyless.
- `plan/AI-FOOTAGE-INTELLIGENCE-E2E.md` (2026-07-21, then superseded 2026-08-05): Pegasus
  footage map, grounded proposer. Phase 0 is still `[~]`/`[!]`; the desktop baseline was never
  published. Its D1 ("automatic embeddings and indexing… internal `ensure_media_understanding`")
  was implemented as `media-understanding-runtime.ts`, which still returns `unconfigured` with
  no key.
- `plan/media-intelligence-closure/` (shipped 2026-08-28): fixed real defects (55 assets,
  100 jobs done, zero spans) and wrote the honest gap list in §2.5. It did not change what
  the model reads per clip.
- The kernel plans (`AI-ORCHESTRATION-REDESIGN.md`, `AGENT-ORCHESTRATION-*.md`,
  `ORCHESTRATION-*.md`) are ~250 KB of loop engineering. They made the loop safe. They cannot
  make it see.

## 3. Root cause statement

**Perception is optional, pull-based, and key-gated. The agent's state has no facts about
pictures, so every visual decision is a guess dressed as an operation.**

Three consequences follow, and they are the user's three complaints:

1. _"AI does not know what it edited or what is on screen"_ — the timeline slice carries
   geometry only, and there is no join from a clip to what its source shows.
2. _"How much color grade"_ — there is no measured baseline, so the grade is a number the
   model invents; `measure_color` exists and is never consumed by anything.
3. _"Which transition is better"_ — the tool takes a catalog id and a duration, with no
   knowledge of the shots on either side and no policy.

## 4. What is right and must be kept

- The brain (ADR 0058): derived, rebuildable, sidecar-written SQLite with content-hash
  invalidation. The ledger belongs here.
- The paced-slice journaled job pattern (`/analyze/batch`, `/brain/visual/index`) with a
  fixed worklist, cursor, cancel flag and per-project lock. Reuse for the ledger pass.
- `visual_sampler.py`: scene-aware 1 fps candidates folded by dHash into spans. This is the
  shot boundary source for tier 0.
- `temporal_evidence.py`: per-frame and per-window measurement with `scope`, `comparison`,
  `motion`, `audio`, `loudness`. The color solver's verifier already exists here.
- `vision-review.ts`: the bounded semantic reviewer, correctly kept small. Give it a caller.
- Capability packs (ADR 0114, `packages/capability-packs`, `workers/*`): JSON-line worker
  protocol, SHA-256 verified installs, licence manifests. Tiers 1 and 2 ship through this.
- The semantic index: memoized per immutable snapshot, incremental by construction. The
  projection join goes here.
- The golden harness: 21 cases, rubric on edit state, metrics per accepted edit. Add the
  perception metrics to it rather than building a second instrument.

## 5. What is wrong and must change

| Defect                                    | Where                                                          | Fix (phase)                                               |
| ----------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| Key gate in front of all perception       | `visualIndex.ts:74`, `main.ts` enrol, `service.py` index route | tier 0 runs keyless (VU1)                                 |
| Clip rows carry geometry only             | `context-builder.ts` `renderTrackClips`                        | fact suffix (VU2)                                         |
| No clip → shot join                       | `semantic-index.ts` shots slice needs a bag nobody passes      | projection slice reads the brain (VU2)                    |
| Free-text captions                        | `captioner.py` `CAPTION_INSTRUCTION`                           | structured JSON, same fields for local and hosted (VU6)   |
| Grade values guessed                      | `apply_color_grade` args                                       | `match_color` / `normalize_exposure` / look intents (VU3) |
| Transition chosen by name                 | `add_transition` args                                          | `reason` + policy table (VU4)                             |
| Verification never looks                  | no caller for `shot_match`, `vision-review`                    | post-apply flagged-cut check (VU7)                        |
| Indexing enrolment is per-path and ad hoc | renderer hook + stock enroller                                 | one import hook in main, priority queue (VU1, VU8)        |
