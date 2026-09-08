# 08 — Remove, defer, ask, risk

## Remove

| What                                                                                                                     | Why                                                                                                          | When |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---- |
| The key gate on indexing (`shouldAutoIndex`, `enrolStockAsset` key check, the embedder short-circuit in the index route) | it is the root cause of blindness on the default install                                                     | VU1  |
| Free-text `CAPTION_INSTRUCTION`                                                                                          | replaced by one structured schema for local, hosted and TL                                                   | VU6  |
| Per-path enrolment (renderer hook + stock enroller with separate rules)                                                  | one import hook, one enroller                                                                                | VU1  |
| `get_frame` as a planning habit in skills and the contract                                                               | it stays as a verification/dev tool; skills stop suggesting it for "see what is there" once rows carry facts | VU2  |
| ~~`_SIMILAR_GROUP_SPAN_CAP` pairwise duplicate scan~~ **DONE 2026-09-07**                                                | replaced by `brain/duplicates.py`, a 64-bit multi-index bucket; the cap is gone, nothing is approximated      | VU5  |

## Deprecate (maintainer decision)

- **NVIDIA hosted embeddings (ADR 0066).** Once the local pack ships, the hosted arm is a
  worse default: it costs a key, sends frames off-machine and produces vectors in a space the
  local model cannot search. Proposal: keep for one release behind the existing key, then
  remove the arm and the Settings subtab. Decision required.
- **TwelveLabs as a general backend (ADR 0070/0071/0134).** Keep as an optional hosted tier 2
  producer writing `described.summary`. Do not extend it. Decision: keep, no expansion.

## Defer (explicitly out of scope)

| Item                                                    | Where it belongs                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| Segmentation, depth, per-frame tracking, mattes         | `plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` P3+                     |
| OCR beyond what the VLM reads                           | later tier, only if a golden case needs it                            |
| Audio event tagging (applause, laughter, music genre)   | separate ledger column later; loudness per shot is in tier 0          |
| Per-region or masked color grading, LUT export          | color v2 after VU3 evidence                                           |
| Location naming from GPS/EXIF                           | tier 1 metadata pass later                                            |
| A "footage bible" document UI                           | the digest is model-facing; a human view only after the agent uses it |
| Browser build parity                                    | no sidecar; accepted per CLAUDE.md                                    |
| Cross-project entity memory ("this is always the host") | `brain/soul.py` promotion path, after entities exist                  |

## Ask before acting (CLAUDE.md §5)

| Item                                                                                                              | Ask                                                                                                                                 | Proposed answer                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Brain migration v4 (`shots`, `entities`, `asset_digest`)                                                          | schema change in the derived store                                                                                                  | approve; append-only; not the project schema                            |
| New workers `visual-embed`, extension of `subject-intelligence`                                                   | new dependencies: onnxruntime (MIT), OpenCV headless (Apache-2.0), model weights (SigLIP 2 Apache-2.0, YuNet MIT, SFace Apache-2.0) | approve after `pnpm license:scan`; weights pinned in `models.lock.toml` |
| New worker `visual-describe`                                                                                      | llama.cpp (MIT) binary + SmolVLM2 GGUF (Apache-2.0)                                                                                 | approve; excluded models listed in `05`                                 |
| Removing the key gate                                                                                             | changes the privacy statement: frames never leave without a key still holds; local decode always runs                               | approve; update the guide's privacy section                             |
| Deprecating NVIDIA hosted embeddings                                                                              | product decision                                                                                                                    | maintainer                                                              |
| `GET /brain/shots` read route                                                                                     | new sidecar surface, read-only, sandboxed                                                                                           | approve                                                                 |
| Tool additions `match_color`, `normalize_exposure`, `apply_look`, `add_transitions`; `reason` on `add_transition` | model-facing surface                                                                                                                | approve; each needs a domain (tool-domains shape test)                  |

## Risks and mitigations

| Risk                                                              | Mitigation                                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Tier 0 words are wrong on unusual footage (night, snow, stylised) | thresholds calibrated on fixtures and printed in one block; words gated by confidence where a label; the solver reads numbers, not words |
| Zero-shot labels confidently wrong                                | `p ≥ 0.6` gate for printing; described tier can override; golden accuracy targets before enabling by default                             |
| VLM hallucination                                                 | closed-list fields where possible, `onScreenText` verbatim, `p` bucketed, never a gate; verification is deterministic first              |
| Prompt growth                                                     | row suffix ≤ 90 chars, digest ≤ 600 tokens, both measured in VU2.7 and gated by the golden gate                                          |
| Background indexing hurts editing                                 | governor pauses on render/frame/evidence; scale tests in 07 with a frame-time probe                                                      |
| Windows/Linux without Metal                                       | tier 2 CPU-only is slow; it is the lowest-priority tier and skippable; tiers 0/1 are fast everywhere                                     |
| Two vector spaces (NVIDIA vs local) in one project                | existing per-model keying; the search uses the space with coverage; deprecation removes the ambiguity                                    |
| Renderer changes silently break the color fit                     | the fit test re-derives coefficients from fixtures and fails on drift                                                                    |
| Scope creep into scene understanding                              | this plan stops at shot-level facts; segmentation/depth are explicitly deferred                                                          |
| The plan is written and not measured (the history of this area)   | VU0 baseline is the first task; every phase has a numeric exit recorded in its file                                                      |

## Discovered while implementing (2026-09-07)

| Finding                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                                                 | Status                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`translateSourceRange` assumes 1:1 playback speed**, and its comment says "no `speedRamps` op exists yet". `speedRamp` has been in the schema since v15 (`timeline-schema/src/index.ts:762`) and `set_clip_speed_ramp` is a shipped tool. So the semantic index's `shots`, `silences` and `beats` slices place their times WRONG on any speed-changed or reversed clip — a pre-existing bug, not one this plan introduced. | `packages/ai-sdk/src/kernel/semantic-index/semantic-index.ts:410–423` | Open. The `picture` slice does its own speed-aware projection (integrating `speedRamp` through `integrateRate`, mirroring reverse, holding a freeze), so the ledger is correct today while the older slices are not. Converge them onto one projection in VU2.5. |
| **`brain/__init__.py` already exports an `AssetDigest`** from `brain/similar.py`, unrelated to the ledger's. The ledger models are therefore imported from `brain.ledger_models` directly and are NOT re-exported.                                                                                                                                                                                                           | `engine/python/framepilot_engine/brain/__init__.py:93`                | Decided: no re-export. The `GET /brain/shots` route imports from the module. Renaming a shipped public name to make a barrel tidier is not worth a migration.                                                                                                    |
| **`lowQualityShots` had no threshold anywhere in the plan.** `LOW_SHARPNESS = 0.4` was derived from the two blur measurements recorded in `shot_stats.py` (sharp 4.2 → 0.74, gblur sigma 6 → 0.18).                                                                                                                                                                                                                          | `brain/ledger_store.py`                                               | First calibration; VU1.6's hand-labelled sharpness classes confirm or move it.                                                                                                                                                                                   |
| **A pre-existing UI transition suggester picks by hardcoded id** (`suggest('cross-dissolve', …)`), timeline-only by design.                                                                                                                                                                                                                                                                                                  | `apps/web-editor/src/components/transition-recommendations.ts`        | Converge onto the policy in VU4.2, once the ledger is populated — not before, or the UI would suggest from facts that do not exist yet.                                                                                                                          |

## Licence position for VU5/VU6 (recorded 2026-09-07)

`pnpm license:scan` was run on this tree: **7 packages checked, no denylisted licences**.

**That result does not clear the VU5/VU6 dependencies, and must not be quoted as if it
did.** `scripts/license-scan.mjs` walks `node_modules` package manifests only. It does not
see Python packages, native binaries, or model weights — which is the entire surface those
two phases add. The gate is real for what it covers and silent about what matters here.

So the VU5/VU6 licences are a hand review, to be completed and recorded in each worker's
`LICENSES.md` at the time it is added, with the hash pinned in its `models.lock.toml`:

| Component                                     | Phase | Licence to verify at add time | Notes                                                                             |
| --------------------------------------------- | ----- | ----------------------------- | --------------------------------------------------------------------------------- |
| onnxruntime                                   | VU5   | MIT                           | already an OPTIONAL engine extra (`embeddings`); the pack worker gets its own pin |
| opencv-contrib-python-headless                | VU5   | Apache-2.0                    | already used by `workers/subject-intelligence` under the `cv` extra               |
| SigLIP 2 base patch16-224 (ONNX export)       | VU5   | Apache-2.0                    | verify the EXPORT's licence, not only the upstream model card                     |
| CLIP ViT-B/32 (fallback)                      | VU5   | MIT                           | only if SigLIP 2's export is unusable                                             |
| YuNet (OpenCV Zoo)                            | VU5   | MIT                           | ~0.3 MB                                                                           |
| SFace (OpenCV Zoo)                            | VU5   | Apache-2.0                    | ~37 MB                                                                            |
| llama.cpp (`llama-server` / `llama-mtmd-cli`) | VU6   | MIT                           | binary ships in the pack, like `whisper-cli` today                                |
| SmolVLM2-2.2B-Instruct GGUF + mmproj          | VU6   | Apache-2.0                    | default; ~1.5 GB resident                                                         |
| SmolVLM2-500M-Instruct GGUF                   | VU6   | Apache-2.0                    | low-RAM machines                                                                  |

**Excluded on licence grounds, decided now so nobody re-opens it mid-phase:** Qwen2.5-VL
(research-only terms) and Gemma 3 (Gemma terms). Neither may be the default nor an option.

**A precedent worth naming:** the engine already ships `twelvelabs` with NO declared licence
at all, adopted with the maintainer's explicit acceptance (ADR 0071) and redistributed
through PyInstaller. That was a considered exception. It is not a template — every component
above has a real licence and must keep one.

### The deprecations still owed, and what gates each

| Deprecation                                             | Gated on | Why it cannot be done sooner                                                                                               |
| ------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| The NVIDIA hosted-embeddings arm (ADR 0066)             | **VU5**  | Removing it before the local pack ships would delete the only tier-1 producer and leave the product with no labels at all. |
| Free-text captions (`CAPTION_INSTRUCTION`)              | **VU6**  | The structured schema needs a producer. Deleting the prose captioner first leaves `describe_footage` with nothing.         |
| ~~The pairwise duplicate scan (`_SIMILAR_GROUP_SPAN_CAP`)~~ **DONE 2026-09-07** | **VU5** | Deleted along with its cap, replaced by `brain/duplicates.py`. `duplicateOf` is populated by the local tier-1 arm. |

The two deprecations that were NOT gated — the key gate and the per-path enrolment hooks —
are **deleted** as of `dc5809f`: implementation, settings surface, config key (with a
drop-on-load migration), docs and tests, in one change.
