# ADR 0175 — Perception is a compiled shot ledger, and tier 0 needs no key

- **Status:** Accepted
- **Date:** 2026-09-07
- **Relates to:** ADR 0058 (the project brain is a derived SQLite substrate),
  ADR 0066 (NVIDIA cloud visual embeddings), ADR 0070 (TwelveLabs as an optional
  understanding backend), ADR 0096 (`get_frame`, the model's eyes), ADR 0114
  (heavy capabilities ship as on-demand packs), ADR 0134 (footage understanding
  needs no Pegasus index), ADR 0137 (the runtime measures, the agent decides).
- **Plan:** [`plan/visual-understanding/`](../../plan/visual-understanding/README.md)

## Context

The agent cannot see, and the measurement is not close. Folding the per-turn
tool-call records of ten recorded golden runs — 318 scored turns, 210 accepted
edits ([`reports/golden/BASELINE.md`](../../reports/golden/BASELINE.md)) — gives:

| Tool                                                                | Calls                               |
| ------------------------------------------------------------------- | ----------------------------------- |
| `get_timeline` / `get_timeline_summary`                             | 192                                 |
| `get_frame`                                                         | **0**                               |
| `search_visual`, `describe_footage`, `map_footage`, `measure_color` | **0**, in every run                 |
| `apply_color_grade` / `add_transition`                              | 3, in one turn, none measured first |

Four things caused it, and each is a decision that was individually right:

1. **ADR 0066 made a key the price of perception.** Sending frames to a hosted
   embedder must be opt-in, so indexing runs only with a key
   (`visualIndex.ts:74`, and the `/brain/visual/index` embedder short-circuit).
   But _everything_ the agent could learn about footage was put behind that gate,
   including the statistics ffmpeg computes locally in one pass. On a default
   install the visual index is empty and every surface built on it answers
   `not_indexed`.
2. **The timeline slice carries geometry only.** `renderTrackClips` prints
   `c12[0–4.2s]`. There is no join from a clip to what its source shows, so the
   model's state contains no fact about any picture.
3. **Perception is pull-based.** Looking costs a turn, a sidecar composite and
   ~1k image tokens (`get_frame`), so a budgeted model rationally never looks.
   A tool that is never called is not a capability.
4. **Nothing consumes measurements.** `measure_color` returns real luma/chroma
   distributions through `/review/temporal-evidence`, and no code turns them into
   a grade. `add_transition` takes a catalog id and a duration and knows nothing
   about the two shots it sits between.

The obvious fix — attach frames to model calls — is the one we reject. It scales
with _decisions_, so it gets more expensive exactly as the agent gets more
capable, and at ten hours of footage it is unaffordable in both tokens and time.

## Decision

**Compile perception into a per-shot ledger at import, and let the agent read it
through the timeline as text. Tier 0 of that ledger needs no key, no network and
no model.**

Four parts:

1. **A shot ledger in the brain.** One record per shot (a contiguous source span
   of one asset with no scene cut inside it), in three provenance-separated
   groups — `measured`, `labelled`, `described` — plus a per-asset digest. Brain
   schema v4 adds `shots`, `entities` and `asset_digest`. It is derived,
   rebuildable data under ADR 0058's invariants: deleting the brain loses time,
   never truth. **`project.fp.json` does not change.**

2. **Three tiers, degrading independently.**
   - _Tier 0, measured_ — one ffmpeg pass per asset (`signalstats`, `scdet`,
     `siti`, `blurdetect`, `blackdetect`, `freezedetect`): scene cuts, luma
     distribution, warmth, contrast, motion, sharpness, black/freeze, phash,
     per-shot loudness. Runs whenever ffmpeg resolves, which is always, because
     ffmpeg is already a hard dependency. **This is the floor under every
     backend**, including TwelveLabs.
   - _Tier 1, labelled_ — local SigLIP embeddings, zero-shot shot-size/subject/
     setting labels, face identity clusters, duplicate takes. A capability pack
     (ADR 0114).
   - _Tier 2, described_ — one structured caption per shot from a local
     llama.cpp VLM pack, with the hosted captioner emitting the same JSON.
     A tier that cannot run is recorded as absent coverage, never an early return
     that kills the job.

3. **The agent reads facts, the solver reads numbers.** A `picture` slice in the
   semantic index joins every clip to its shots and derives cut-pair deltas. Clip
   rows gain a words-only suffix — `c12[61–66.4s] · MS man at desk · static · bright warm`
   — and the project gains a bounded digest. Numbers never appear in
   a clip row: grade values come from `match_color`/`normalize_exposure`/
   `apply_look` solving against measurements, and transitions from a policy table
   keyed on a stated _reason_ plus the cut-pair deltas. Both emit the operations
   that already exist, so validation, undo and render are untouched.

4. **Pixels verify, they do not plan.** After an apply, flagged cut pairs go
   through the existing `comparison: shot_match` / `transition_continuity`
   evidence route; only pairs the numbers cannot settle reach `vision-review`,
   bounded to two pairs of two frames. `get_frame` remains a verification and
   dev tool.

The cost model this buys, and the reason it holds at scale:

| Work     | Scales with           | Paid                                         |
| -------- | --------------------- | -------------------------------------------- |
| Perceive | footage minutes       | once per asset content hash and tier version |
| Project  | clips on the timeline | once per revision, memoized                  |
| Decide   | decisions             | per turn, text only                          |

## Consequences

- On a clean install with no key and no network, the agent knows which clips are
  dark, warm, soft, static, duplicated, and where every shot starts and ends.
  That is new; today it knows nothing.
- Frames stop being how the agent learns anything. `framesSeenPerEdit` is a
  **ceiling** in the golden gate, not a goal.
- A model swap re-runs one tier: `tierN_version` nulls one column and re-queues
  it. Content-hash keys make re-imports free.
- Indexing becomes background work with a resource governor, so it must yield to
  renders, exports and interactive frame grabs.
- The privacy statement narrows to what it always should have been: _frames leave
  the machine only on a hosted arm, only with a key._ Local decode always runs.
- ADR 0066's hosted embedder becomes a redundant second vector space once the
  local pack ships and is removed rather than kept in parallel
  (`plan/visual-understanding/08-REMOVE-DEFER-RISKS.md`).
- Two engine dependencies land behind packs, never in the frozen sidecar: no
  torch, no transformers, no GPU matrix in the desktop build.

## Rejected alternatives

- **A frame (or contact sheet) with every model call.** Scales with decisions,
  not footage; unaffordable at library scale; and it would make the agent's
  understanding non-reproducible between turns.
- **A bigger hosted understanding backend (Pegasus for everything).** Costs a key
  and a network on every project, bills per asset, and still leaves the default
  install blind. Kept as an optional tier 2 producer only.
- **Storing facts in `project.fp.json`.** They are derived from media, not
  authored by the editor; they would bloat the document, need a migration per
  model swap, and break the rule that the project file is the only truth.
- **Free-text captions as the whole understanding layer.** Unparseable by a
  solver, unfilterable by search, and already shipped: it is exactly what exists
  today and it is never called.
- **Waiting for the scene-understanding service** (`SCENE-UNDERSTANDING-AND-COMPOSITING.md`
  P3, segmentation and depth). That layer is pixel-accurate and expensive; shot-level
  facts are cheap and are what editing decisions actually need. This ADR is the
  layer beneath it and does not do segmentation.
