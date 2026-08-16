# Tracking Lite — FramePilot Capability Pack worker

Point, region, and planar tracking for the FramePilot editor, delivered as a
**signed, on-demand Capability Pack** rather than as part of the base installer
(ADR `docs/adr/0114-on-demand-capability-packs.md`).

This directory is a **separate artifact project**. It is not a member of the root
uv workspace, not a dependency of `framepilot_engine`, and not importable by the
Electron app. The base application ships the catalog, verifier, installer and
launcher; this worker is the payload those install on demand.

## Capabilities

| Capability        | Input                   | Algorithm                              | Confidence                                                         |
| ----------------- | ----------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `tracking.point`  | one normalized point    | pyramidal Lucas–Kanade flow            | patch matching error × forward–backward round-trip agreement       |
| `tracking.region` | one normalized box      | CSRT correlation filter                | measured appearance similarity against the initialization template |
| `tracking.planar` | four normalized corners | features + LK flow + RANSAC homography | inlier ratio × residual flow error                                 |

CSRT is why this pack depends on `opencv-contrib-python-headless` rather than the
smaller main-module wheel: verified against real wheels, `opencv-python-headless`
4.14.0.94 exposes no `TrackerCSRT` at all — only MIL plus trackers that require
model weights. See `LICENSES.md` for what the contrib wheel redistributes.

The roster is constant. Health mode refuses any signed identity advertising more
or fewer capabilities than these three.

## Honesty contract

A tracker reports what it measured; `policy.py` turns that into protocol samples:

- a real measurement is reported **at its measured position** with its measured
  confidence, flagged `occluded` below the occlusion threshold;
- a frame with **no** measurement holds the last known box with `confidence=0.0`
  and `occluded=true` — frozen, never extrapolated;
- holding is bounded to 15 consecutive frames, after which the request fails with
  the typed `target_lost` code naming the last measured frame.

The worker never invents motion it did not observe, never maps a boolean tracker
status to a confidence number, and never smooths. Smoothing, gap policy and
correction limits belong to the host, where they are versioned and invertible
alongside the timeline operation.

## Determinism

One OpenCV thread, OpenCL disabled, a fixed RNG seed, thread-count environment
pins, sorted feature ordering, and samples always emitted in ascending frame
order. The same media and request produce identical samples on the same platform
build.

## Isolation

- Networking is disabled by the worker itself at startup; media never leaves the
  machine.
- No project-write authority. Media paths are resolved and sandbox-checked by the
  desktop host and arrive as read-only handles.
- One request per process, bounded 1 MiB JSON lines, bounded progress, and
  exactly one terminal `result` or `failure`.

## Modes

```
framepilot-tracking-lite --framepilot-health-check    # one handshake JSON, exit 0
framepilot-tracking-lite --framepilot-worker-runtime  # JSON-line protocol on stdin/stdout
```

Health mode reads the approved identity the installer places in the environment
(`FRAMEPILOT_CAPABILITY_PACK_ID`, `_VERSION`, `_RELEASE_DIGEST`, `_CAPABILITIES`),
verifies the pack id and version against its own compiled-in identity, verifies
the capability roster exactly, probes the real backend, and echoes the digest it
cannot know about itself. See `docs/api/capability-pack-worker.md` for why.

## Development

The protocol, policy and tracker layers have **no third-party dependency**, so
the unit suite runs without a CV stack:

```bash
cd workers/tracking-lite
uv run --python 3.13 --with pytest --no-project pytest -q
uv run --python 3.13 --with ruff  --no-project ruff check .
uv run --python 3.13 --with mypy  --no-project mypy
```

Tests drive an injectable scripted backend (`tests/conftest.py`) that simulates a
subject on a known trajectory, so they assert real agreement with the subject's
motion and include wrong-trajectory negative controls.

Decoded-media proof against real pixels needs the `cv` extra and is opt-in:

```bash
uv sync  --extra cv --no-dev --locked
uv run   --extra cv --no-dev --with pytest pytest -m decoded_media
uv run   --extra cv --no-dev python tools/generate_sbom.py --check
```

That suite encodes a real MJPG video of a textured subject on a known
trajectory, decodes it through `cv2.VideoCapture`, and requires every capability
to recover the trajectory within 8 px — with mirrored-trajectory negative
controls, a run-to-run determinism check, and a vanishing-subject case that must
report loss rather than a confident invention. Never install the `cv` extra into
the base repository environment.

## Supply chain

- `uv.lock` is the authority for exact versions and wheel digests.
- `pack/manifest.toml` describes the pack identity, platforms, and entrypoints;
  `tools/generate_sbom.py --check` fails if it drifts from the identity the
  worker itself enforces at health check.
- `LICENSES.md` and `pack/sbom/*.cdx.json` are **generated**, never hand
  written, from installed distribution metadata plus `uv.lock` digests.
- The pack redistributes LGPL-2.1 native libraries (FFmpeg and, on macOS, its
  support libraries) inside the OpenCV wheel. They must stay separate,
  dynamically linked, replaceable binaries, and the catalog record must surface
  that obligation and a source offer before a user approves the download.

## Pending

- Per-platform self-contained CPython runtime and the packaged artifact layout.
- macOS arm64 / Windows x64 build, signing/notarization and catalog publication.
- Desktop pack resolution, lease, and worker invocation.

Tracked in C4 of `plan/PROFESSIONAL-EDITOR-P0-P3-CLOSURE.md`.
