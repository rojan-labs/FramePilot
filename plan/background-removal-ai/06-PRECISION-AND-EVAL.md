# 06 — Precision and accuracy: metrics, fixtures, gates (mattes, shape masks, tracking, AI masking)

"Precise" is a number here, or it is not claimed. ADR 0176's rule applies: unit suites prove
protocol, policy and sandbox, not accuracy. Accuracy is claimed only from this eval.

## What "100% precise and accurate" means in this plan

No model is right on every frame of arbitrary footage, and this plan does not pretend otherwise.
The 100% guarantee is about **the delivered result**, and it has three measurable parts:

1. **Automatic accuracy:** the pipeline's own output clears the model-quality gates below on every
   category, with no editor input beyond the initial prompt.
2. **Nothing wrong goes unflagged:** the verification stage catches ≥ 99.5% of frames that are
   actually wrong (the **error-detection recall** gate). The remaining risk is stated as a number,
   not hidden.
3. **Every flagged frame can be made exact:** a frame the editor corrects reaches IoU ≥ 0.995 and
   BF ≥ 0.98 in ≤ 3 actions, and stays that way (locked frames are hard constraints).

When the Inspector's review list is empty (every frame verified by the pipeline or approved by the
editor), the section shows **Verified**. That badge is the product's 100% claim, and part 2 is
what makes it honest.

## Metrics

| Metric                                  | Definition                                                                            | Catches                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **IoU**                                 | Intersection over union of binarised alpha (α ≥ 0.5) vs ground truth                  | Wrong subject, missing limbs                    |
| **Boundary F (BF@2px)**                 | F-measure of boundary pixels within 2 px, at source resolution                        | Sloppy edges                                    |
| **SAD / MSE / Grad / Conn in the band** | Standard alpha-matting errors inside the ground-truth unknown band                    | Hair, blur and translucency quality             |
| **Foreground colour error**             | Mean ΔE2000 of composited edge pixels over a new background vs ground-truth composite | Halos, colour fringe                            |
| **Temporal flicker (dtSSD, MESSDdt)**   | Frame-to-frame alpha change error vs ground truth                                     | Edge crawl in playback                          |
| **Leak rate**                           | Frames with any wrong connected region > 0.05% of frame                               | Visible holes and islands                       |
| **Error-detection recall**              | Of frames with IoU < 0.98 or BF@2px < 0.95, the fraction in `needsReview`             | Silent errors                                   |
| **Review load**                         | Fraction of frames flagged                                                            | A detector that flags everything to hit recall  |
| **Frame alignment**                     | Matte pts == source pts, every frame                                                  | Drift (must be exact)                           |
| **Throughput**                          | Compute seconds per footage second by EP and resolution                               | Informs the ETA; never traded against the gates |

## Fixture set (`tests/fixtures/background-removal/`)

- **Construction-true clips**, where ground truth exists by construction (the caption-quality-eval
  pattern): subjects with real alpha composited over varied, moving backgrounds, including
  hair, motion blur, translucent objects, a subject leaving and re-entering, camera motion, and a
  second person crossing. Licence recorded per source file.
- **Real camera clips** at desktop scale (1080p and 4K, 1–3 min, CLAUDE.md "not tiny fixtures")
  with **human-labelled** alpha keyframes every 0.5 s. Labels are marked human-verified; a
  machine-proposed label never counts as ground truth (the `tier2.json` lesson).
- **Categories:** talking head, full body walking, hair against a busy background, pet, product on
  a table, two people with one prompted, low light, fast motion, a background similar in colour to
  the subject, and **text-behind-subject** composites (the main use case, judged on the final
  composite, not the matte alone).
- Large media follows the repo's fixture rules. **Never `git add -A`** (memory: 3.8 GB incident).

## Matte gates (the pack does not ship until all pass on darwin-arm64 **and** win32-x64)

| Gate                                    | Threshold (proposed; the maintainer may tighten, never loosen)                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mean IoU, auto prompt, every category   | ≥ 0.98                                                                                                                                              |
| Worst-category mean IoU, one click      | ≥ 0.97                                                                                                                                              |
| 5th-percentile per-frame IoU, one click | ≥ 0.95                                                                                                                                              |
| BF@2px, every category                  | ≥ 0.95                                                                                                                                              |
| Band SAD / Grad, hair category          | ≥ 25% lower than the same pipeline with band alpha disabled (binary refined edge), and within 2% of the fp32 PyTorch reference of the same pipeline |
| Foreground colour error                 | Mean ΔE2000 ≤ 2.0 in the band                                                                                                                       |
| dtSSD                                   | ≥ 30% lower than the same pipeline with stabilisation disabled; no visible crawl in a blind side-by-side review                                     |
| Leak rate                               | ≤ 0.5% of frames before review                                                                                                                      |
| **Error-detection recall**              | **≥ 99.5%**                                                                                                                                         |
| Review load                             | ≤ 10% of frames on medium categories (keeps recall from being bought by flagging everything)                                                        |
| Correction convergence                  | ≤ 3 actions → corrected frame IoU ≥ 0.995, BF@2px ≥ 0.98; neighbours within 1 s do not regress                                                      |
| Locked frames                           | 100% bit-identical after any later re-run                                                                                                           |
| Frame alignment                         | 100%                                                                                                                                                |
| Preview ↔ export                        | The matte and text-behind-subject rows of the [`09`](./09-PREVIEW-EXPORT-PARITY.md) oracle pass                                                     |

If a gate misses, the numbers go to the maintainer. A gate is not quietly lowered to ship.

## Shape masks and the rasteriser

| Gate                                     | Threshold                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Coverage vs 64×64-supersampled reference | Max error ≤ 1/255 per pixel on every vector case                                                                                  |
| Engine vs preview rasteriser             | **Byte-identical** on every vector case at 3 resolutions                                                                          |
| Distance feather vs analytic reference   | Max error ≤ 1/255 in the band (straight edges, circles, per-vertex feather)                                                       |
| Path interpolation between keyframes     | Vertex positions equal the easing formula to 1e-6 px; no vertex correspondence swap                                               |
| Legacy migration                         | Every v21 fixture project exports **byte-identical** after migration                                                              |
| Source-time anchoring                    | After trim, slip, split, ripple, speed change and speed ramp, the mask's rendered alpha at the same **source** frame is identical |
| Key mask                                 | Engine vs preview keyed alpha ≤ 1/255 on colour charts in BT.601/709, full/limited range                                          |
| Preview ↔ export                         | All mask rows of the `09` oracle                                                                                                  |

## Tracking

| Gate                                               | Threshold                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Planar track on synthetic warps (known homography) | Median corner reprojection ≤ 0.25 px, p95 ≤ 1 px, no frame > 2 px              |
| Real clips with hand-labelled corners every 0.5 s  | Median ≤ 0.5 px, p95 ≤ 2 px at source resolution                               |
| Drift                                              | ≤ 1 px per 300 frames on static-scene fixtures                                 |
| Low-confidence detection recall                    | ≥ 99.5% of frames with error > 2 px are flagged                                |
| Correction                                         | One constraint frame brings a failing range back within gate in ≥ 95% of cases |
| Constraint frames                                  | 100% exact after any re-track                                                  |

## AI masking

| Gate                                     | Threshold                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Target resolution, unambiguous requests  | ≥ 99% pick the labelled target                                                                                                          |
| Ambiguous requests                       | ≥ 97% ask the user (return `ambiguous_target`); a wrong confident pick counts as a failure, not an ask                                  |
| Unnecessary asks on unambiguous requests | ≤ 3%                                                                                                                                    |
| Fabricated geometry                      | 0 (every applied mask vertex traces to a candidate, a measurement or a user number; enforced by the validator and audited in the eval)  |
| Mask quality                             | The same matte, shape and tracking gates as above, measured through the agent path                                                      |
| Face/plate "hide"                        | Post-effect detail check: text/face recognisers on the exported frames find nothing inside the masked region on 100% of labelled frames |
| Verification honesty                     | 0 runs claim Verified or omit a flagged count                                                                                           |
| Token cost                               | Zero delta on projects without masks; the domain's measured delta recorded in the goldens                                               |

## Production budgets (from the audit in [`12`](./12-PARITY-AND-PRODUCTION-AUDIT.md))

| Budget                                                         | Threshold                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pointer-to-paint while editing a 200-vertex path on 4K footage | ≤ 16 ms p95                                                                                 |
| Hover highlight after the frame embedding exists               | ≤ 100 ms p95                                                                                |
| Click-to-mask (single frame)                                   | ≤ 300 ms p95 after the frame embedding; the first embedding per frame is measured and shown |
| Export with masks and 4K mattes (Scale fixture)                | ≤ 1.5× the same timeline without masks                                                      |
| Save/autosave with 1,000 path keyframes × 200 vertices         | ≤ 250 ms, and the project file stays within the measured size budget                        |
| Resume after a crash mid-job                                   | 100% of finished windows reused; output identical to an uninterrupted run                   |
| Rasteriser byte-equality                                       | Holds on macOS arm64, Windows x64 and Linux x64 for both implementations                    |
| Anamorphic and rotated sources                                 | Mask drawn on the monitor matches the export within the oracle thresholds                   |

## Runtime parity (per model and execution provider)

| Gate                                                  | Threshold                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| ONNX vs PyTorch reference, SAM 2.1 Hiera-L video path | Per-frame IoU ≥ 0.999 on every parity clip                      |
| ONNX vs PyTorch reference, BiRefNet_HR-matting        | Mean absolute alpha difference ≤ 1/255 in the band, max ≤ 4/255 |
| Failing (model, EP) pair                              | Disabled; the next EP in the chain is used and recorded         |

## Harness

`workers/smart-mask/eval/run_eval.py` runs the **installed, signed entrypoint** (not Python
imports), as `visual-describe/eval` does, and scripts the correction-convergence gate by replaying
the minimal corrective clicks and brushes a labeller recorded. It writes
`reports/smart-mask/<date>-<platform>.json` plus a contact sheet (composite over magenta
and over a text layer, matte, error heat map, flagged-vs-actual-error overlay) for human review.
Reports are committed, so later sessions read recorded numbers instead of re-running.
