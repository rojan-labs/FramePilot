# Visual Describe — third-party licenses

**Status: hand review, COMPLETE.** Every artifact has been fetched and pinned, so each row
below names the exact file its licence applies to, and each licence was read on the
artifact itself rather than inferred from an upstream repository.

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

The runtime arrives as one release tarball, pinned by a single digest before anything is
unpacked, out of which the CLI and its nine dylibs are extracted and pinned individually.

| Artifact | File | License | Verified | SHA-256 |
| --- | --- | --- | --- | --- |
| llama.cpp b10840 release, macOS arm64 | `llama-runtime-macos-arm64.tar.gz` | MIT | ✅ the `LICENSE` inside the artifact is the MIT text, "Copyright (c) 2023-2026 The ggml authors" | `848b6cc2817aa09e615fed0813b01fc3abbc43cd4d4773cc4aff4d7ef5733784` |
| llama.cpp multimodal CLI | `llama-mtmd-cli` | MIT | ✅ member of the tarball above | `b61a6f2b996b6068f36399ac5b54503856071596aef5ff3e665d311ead7e7884` |
| llama.cpp / ggml runtime libraries (9) | `libmtmd`, `libllama`, `libllama-common`, `libggml{,-base,-cpu,-blas,-metal,-rpc}` | MIT | ✅ members of the tarball above; digests in `pack/models.lock.toml` | see lock |
| SmolVLM2-2.2B-Instruct, Q4_K_M GGUF | `SmolVLM2-2.2B-Instruct-Q4_K_M.gguf` | Apache-2.0 | ✅ declared by the QUANTISING repository (`ggml-org/SmolVLM2-2.2B-Instruct-GGUF`), not only the base model | `0cf76814555b8665149075b74ab6b5c1d428ea1d3d01c1918c12012e8d7c9f58` |
| SmolVLM2-2.2B-Instruct projector, f16 | `mmproj-SmolVLM2-2.2B-Instruct-f16.gguf` | Apache-2.0 | ✅ same repository and revision | `db9a3a1648cab1ebc3af4a2b0c8145dd8faebf6f7dd7b16e7dc1842229f14ac4` |
| SmolVLM2-500M-Video-Instruct, Q8_0 GGUF | `SmolVLM2-500M-Video-Instruct-Q8_0.gguf` | Apache-2.0 | ✅ declared by `ggml-org/SmolVLM2-500M-Video-Instruct-GGUF` | `6f67b8036b2469fcd71728702720c6b51aebd759b78137a8120733b4d66438bc` |
| SmolVLM2-500M-Video-Instruct projector, f16 | `mmproj-SmolVLM2-500M-Video-Instruct-f16.gguf` | Apache-2.0 | ✅ same repository and revision | `b5dc8ebe7cbeab66a5369693960a52515d7824f13d4063ceca78431f2a6b59b0` |

Copyright holders:

- **llama.cpp / `llama-mtmd-cli` and the ggml runtime libraries** — Georgi Gerganov and the ggml authors
- **SmolVLM2 (all four artifacts)** — Hugging Face

Three verifications mattered more than the rest and were not waved through. All three are
settled, and here is what settled them:

1. **The GGUF quantisation and the mmproj export, not just the upstream model card.** Both
   `ggml-org` GGUF repositories declare `license: apache-2.0` on the repository publishing
   the quantised artifacts themselves — so the terms come from the party that produced
   these bytes, which is the distinction that matters. Base models
   (`HuggingFaceTB/SmolVLM2-*`) are Apache-2.0 as well.
2. **The llama.cpp RELEASE artifact.** The macOS arm64 tarball at `b10840` contains only
   `llama-*` executables, the `libggml-*`/`libllama*`/`libmtmd` family, and one `LICENSE`
   — no bundled BLAS or CUDA redistributables. `libggml-blas` links Apple's Accelerate
   framework, which is a system framework and is not redistributed. The `LICENSE` inside
   the artifact is the MIT text, and it travels inside the pack.
3. **The runtime binary is executed over customer footage.** That is a larger trust
   decision than any weight, which is why it is pinned, hashed and refused-when-mismatched
   by exactly the same rule — and why "it came from the release page" is not verification.
   The same reasoning extends the pins to the nine dylibs: `llama-mtmd-cli` is an 83 KiB
   shim, and every byte that actually decodes a frame and runs the model lives in the
   libraries it loads out of its own directory.

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
