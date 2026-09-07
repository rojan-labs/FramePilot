# 09 — The evidence ledger: every number this plan has actually measured

One page, so a reader never has to trust a claim made in a commit message. Anything not in
this file has not been measured, however plausible it sounds. Dates are when the number was
produced; the branch is `plan/visual-understanding`.

## The floor (VU0.1, 2026-09-07)

Read off the per-turn tool-call records of **ten recorded runs — 318 scored turns, 210
accepted edits** — under `reports/golden/*/cases/`. **No case was re-run to produce it**;
reproduce with `node packages/ai-sdk/scripts/perception-baseline.mjs <runDir>…`.

| Metric                                                                 | Floor                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `get_frame` calls                                                      | **0** — the agent has never looked at a frame, in any recorded run |
| `search_visual` + `describe_footage` + `map_footage` + `measure_color` | **0**, in every run                                                |
| `get_timeline` / `get_timeline_summary`                                | 192                                                                |
| grade/transition operations with a measured basis                      | **0 of 3** ⇒ guess rate **1.00**                                   |
| clip rows carrying a picture fact                                      | **0%**                                                             |

An earlier reading of this repo reported "13 `get_frame`" by grepping report prose. Those
were words in summaries, not calls. The measured figure is zero.

## VU1 — tier 0

| Claim                                   | Result                                                                                                          | Where                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 160 px is lossless for these statistics | full-res vs 160 px: YAVG **74.0424 vs 74.0471**, UAVG **162.161 vs 162.164**; test tolerance is one 8-bit level | `test_shot_stats_accuracy.py` |
| Speed                                   | `talk-1080p-98s` **47×** real-time; `vertical-30s` **17×** (M1 Pro)                                             | measured by hand              |
| A locked-off interview reads correctly  | 4 shots, all duration splits, static, warmth within ±0.01                                                       | `test_shot_stats_accuracy.py` |
| A fast-cut vertical reads correctly     | 42 shots, mixed motion, cool opening (−0.6) settling to neutral, both sections distinguishable                  | same                          |
| Keyless indexing writes rows            | an index request with no key produces `shots.measured`, reports coverage, `reason` stays null                   | `test_service_shot_ledger.py` |

Three things were measured rather than assumed, and **two of them changed the code**:
`blurdetect` is higher-is-blurrier (4.2 sharp vs 13.1 at `gblur=sigma=6`), so sharpness
inverts it; warmth needed half the chroma range, not a quarter, because a quarter pinned
every shot of the vertical fixture at exactly −1.00; and motion must be sampled at the
native frame rate, because at 2 fps every clip reads `fast`.

## VU2 — model surfaces

| Claim                         | Result                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------- |
| An unindexed project's prompt | **byte-identical**; every token golden passes **unregenerated**; delta **0**  |
| Digest cost                   | ~**108 tokens** once per turn                                                 |
| Row suffix cost               | ~**10 tokens** per covered clip, hard-capped at ~23                           |
| A fully covered 12-clip layer | about **one eighth of a single `get_frame`**                                  |
| Clip-count bound              | unchanged — the slice grows by a bounded suffix per shown row, never by a row |
| `pictureFactsInPrompt`        | **0.5** on a half-covered layer, **0** with no ledger                         |

## VU2.5/VU3.2/VU4.2 — the tool surface

| Surface            | Before | After | Delta                   |
| ------------------ | ------ | ----- | ----------------------- |
| Core (default run) | 7342   | 7481  | **+139 tokens/request** |
| All domains pinned | 15006  | 15886 | **+880 tokens/request** |

The four new tools account for 826 of the +880 (`match_color` 186, `normalize_exposure` 133,
`apply_look` 214, `add_transitions` 293). The +139 on the core surface is entirely VU2.5:
`get_clip`, `get_clips` and `list_edit_boundaries` are core tools. Regenerated with the
repo's own three commands; no golden was hand-edited.

## VU8 — scale and operations (2026-09-07, M1 Pro, 10 cores / 16 GB)

| Claim                                    | Result                                                                                                                                                                       | Produced by                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Tier-0 speed on real footage             | 177.8 s of fixture footage measured in **6.04 s** — **29.4× real-time** aggregate (46.5× `talk-1080p-98s`, 22.9× `b4-1080p-50s`, 17.0× `vertical-30s`)                        | `measure_asset` against the mission fixtures, timed             |
| Ledger row size                          | `measured` JSON **416 B/shot**; **643 B/row** marginal on disk (640–664 B over four 2,400-row steps, real row content re-keyed)                                              | real rows written to a real `brain.sqlite`, file size differenced |
| A 10-hour library needs no eviction      | **≈6.3 MB** at 16.2 shots/footage-minute; **≈32 MB** at the fast-cut vertical's 84/min. The plan's ~1.5 KB/shot is ~2.3× conservative                                        | arithmetic on the two measurements above                        |
| `tier_coverage` at library scale         | **3.3 ms** over 12,000 rows                                                                                                                                                  | same fixture ledger                                             |
| Kill and resume                          | SIGKILL **4.63 s into an 11.58 s slice**: request dies, **2 rows** on disk (no partial asset), restarted sidecar resumes to **272 rows identical to a clean run**            | two real sidecars, `os.killpg(SIGKILL)`, row-by-row comparison  |
| A tier-version bump re-queues one column | tier-1 rows at `TIER1_VERSION - 1` nulled; `measure_asset` not called again; geometry and `measured` untouched                                                               | `tests/test_index_governor.py`                                  |
| Indexing steps aside for foreground work | a slice posted while `/render/frame` is held open moves no cursor, writes no shot, and says `deferred while a frame grab is in flight` in `tiers` — never in `reason`        | `tests/test_index_governor.py`, a real held-open route          |

## What is NOT measured, and why

| Gap                                                                                                                      | Why it is open                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The behavioural payoff.** Whether first-pass acceptance, target resolution or cost per accepted edit actually improve. | Needs a live golden run against a real provider — hours and money. The maintainer spends that, not an agent. Every number above is static or offline.                                                                                                                                                        |
| **Threshold correctness.** Whether "dim", "warm", "handheld" and "soft" match what an editor would say.                  | Needs the hand-labelled classes (VU0.2). The machine-checkable half — that the 160 px downscale measures what full resolution measures — is done and is what actually protects the pipeline. A threshold tuned against a machine-proposed label would be measuring itself.                                   |
| **The colour response curves.**                                                                                          | `packages/ai-sdk/scripts/fit-color-response.mjs` runs the real fit against a live sidecar. All three response constants sit at 1.0, the no-clipping value; the fit will move them below. **No test asserts a fitted number** — freezing a provisional coefficient would turn a guess into a regression gate. |
| **`match_color`'s correction loop.**                                                                                     | A mutating tool builds operations synchronously and cannot await a render, so it reports the pre-grade gap and tells the model to re-measure. The re-measure-and-correct cycle belongs to VU3.3.                                                                                                             |
| **VU8's 10-hour library, 1,000-asset project, and the frame-time probe.**                                                | The library needs hours of re-encoding to build; the 1,000-asset run-start and picture-slice paths live in `packages/ai-sdk`, outside this phase; the frame-time probe needs the renderer in `apps/`. The extrapolation from the real 29.4× rate is arithmetic and is labelled as such in `07-SCALE-AND-OPERATIONS.md`, not as a run. |
| **Import-during-render throughput.**                                                                                     | The pause mechanism is tested against a real held-open route; the "within 5% of baseline" half needs a baseline export on a loaded machine.                                                                                                                                                                                          |
| **Tier 2 under real memory pressure.**                                                                                   | The refusal rule is tested with an injected memory reader. Filling 16 GB to exercise the real reader is a machine-wide experiment, not a test.                                                                                                                                                                                       |
| **Everything from VU5 onward.**                                                                                          | Tier 1 and tier 2 packs, sampled verification, scale. Not started.                                                                                                                                                                                                                                           |

## Standing rule

A number in this file was produced by running something. A number anywhere else in this plan
is a target. If the two ever disagree, this file is wrong and should be re-measured, not
edited to match.
