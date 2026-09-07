# Visual Describe — third-party licenses

**Status: hand review, NOT STARTED.** Every row below records the licence the upstream
model card or repository *states*, with the verification still owed — and the digests that
would prove which artifact the licence applies to are all placeholders. Nothing has been
downloaded for this pack.

`pnpm license:scan` was run on this tree and reported **7 packages checked, no denylisted
licences**. That result does **not** clear anything on this page: `scripts/license-scan.mjs`
walks `node_modules` package manifests only. It cannot see Python distributions, native
binaries or model weights — which is the entire surface this pack adds. Quoting it as
clearance for these artifacts would be a false claim, and the plan
(`plan/visual-understanding/08-REMOVE-DEFER-RISKS.md`) says so explicitly.

## Model weights and the native runtime

Downloaded at pack build time from a URL pinned to an immutable revision and verified
against the digests in `pack/models.lock.toml`. They are never committed to the repository
and never enter the base installer.

| Artifact | File | License | Verified | SHA-256 |
| --- | --- | --- | --- | --- |
| llama.cpp multimodal CLI | `llama-mtmd-cli` | MIT (stated) | ❌ pending | pending |
| SmolVLM2-2.2B-Instruct, Q4_K_M GGUF | `SmolVLM2-2.2B-Instruct-Q4_K_M.gguf` | Apache-2.0 (stated) | ❌ pending | pending |
| SmolVLM2-2.2B-Instruct projector, f16 | `mmproj-SmolVLM2-2.2B-Instruct-f16.gguf` | Apache-2.0 (stated) | ❌ pending | pending |
| SmolVLM2-500M-Video-Instruct, Q8_0 GGUF | `SmolVLM2-500M-Video-Instruct-Q8_0.gguf` | Apache-2.0 (stated) | ❌ pending | pending |
| SmolVLM2-500M-Video-Instruct projector, f16 | `mmproj-SmolVLM2-500M-Video-Instruct-f16.gguf` | Apache-2.0 (stated) | ❌ pending | pending |

Copyright holders:

- **llama.cpp / `llama-mtmd-cli`** — Georgi Gerganov and llama.cpp contributors
- **SmolVLM2 (all four artifacts)** — Hugging Face

Three verifications matter more than the rest and must not be waved through:

1. **The GGUF quantisation and the mmproj export, not just the upstream model card.** A
   re-quantised or re-exported artifact published by a third party can carry different
   terms from the weights it was converted from. The licence that governs this pack is the
   one on the artifact the build job downloads.
2. **The llama.cpp RELEASE artifact.** The repository is MIT; the prebuilt binary in a
   release may bundle other components (BLAS backends, CUDA/Metal shims) with their own
   terms. Whatever the macOS arm64 release actually contains is what has to be cleared,
   and its notices have to travel inside the pack.
3. **The runtime binary is executed over customer footage.** That is a larger trust
   decision than any weight, which is why it is pinned, hashed and refused-when-mismatched
   by exactly the same rule — and why "it came from the release page" is not verification.

**Excluded on licence grounds, decided and closed:** Qwen2.5-VL (research-only terms) and
Gemma 3 (Gemma terms). Neither may be the default nor an option, and this decision is not
to be re-opened mid-phase.

## Python distributions

Resolved versions come from `uv.lock` once the `cv` extra is synced; until then these are
the licences of the pinned ranges in `pyproject.toml`. There is deliberately **no ML Python
dependency**: inference is the pinned native binary.

| Component | Range | License |
| --- | --- | --- |
| `opencv-contrib-python-headless` | `>=5.0,<6` | Apache-2.0 |
| `numpy` | `>=2.1` | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |

## Native libraries redistributed inside the wheels

The OpenCV wheel redistributes FFmpeg and, on macOS, a set of support libraries under
**LGPL-2.1-or-later**; the full list, and the obligations it carries, are enumerated in
`workers/subject-intelligence/LICENSES.md` and apply identically here because it is the
same wheel.

## Obligations this pack carries

- **Model and runtime attribution.** Apache-2.0 and MIT both require this notice to travel
  with the binaries, which is why it ships inside the pack artifact and is surfaced in the
  catalog record before a user approves the download.
- **Apache-2.0 NOTICE files.** Where an upstream artifact ships a `NOTICE`, it must be
  reproduced in the pack, not merely linked.
- **LGPL-2.1-or-later components are redistributed** inside the OpenCV wheel. They must
  stay separate dynamically linked binaries inside the pack artifact, never statically
  folded in, and FramePilot must offer their corresponding source. The pack is an isolated
  process, not a link-time dependency of the editor, so FramePilot's own code is unaffected.
- **No copyleft weight may ever enter this pack.** The AGPL-3.0 detection default
  (Ultralytics YOLO) was rejected on this ground for Subject Intelligence; the same rule
  binds here.

The catalog record for this pack must surface the LGPL obligation, a source-offer URL, the
~1.6 GiB download size, and the model provenance above before a user approves the download.
