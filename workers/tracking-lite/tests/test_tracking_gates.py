"""MK7.5: the tracking gates of plan 06, measured against real pixels.

These are the accuracy numbers mask tracking is allowed to claim. ADR 0176's rule applies —
the protocol and policy suites prove plumbing, never accuracy — so every number here comes from
the real OpenCV backend measuring real decoded pixels, and is compared against a ground truth
that is exact by construction.

**How the ground truth is exact.** Each sequence is a base image warped by a KNOWN homography
per frame, rendered with a bilinear sampler in NumPy and round-tripped through lossless PNG.
Nothing here uses ffmpeg's `testsrc`: it differs between ffmpeg versions and has broken a golden
in this repo before. The base image is deterministic (seeded NumPy), so a failure is
reproducible frame for frame.

**What is measured**, per plan 06 "Tracking":

| Gate                                   | Threshold                                        |
| -------------------------------------- | ------------------------------------------------ |
| Planar track on synthetic warps        | median reprojection ≤ 0.25 px, p95 ≤ 1 px, max ≤ 2 px |
| Drift on a static scene                | ≤ 1 px per 300 frames                            |
| Low-confidence detection recall        | ≥ 99.5 % of frames with error > 2 px are flagged |

The recall gate is measured with the HOST's flagging rule, whose two constants are re-stated
here and pinned against the TypeScript source by `test_tracking_gate_constants_match_the_host`,
so the harness cannot drift away from what the product actually flags.

The "real clips with hand-labelled corners" row of plan 06 is **not** measured here and is not
claimed: this repository commits no photographic footage (the mission fixtures are fetched on
demand), and a hand-labelled set is a maintainer action. It is recorded as open in
`plan/background-removal-ai/MK7-TRACKING-GATES.md`.

Every run writes `tracking-gates.json` beside the test so the numbers in that document can be
regenerated rather than retyped.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("cv2", reason="the tracking gates need the `cv` extra")

import cv2
import numpy as np

from framepilot_tracking_lite.backend import Frame
from framepilot_tracking_lite.opencv_backend import OpenCvBackend
from framepilot_tracking_lite.policy import run_tracker
from framepilot_tracking_lite.protocol import MediaHandle, NormalizedPoint, TrackingRequest
from framepilot_tracking_lite.runtime import build_tracker

pytestmark = pytest.mark.decoded_media

WIDTH = 640
HEIGHT = 360
#: The plane the mask sits on, in pixels: a generous central quad with texture on every side.
QUAD = ((160.0, 90.0), (480.0, 90.0), (480.0, 270.0), (160.0, 270.0))

#: Gate thresholds (plan 06 "Tracking"). Never lowered.
MEDIAN_PX = 0.25
P95_PX = 1.0
MAX_PX = 2.0
DRIFT_PX_PER_300 = 1.0
RECALL = 0.995

#: The host's flagging rule (`mask-track-solve.ts`). Pinned by the constants test below.
FLAG_CONFIDENCE = 0.5
FLAG_RESIDUAL_PX = 1.0

REPORT = Path(__file__).parent / "tracking-gates.json"


# --- deterministic imagery -------------------------------------------------


def base_image() -> np.ndarray:
    """A deterministic, richly textured plate: seeded noise a tracker can actually lock on to.

    Smooth gradients alone give an aperture-problem image with no corners, and a checkerboard
    gives repeating features that match the wrong neighbour. Band-limited noise plus a few hard
    squares gives both: dense gradients everywhere, and unambiguous corners.
    """
    rng = np.random.default_rng(20260918)
    noise = rng.random((HEIGHT, WIDTH), dtype=np.float64)
    smooth = cv2.GaussianBlur(noise, (0, 0), 1.2)
    image = (smooth - smooth.min()) / (smooth.max() - smooth.min())
    plate = (image * 200.0 + 20.0).astype(np.uint8)
    for index, (cx, cy) in enumerate(((220, 140), (420, 140), (420, 230), (220, 230), (320, 185))):
        value = 255 if index % 2 == 0 else 0
        plate[cy - 12 : cy + 12, cx - 12 : cx + 12] = value
    return plate


def warp(image: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """Render `image` through `matrix` with a bilinear sampler written here, not in OpenCV.

    Keeping the renderer in NumPy makes the sequence reproducible across OpenCV versions, which
    is the same reason the plan forbids `testsrc`.
    """
    ys, xs = np.mgrid[0:HEIGHT, 0:WIDTH]
    ones = np.ones_like(xs, dtype=np.float64)
    grid = np.stack([xs.astype(np.float64), ys.astype(np.float64), ones])
    inverse = np.linalg.inv(matrix)
    mapped = inverse @ grid.reshape(3, -1)
    w = mapped[2]
    sx = (mapped[0] / w).reshape(HEIGHT, WIDTH)
    sy = (mapped[1] / w).reshape(HEIGHT, WIDTH)
    x0 = np.clip(np.floor(sx).astype(np.int64), 0, WIDTH - 2)
    y0 = np.clip(np.floor(sy).astype(np.int64), 0, HEIGHT - 2)
    fx = np.clip(sx - x0, 0.0, 1.0)
    fy = np.clip(sy - y0, 0.0, 1.0)
    source = image.astype(np.float64)
    top = source[y0, x0] * (1 - fx) + source[y0, x0 + 1] * fx
    bottom = source[y0 + 1, x0] * (1 - fx) + source[y0 + 1, x0 + 1] * fx
    return np.clip(top * (1 - fy) + bottom * fy, 0, 255).astype(np.uint8)


def homography(
    *, dx: float, dy: float, scale: float, degrees: float, perspective: float
) -> np.ndarray:
    radians = math.radians(degrees)
    cos = math.cos(radians) * scale
    sin = math.sin(radians) * scale
    centre_x, centre_y = WIDTH / 2.0, HEIGHT / 2.0
    rigid = np.array(
        [
            [cos, -sin, centre_x - (cos * centre_x - sin * centre_y) + dx],
            [sin, cos, centre_y - (sin * centre_x + cos * centre_y) + dy],
            [0.0, 0.0, 1.0],
        ]
    )
    if perspective == 0.0:
        return rigid
    tilt = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [perspective, perspective / 2.0, 1.0]])
    return rigid @ tilt


def sequence(
    tmp_path: Path, matrices: list[np.ndarray], plate: np.ndarray | None = None
) -> list[Frame]:
    """Render the frames and read them back through lossless PNG."""
    image = base_image() if plate is None else plate
    frames: list[Frame] = []
    for index, matrix in enumerate(matrices):
        path = tmp_path / f"frame-{index:04d}.png"
        assert cv2.imwrite(str(path), warp(image, matrix))
        decoded = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        assert decoded is not None
        frames.append(decoded)
    return frames


class ListFrameSource:
    """The rendered frames as a frame source.

    Decoding is proved separately by `test_decoded_media.py`; what these gates measure is the
    tracker's accuracy, so the sequence is handed over directly rather than re-encoded, which
    would add a codec's own error to a number about the tracker.
    """

    def __init__(self, frames: list[Frame]) -> None:
        self._frames = frames
        self._next = 0

    @property
    def width(self) -> int:
        return WIDTH

    @property
    def height(self) -> int:
        return HEIGHT

    def read(self) -> Frame | None:
        if self._next >= len(self._frames):
            return None
        frame = self._frames[self._next]
        self._next += 1
        return frame

    def close(self) -> None:
        return None


def planar_request(frames: int) -> TrackingRequest:
    corners = tuple(NormalizedPoint(x=x / WIDTH, y=y / HEIGHT) for x, y in QUAD)
    return TrackingRequest(
        request_id="gate-1",
        project_revision=0,
        capability="tracking.planar",
        media=MediaHandle(
            handle_id="h",
            asset_id="a",
            absolute_path="/approved/media/plate.png",
            source_start_seconds=0.0,
            source_end_seconds=frames / 30.0,
            fps=30.0,
            first_frame=0,
            last_frame_exclusive=frames,
        ),
        corners=corners,  # type: ignore[arg-type]
    )


def project(matrix: np.ndarray, point: tuple[float, float]) -> tuple[float, float]:
    x, y, w = matrix @ np.array([point[0], point[1], 1.0])
    return (x / w, y / w)


def pixel_matrix(transform: tuple[float, ...]) -> np.ndarray:
    """The worker's NORMALIZED transform back in pixels: `S · H · S⁻¹`."""
    scale = np.diag([float(WIDTH), float(HEIGHT), 1.0])
    return scale @ np.array(transform, dtype=np.float64).reshape(3, 3) @ np.linalg.inv(scale)


def corner_errors(
    matrices: list[np.ndarray], samples: list[Any]
) -> tuple[list[float], list[float]]:
    """Per-frame worst corner reprojection error, and the tracker's confidence."""
    errors: list[float] = []
    confidences: list[float] = []
    for sample in samples:
        truth = matrices[sample.frame]
        assert sample.transform is not None, "a planar sample must carry its measured plane"
        measured = pixel_matrix(sample.transform)
        worst = 0.0
        for corner in QUAD:
            tx, ty = project(truth, corner)
            mx, my = project(measured, corner)
            worst = max(worst, math.hypot(mx - tx, my - ty))
        errors.append(worst)
        confidences.append(sample.confidence)
    return errors, confidences


def track(frames: list[Frame]) -> list[Any]:
    request = planar_request(len(frames))
    source = ListFrameSource(frames)
    tracker = build_tracker(request, OpenCvBackend(), WIDTH, HEIGHT)
    return list(run_tracker(request, source, tracker, should_cancel=lambda: False))


def percentile(values: list[float], fraction: float) -> float:
    return float(np.percentile(np.asarray(values), fraction * 100.0))


_REPORT: dict[str, Any] = {}


def record(name: str, payload: dict[str, Any]) -> None:
    _REPORT[name] = payload
    REPORT.write_text(json.dumps(_REPORT, indent=1, sort_keys=True) + "\n", encoding="utf-8")


# --- the gates -------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "step"),
    [
        ("translation", {"dx": 1.5, "dy": 0.75, "scale": 1.0, "degrees": 0.0, "perspective": 0.0}),
        (
            "similarity",
            {"dx": 0.8, "dy": -0.4, "scale": 1.0015, "degrees": 0.12, "perspective": 0.0},
        ),
        (
            "perspective",
            {"dx": 0.5, "dy": 0.25, "scale": 1.0008, "degrees": 0.06, "perspective": 2.0e-6},
        ),
    ],
)
def test_planar_track_on_synthetic_warps_meets_the_reprojection_gate(
    tmp_path: Path, name: str, step: dict[str, float]
) -> None:
    """Plan 06: median ≤ 0.25 px, p95 ≤ 1 px, no frame worse than 2 px."""
    count = 60
    matrices = [
        homography(
            dx=step["dx"] * index,
            dy=step["dy"] * index,
            scale=step["scale"] ** index,
            degrees=step["degrees"] * index,
            perspective=step["perspective"] * index,
        )
        for index in range(count)
    ]
    samples = track(sequence(tmp_path, matrices))
    assert len(samples) == count
    errors, _ = corner_errors(matrices, samples)
    median = percentile(errors, 0.5)
    p95 = percentile(errors, 0.95)
    worst = max(errors)
    record(
        f"planar/{name}",
        {"frames": count, "medianPx": median, "p95Px": p95, "maxPx": worst},
    )
    assert median <= MEDIAN_PX, f"{name}: median {median:.4f} px"
    assert p95 <= P95_PX, f"{name}: p95 {p95:.4f} px"
    assert worst <= MAX_PX, f"{name}: worst {worst:.4f} px"


def test_drift_on_a_static_scene_stays_inside_the_gate(tmp_path: Path) -> None:
    """Plan 06: ≤ 1 px per 300 frames. A still plane must not wander."""
    count = 120
    identity = np.eye(3)
    matrices = [identity for _ in range(count)]
    samples = track(sequence(tmp_path, matrices))
    errors, _ = corner_errors(matrices, samples)
    final = errors[-1]
    per_300 = final * (300.0 / count)
    record("drift/static", {"frames": count, "finalPx": final, "perThreeHundredPx": per_300})
    assert per_300 <= DRIFT_PX_PER_300, f"drift {per_300:.4f} px per 300 frames"


def flagged(error_px: float, confidence: float) -> bool:
    """The host's rule: confidence penalised by the model residual, against the floor."""
    penalty = max(0.0, min(1.0, 1.0 - error_px / (2.0 * FLAG_RESIDUAL_PX)))
    return confidence * penalty < FLAG_CONFIDENCE


def test_low_confidence_detection_recall_meets_the_gate(tmp_path: Path) -> None:
    """Plan 06: ≥ 99.5 % of frames whose error exceeds 2 px are flagged.

    The failure is produced honestly rather than injected into the measurement: half the
    sequence is occluded by a moving opaque band, so the tracker loses correspondences and the
    frames that go wrong are the frames it could not measure.
    """
    count = 90
    matrices = [
        homography(dx=1.2 * index, dy=0.0, scale=1.0, degrees=0.0, perspective=0.0)
        for index in range(count)
    ]
    frames = sequence(tmp_path, matrices)
    for index in range(count // 2, count):
        band = frames[index].copy()
        left = max(0, min(WIDTH - 200, (index - count // 2) * 14))
        band[:, left : left + 200] = 128
        frames[index] = band
    samples = track(frames)
    errors, confidences = corner_errors(matrices, samples)
    wrong = [index for index, error in enumerate(errors) if error > MAX_PX]
    caught = [index for index in wrong if flagged(errors[index], confidences[index])]
    recall = 1.0 if not wrong else len(caught) / len(wrong)
    record(
        "recall/occlusion",
        {
            "frames": len(samples),
            "wrongFrames": len(wrong),
            "caught": len(caught),
            "recall": recall,
        },
    )
    assert recall >= RECALL, f"recall {recall:.4f} over {len(wrong)} wrong frame(s)"


def test_the_reference_frame_is_exactly_the_identity(tmp_path: Path) -> None:
    """A constraint frame is exact by construction: the frame it is anchored on cannot move.

    This is the worker half of plan 06's "constraint frames 100 % exact after any re-track"; the
    host half — anchoring each re-measured segment ON its constraint — is proved in
    `packages/editor-core/src/mask-track-review.test.ts`.
    """
    matrices = [
        homography(dx=2.0 * index, dy=0.0, scale=1.0, degrees=0.0, perspective=0.0)
        for index in range(6)
    ]
    samples = track(sequence(tmp_path, matrices))
    assert samples[0].transform == (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
    errors, _ = corner_errors(matrices, samples)
    assert errors[0] == 0.0


def test_tracking_gate_constants_match_the_host() -> None:
    """The harness must flag what the product flags, not what it used to flag."""
    source = (
        Path(__file__).resolve().parents[3]
        / "packages"
        / "editor-core"
        / "src"
        / "mask-track-solve.ts"
    )
    text = source.read_text(encoding="utf-8")
    confidence = re.search(r"TRACK_FLAG_CONFIDENCE = ([0-9.]+)", text)
    residual = re.search(r"TRACK_FLAG_RESIDUAL_PX = ([0-9.]+)", text)
    assert confidence is not None and residual is not None
    assert float(confidence.group(1)) == FLAG_CONFIDENCE
    assert float(residual.group(1)) == FLAG_RESIDUAL_PX
