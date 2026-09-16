# 06 — Precision: metrics, fixtures, gates

"Precise" is a number here, or it is not claimed. ADR 0176's rule applies: the unit suites prove
protocol, policy and sandbox, not accuracy. Accuracy is claimed only from this eval.

## Metrics

| Metric                       | Definition                                                                         | Catches                       |
| ---------------------------- | ---------------------------------------------------------------------------------- | ----------------------------- |
| **IoU**                      | Intersection over union of the binarised alpha (α ≥ 0.5) against ground truth       | Wrong subject, missing limbs  |
| **Boundary F (BF@3px)**      | F-measure of boundary pixels within 3 px, at source resolution                      | Sloppy edges                  |
| **SAD / MSE in the band**    | Sum of absolute differences and MSE of alpha inside the ground-truth unknown band   | Hair and soft-edge quality    |
| **Temporal flicker (dtSSD)** | Error in frame-to-frame alpha change versus ground-truth change                      | Edge crawl during playback    |
| **Leak rate**                | Fraction of frames with any connected background region > 0.2% of frame kept       | Visible holes and halos       |
| **Throughput**               | Compute seconds per footage second, by EP and resolution                            | Unusable wait                 |
| **Frame alignment**          | Matte pts == source pts on every frame                                               | Drift (must be exact)         |

## Fixture set (`tests/fixtures/background-removal/`)

- **Construction-true clips**, where ground truth exists by construction (the caption-quality-eval
  pattern): subjects composited over varied backgrounds with a known alpha. This includes real
  hair mattes, motion blur, a semi-transparent object, a subject leaving and re-entering frame,
  and camera motion. These are generated from permissively licensed matted stills or
  green-screen footage whose licence allows redistribution; the licence is recorded per file.
- **Real camera clips** (desktop-scale: 1080p and 4K, 1–3 min, CLAUDE.md "not tiny fixtures")
  with hand-labelled keyframes every 1 s for IoU/BF. The labels are a human pass, and the
  tracker says so explicitly. A machine-proposed label is never counted as ground truth
  (the `tier2.json` lesson).
- **Categories**: talking head (easy), full body walking, hair against a busy background,
  pet, product on a table, two people where only one is prompted, low light, fast motion.
- Large media follows the repo's fixture rules. **Never `git add -A`** (memory: 3.8 GB incident).

## Gates (the pack does not ship until all pass on both platforms)

| Gate                                  | Threshold (proposed; the maintainer may tighten)                       |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Mean IoU, auto prompt, easy + medium  | ≥ 0.97                                                                 |
| Mean IoU, one click, all categories   | ≥ 0.95                                                                 |
| BF@3px, all categories                | ≥ 0.90                                                                 |
| Band SAD, hair category               | Measured against the classical-matting fallback; the model must beat it by a stated margin |
| dtSSD                                 | ≤ the BR0 fallback pipeline's figure, and no visible crawl in a blind side-by-side review |
| Leak rate                             | ≤ 1% of frames                                                         |
| Correction convergence                | ≤ 3 correction clicks brings every failing labelled keyframe to IoU ≥ 0.98 |
| Frame alignment                       | 100% (any miss fails)                                                  |
| Preview↔export parity                 | As in [`04`](./04-SCHEMA-RENDER-PREVIEW.md#parity-test)                 |

The "correction convergence" gate is how "100% precise" is made concrete: the model does not
have to be perfect, but a frame it gets wrong must be fixable in a few clicks, and that is
measured.

## Harness

`workers/background-removal/eval/run_eval.py` runs the **installed, signed entrypoint** (not
Python imports), the way `visual-describe/eval` does. It writes
`reports/background-removal/<date>-<platform>.json` plus a contact sheet (composite over
magenta, matte, error heat map) for human review. Reports are committed, so later sessions read
recorded numbers instead of re-running (memory: no full suites, no golden runs).
