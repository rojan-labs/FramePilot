# MK7.5 — tracking gates: what is measured, and what is not

The numbers mask tracking is allowed to claim. Plan [`06`](./06-PRECISION-AND-EVAL.md) sets the
thresholds; this file records what they measured, on which run, and which rows are still open.
Nothing here is retyped by hand: the harness writes `tracking-gates.json`, which the
**Capability Pack — Tracking Lite** workflow uploads per platform.

## How the numbers are produced

`workers/tracking-lite/tests/test_tracking_gates.py`, marked `decoded_media`, so it runs in the
pack workflow with the real OpenCV backend and never in the base CI environment (ADR 0114: the CV
stack must not enter the base installer).

- **Ground truth is exact by construction.** A deterministic seeded plate is warped by a KNOWN
  homography per frame, rendered with a bilinear sampler written in NumPy, and round-tripped
  through lossless PNG. The error is the distance between where the tracker says a corner of the
  masked quad went and where the known warp actually put it.
- **No `testsrc`.** ffmpeg's synthetic source differs between ffmpeg versions and has broken a
  golden in this repository before.
- **No re-encode.** The rendered frames go to the tracker directly. A codec's own error has no
  business inside a number about the tracker; decoding is proved separately by
  `test_decoded_media.py`, which runs real encoded video through the same backend.
- **The recall gate uses the product's own rule.** `flagged()` in the harness is the host's
  confidence-penalised-by-residual rule, and `test_tracking_gate_constants_match_the_host` reads
  `packages/editor-core/src/mask-track-solve.ts` so the harness cannot drift away from what the
  editor actually flags.

Run it locally with the CV extra:

```bash
cd workers/tracking-lite && uv run --extra cv --no-dev --with pytest pytest -m decoded_media -q
```

## Gates

| Gate (plan 06)                                     | Threshold                                                                       | Status                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| Planar track on synthetic warps (known homography) | median corner reprojection ≤ 0.25 px, p95 ≤ 1 px, no frame > 2 px               | Measured — see the run below         |
| Drift                                              | ≤ 1 px per 300 frames on static-scene fixtures                                  | Measured                             |
| Low-confidence detection recall                    | ≥ 99.5 % of frames with error > 2 px are flagged                                | Measured — met by refusal; see below |
| Constraint frames                                  | 100 % exact after any re-track                                                  | Proved, not sampled (below)          |
| Correction                                         | one constraint frame brings a failing range back within gate in ≥ 95 % of cases | **Open** (below)                     |
| Real clips with hand-labelled corners every 0.5 s  | median ≤ 0.5 px, p95 ≤ 2 px at source resolution                                | **Open** (below)                     |

Three warps are measured, because the three motion models the editor can pick have to be right
for different reasons: a pure **translation**, a **similarity** (translation, uniform scale and
rotation) and a **perspective** warp with a real third row.

### Constraint frames: proved rather than sampled

"100 % exact after any re-track" is a property of how a re-track is built, not a statistic:
`mergeTrackSegments` anchors each re-measured segment **on** its constraint frame, so the
transform there is exactly the identity and the mask's own corrected geometry is what renders.
Two tests hold it up, on both sides of the protocol:

- `packages/editor-core/src/mask-track-review.test.ts` — "keeps every constraint frame exactly
  the identity", including where two segments overlap.
- `workers/tracking-lite/tests/test_tracking_gates.py` — "the reference frame is exactly the
  identity", measured on real pixels (error 0.0 px on the anchor frame).

### Open rows, and why

**Real clips with hand-labelled corners.** This repository commits no photographic footage — the
mission fixtures are fetched on demand (`tests/fixtures/mission/fetch-fixtures.sh`), and MK7 is
explicitly not the place to add large media. Hand-labelling corners every 0.5 s is also a human
action, not something an agent can honestly produce. The row stays open and unclaimed; it belongs
with the beta evidence (MO-7), where real-hardware confirmation of the MK4 pointer budget already
sits.

**Correction (≥ 95 % of failing ranges recovered by one constraint).** Measuring this needs
failing ranges from real footage: a synthetic occluder produces a failure whose recovery is
decided by the occluder's own length rather than by the tracker, so a number from it would be a
number about the fixture. The mechanism is implemented and unit-tested (`retrackPlan` measures
outwards from each constraint, only over stretches still under the floor; `mergeTrackSegments`
gives every frame to its nearest constraint), and the rate goes with the real-clip set.

## Measured run

Workflow run **35294557292** (`Capability Pack — Tracking Lite`, `workflow_dispatch` on
`plan/background-removal-ai` at `fee85dfa`), both shipped platforms green. Numbers are the
uploaded `tracking-gates-<platform>.json`; do not retype individual figures.

### Planar reprojection — gate: median ≤ 0.25 px, p95 ≤ 1 px, max ≤ 2 px

| Platform     | Sequence           | Frames | Median px  | p95 px     | Max px     |
| ------------ | ------------------ | ------ | ---------- | ---------- | ---------- |
| darwin-arm64 | planar/translation | 60     | **0.0204** | **0.0338** | **0.0376** |
| darwin-arm64 | planar/similarity  | 60     | **0.0771** | **0.1559** | **0.1673** |
| darwin-arm64 | planar/perspective | 60     | **0.0698** | **0.1344** | **0.1533** |
| win32-x64    | planar/translation | 60     | **0.0205** | **0.0338** | **0.0377** |
| win32-x64    | planar/similarity  | 60     | **0.0771** | **0.1558** | **0.1671** |
| win32-x64    | planar/perspective | 60     | **0.0698** | **0.1345** | **0.1533** |

Every figure is an order of magnitude inside its threshold, and the two platforms agree to
within 1e-3 px — the fit is dominated by the image, not by the machine.

### Drift — gate: ≤ 1 px per 300 frames

| Platform     | Frames | Final error px | Extrapolated per 300 frames |
| ------------ | ------ | -------------- | --------------------------- |
| darwin-arm64 | 120    | 8.0e-14        | **2.0e-13**                 |
| win32-x64    | 120    | 1.1e-13        | **2.9e-13**                 |

Effectively zero: the planar tracker anchors every frame to the features it detected on the
reference frame rather than to the previous frame, so a static scene has nothing to accumulate.

### Low-confidence detection recall — gate: ≥ 99.5 %

| Platform     | Mode        | Recall   | Detail                                       |
| ------------ | ----------- | -------- | -------------------------------------------- |
| darwin-arm64 | **refused** | **100%** | target lost after frame 45 (competing plane) |
| win32-x64    | **refused** | **100%** | target lost after frame 45 (competing plane) |

Read this honestly. The recall gate asks whether a wrong frame reaches the editor flagged, and
it does — but on every fixture tried it did so by the worker **refusing** rather than by the
confidence number catching a wrong plane. Four fixtures were attempted:

1. a total occluder — `target_lost`;
2. a 26 px/frame motion-blurred burst — `target_lost`;
3. a 9 px/frame blurred burst — every frame inside the 2 px gate, nothing to catch;
4. a competing plane sliding across a third of the masked region — `target_lost` after 10 frames
   of intrusion.

The consistent finding is that **this worker refuses far more readily than it reports a wrong
plane**: its robust fit has an inlier floor (0.5), its point track has a forward/backward
consistency check, and its policy bounds how long it will hold an unmeasured frame (15). When
that happens the run fails, nothing is written, and the mask keeps the geometry it had — complete
detection, by a different route than the confidence number.

What is therefore **not** yet evidenced is the confidence number's own recall on frames the
tracker measures and gets wrong. That band could not be produced synthetically, and measuring it
needs the real-clip set, so it travels with the two open rows above rather than being claimed
here.
