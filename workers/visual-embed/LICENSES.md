# Visual Embed — third-party licenses

**Status: hand review, ONE ROW OUTSTANDING.** Every weight has now been fetched and
pinned, so each row below names the exact artifact its licence applies to. YuNet and SFace
are verified against the `LICENSE` files at the pinned OpenCV Zoo commit. The three SigLIP
rows are **not** cleared: see "The SigLIP 2 export declares no licence" below, which is a
decision recorded openly rather than a box ticked.

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
| SigLIP 2 base patch16-224 — vision tower (ONNX) | `siglip2_base_patch16_224_vision.onnx` | Apache-2.0 **inherited**, export asserts none | ❌ open — see below | `c0573e3f4140c3a7c4e9cc5912bd6b26a033b46a6a8e8af26cbea262b163bcad` |
| SigLIP 2 base patch16-224 — text tower (ONNX) | `siglip2_base_patch16_224_text.onnx` | Apache-2.0 **inherited**, export asserts none | ❌ open — see below | `baf12d941beabafafb14f7b4adb38dc15be18681b964a84410ec53d9d65e6293` |
| SigLIP 2 tokenizer | `siglip2_tokenizer.json` | Apache-2.0 **inherited**, export asserts none | ❌ open — see below | `cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322` |
| YuNet | `face_detection_yunet_2023mar.onnx` | MIT | ✅ verified for `workers/subject-intelligence`, same pinned commit and digest | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| SFace | `face_recognition_sface_2021dec.onnx` | Apache-2.0 | ✅ verified — `models/face_recognition_sface/LICENSE` at OpenCV Zoo `47534e2` is the Apache-2.0 text | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |

### The SigLIP 2 export declares no licence

This is the row that must not be waved through, so here is exactly where it stands.

`google/siglip2-base-patch16-224` — the Apache-2.0 upstream — publishes **safetensors
only**. It hosts no `onnx/` directory, so the URL this pack used to carry could never have
resolved against any revision. The ONNX export the onnxruntime backend needs is published
separately, by the transformers.js team, at
`onnx-community/siglip2-base-patch16-224-ONNX`, pinned here at commit
`ba1f3b0843f24bc5417d38e19c37b287d719b2f4`.

That export's model card declares **no licence of its own**. It records
`base_model: google/siglip2-base-patch16-224` and nothing else. So the Apache-2.0 in the
table is inherited from the weights that were converted, not asserted by the party
publishing these bytes — which is precisely the distinction this page insists on.

The maintainer's decision (2026-09-07) was to pin this export and record the gap in the
open rather than block the pack on it, on the grounds that a re-export from an unknown
individual's repository that *does* declare Apache-2.0 is worse provenance, not better.
The row stays ❌ until the export's terms are confirmed with the publisher. **CLIP
ViT-B/32 (MIT) remains the recorded replacement** if that confirmation comes back
negative — a swap, never a second shipped model.

Copyright holders:

- **SigLIP 2 (all three artifacts)** — Google LLC
- **YuNet** — Shiqi Yu and contributors; OpenCV Zoo
- **SFace** — Zhong Yaoyao and contributors; OpenCV Zoo

Two verifications mattered more than the rest and were not waved through. SFace's is now
settled — the `LICENSE` at `face_recognition_sface/` in the pinned OpenCV Zoo commit is
the Apache-2.0 text, exactly as YuNet's was. The SigLIP 2 export's is not, and has its own
section above.

**Excluded on licence grounds, decided and closed:** Qwen2.5-VL (research-only terms) and
Gemma 3 (Gemma terms). Neither may be the default nor an option.

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
