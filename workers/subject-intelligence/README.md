# FramePilot Subject Intelligence Capability Pack

Face, person and object detection plus subject segmentation masks, shipped as a
signed on-demand Capability Pack (ADR 0114). **Not** part of the base installer,
not a member of the root workspace, and never imported by `framepilot_engine`.

Capabilities: `subject.detect`, `subject.segment`.

## Why these models

The pack needed detection and segmentation under a commercially permissive
licence, on Apple Silicon macOS and Windows x64, with no payload in the base
installer. Three constraints decided it:

| | Choice | Licence |
| --- | --- | --- |
| Faces | YuNet (`face_detection_yunet_2023mar`) | MIT |
| People and objects | YOLOX-S (`object_detection_yolox_2022nov`) | Apache-2.0 |
| Segmentation | PPHumanSeg (`human_segmentation_pphumanseg_2023mar`) | Apache-2.0 |

1. **Licence.** The obvious default — YOLOv8/YOLO11 through Ultralytics — is
   **AGPL-3.0**, whose network-copyleft terms are wrong for a shipped desktop
   product. It was rejected on licence grounds, not accuracy. Everything above is
   MIT or Apache-2.0, and each model's upstream `LICENSE` is recorded in
   `pack/models.lock.toml` and reproduced in `LICENSES.md`.
2. **Runtime.** All three run on OpenCV's `dnn` module. This pack therefore adds
   **no second ML runtime** — no ONNX Runtime, no PyTorch, no PaddlePaddle — and
   reuses a native dependency already licence-audited for Tracking Lite.
3. **Size.** ~42 MiB of weights, against a budget that anticipated 150 MiB–1.5 GiB.

Each was verified on real photographic content before selection: YuNet found 58
faces and YOLOX 44 people in the pinned group photo, and PPHumanSeg produced a
47%-foreground person matte inside a prompted region.

## Honesty rules

The pack refuses to return something that merely looks like an answer:

- detections below the confidence floor are dropped, and **finding nothing
  returns nothing** — there is no fallback centre-frame box;
- a **point prompt is resolved against a real person detection**, never expanded
  into a guessed rectangle; nobody there is `target_lost`;
- an empty or near-empty mask is `target_lost`, not an all-zero "mask";
- every pinned model is hashed before loading, and its digest is reported in the
  handshake and in every result, so an edit's lineage names the exact weights.

## Layout

```
pack/models.lock.toml   pinned model URLs, sha256 digests, licences
tools/fetch_models.py   downloads + verifies weights (never committed)
tools/generate_sbom.py  generates LICENSES.md and the CycloneDX SBOM
src/…/protocol.py       dependency-free mirror of the frozen worker protocol
src/…/policy.py         what the pack will and will not claim
src/…/opencv_backend.py the real inference backend
```

## Tests

Two tiers, deliberately separate:

```bash
uv run pytest                                   # policy/protocol; no CV, no weights
uv run --extra cv pytest -m decoded_media       # real models on real pixels
```

The second tier needs the weights:

```bash
uv run python tools/fetch_models.py             # verifies every digest
```
