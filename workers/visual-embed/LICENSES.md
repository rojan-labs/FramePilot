# Visual Embed — third-party licenses

**Status: hand review, PARTIALLY COMPLETE.** Only YuNet's licence and digest are carried
over from a verified pin (`workers/subject-intelligence`). Every other row below records
the licence the model card *states*, with the verification still owed — and the digests
that would prove which artifact the licence applies to are still placeholders. No weight
has been downloaded for this pack.

`pnpm license:scan` was run on this tree and reported **7 packages checked, no denylisted
licences**. That result does **not** clear anything on this page: `scripts/license-scan.mjs`
walks `node_modules` package manifests only. It cannot see Python distributions, native
binaries or model weights — which is the entire surface this pack adds. Quoting it as
clearance for these models would be a false claim, and the plan
(`plan/visual-understanding/08-REMOVE-DEFER-RISKS.md`) says so explicitly.

## Model weights

Downloaded at pack build time from a URL pinned to an immutable revision and verified
against the digests in `pack/models.lock.toml`. They are never committed to the repository
and never enter the base installer.

| Model | File | License | Verified | SHA-256 |
| --- | --- | --- | --- | --- |
| SigLIP 2 base patch16-224 — vision tower (ONNX) | `siglip2_base_patch16_224_vision.onnx` | Apache-2.0 (stated) | ❌ pending | pending |
| SigLIP 2 base patch16-224 — text tower (ONNX) | `siglip2_base_patch16_224_text.onnx` | Apache-2.0 (stated) | ❌ pending | pending |
| SigLIP 2 tokenizer | `siglip2_tokenizer.json` | Apache-2.0 (stated) | ❌ pending | pending |
| YuNet | `face_detection_yunet_2023mar.onnx` | MIT | ✅ verified for `workers/subject-intelligence`, same pinned commit and digest | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| SFace | `face_recognition_sface_2021dec.onnx` | Apache-2.0 (stated) | ❌ pending | pending |

Copyright holders:

- **SigLIP 2 (all three artifacts)** — Google LLC
- **YuNet** — Shiqi Yu and contributors; OpenCV Zoo
- **SFace** — Zhong Yaoyao and contributors; OpenCV Zoo

Two verifications matter more than the rest and must not be waved through:

1. **The SigLIP 2 ONNX export, not just the upstream model card.** A re-export published
   by a third party can carry different terms from the weights it was converted from. The
   licence that governs this pack is the one on the artifact the build job downloads.
2. **SFace's licence file at the pinned commit.** It is recorded as Apache-2.0; the
   `LICENSE` at `face_recognition_sface/` in the pinned OpenCV Zoo commit is what settles
   it, exactly as YuNet's did.

**Excluded on licence grounds, decided and closed:** Qwen2.5-VL (research-only terms) and
Gemma 3 (Gemma terms). Neither may be the default nor an option. CLIP ViT-B/32 (MIT) is
the recorded fallback if the SigLIP 2 export proves unusable — a replacement, never a
second shipped model.

## Python distributions

Resolved versions come from `uv.lock` once the `cv` extra is synced; until then these are
the licences of the pinned ranges in `pyproject.toml`.

| Component | Range | License |
| --- | --- | --- |
| `onnxruntime` | `>=1.20,<2` | MIT |
| `tokenizers` | `>=0.20,<1` | Apache-2.0 |
| `opencv-contrib-python-headless` | `>=5.0,<6` | Apache-2.0 |
| `numpy` | `>=2.1` | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |

## Native libraries redistributed inside the wheels

The OpenCV wheel redistributes FFmpeg and, on macOS, a set of support libraries under
**LGPL-2.1-or-later**; the full list, and the obligations it carries, are enumerated in
`workers/subject-intelligence/LICENSES.md` and apply identically here because it is the
same wheel. onnxruntime's wheels bundle their own third-party notices (`ThirdPartyNotices.txt`),
which the pack artifact must carry.

## Obligations this pack carries

- **Model attribution.** Apache-2.0 and MIT both require this notice to travel with the
  binaries, which is why it ships inside the pack artifact and is surfaced in the catalog
  record before a user approves the download.
- **Apache-2.0 NOTICE files.** Where an upstream artifact ships a `NOTICE`, it must be
  reproduced in the pack, not merely linked.
- **LGPL-2.1-or-later components are redistributed** inside the OpenCV wheel. They must
  stay separate dynamically linked binaries inside the pack artifact, never statically
  folded in, and FramePilot must offer their corresponding source. The pack is an isolated
  process, not a link-time dependency of the editor, so FramePilot's own code is unaffected.
- **No copyleft weight may ever enter this pack.** The AGPL-3.0 detection default
  (Ultralytics YOLO) was rejected on this ground for Subject Intelligence; the same rule
  binds here.

The catalog record for this pack must surface the LGPL obligation, a source-offer URL, and
the model provenance above before a user approves the download.
