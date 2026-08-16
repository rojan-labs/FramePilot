"""Pixel proof: the real OpenCV backend tracking real decoded video.

These tests are excluded from the default suite (`-m "not decoded_media"`) and
run only in the pack build job, because they require the `cv` extra. They are the
evidence that Tracking Lite actually works: a synthetic but genuinely encoded and
decoded video carries a textured subject along a known trajectory, and each
capability must recover that trajectory from pixels — plus negative controls
proving a plausible wrong trajectory does not pass, and that a subject which
leaves the frame is reported as lost rather than confidently invented.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("cv2", reason="decoded-media proof requires the `cv` extra")

import cv2
import numpy as np

from framepilot_tracking_lite.opencv_backend import OpenCvBackend
from framepilot_tracking_lite.policy import run_tracker
from framepilot_tracking_lite.protocol import (
    PROTOCOL_VERSION,
    TrackingRequest,
    TrackingSample,
    parse_input_line,
)
from framepilot_tracking_lite.runtime import build_tracker

pytestmark = pytest.mark.decoded_media

FRAME_WIDTH = 320
FRAME_HEIGHT = 240
FRAME_COUNT = 48
SUBJECT_SIZE = 48
START_X = 40
START_Y = 96
STEP_X = 4.0
STEP_Y = 1.0
SEED = 20260813


def subject_position(frame_index: int) -> tuple[float, float]:
    """Ground truth: the subject's top-left pixel at a given frame."""
    return (START_X + STEP_X * frame_index, START_Y + STEP_Y * frame_index)


def _textured(height: int, width: int, seed: int) -> np.ndarray:
    """A detailed but *spatially correlated* texture, like real footage.

    Pure white noise would be an unfair fixture in both directions: its delta
    autocorrelation makes appearance similarity collapse on a sub-pixel offset,
    and JPEG destroys it. Blurring the noise and adding structure gives optical
    flow real features to lock onto while behaving like photographed detail.
    """
    rng = np.random.default_rng(seed)
    noise = rng.integers(0, 256, size=(height, width, 3)).astype(np.float32)
    texture = cv2.GaussianBlur(noise, (0, 0), sigmaX=2.5, sigmaY=2.5)
    # Rescale back to full contrast; blurring alone leaves a flat mid-grey.
    lowest, highest = float(texture.min()), float(texture.max())
    texture = (texture - lowest) / max(highest - lowest, 1e-6) * 255.0
    # A few hard edges, which is what corner detection actually keys on.
    for index in range(4):
        x = int(rng.integers(0, max(width - 12, 1)))
        y = int(rng.integers(0, max(height - 12, 1)))
        texture[y : y + 10, x : x + 10] = 20.0 if index % 2 == 0 else 235.0
    return texture.astype(np.uint8)


def _write_video(path: Path, frames: list[np.ndarray]) -> None:
    # MJPG in AVI: universally available in headless wheels, and intraframe, so a
    # decoded frame does not depend on inter-frame prediction quality.
    writer = cv2.VideoWriter(
        str(path), cv2.VideoWriter_fourcc(*"MJPG"), 30.0, (FRAME_WIDTH, FRAME_HEIGHT)
    )
    assert writer.isOpened(), "could not open the MJPG writer"
    for frame in frames:
        writer.write(frame)
    writer.release()
    assert path.exists() and path.stat().st_size > 0


def _render(exit_frame: int | None = None) -> list[np.ndarray]:
    """Render the moving-subject sequence, optionally removing the subject partway."""
    background = _textured(FRAME_HEIGHT, FRAME_WIDTH, SEED)
    subject = _textured(SUBJECT_SIZE, SUBJECT_SIZE, SEED + 1)
    frames: list[np.ndarray] = []
    for index in range(FRAME_COUNT):
        frame = background.copy()
        if exit_frame is None or index < exit_frame:
            left, top = (round(value) for value in subject_position(index))
            frame[top : top + SUBJECT_SIZE, left : left + SUBJECT_SIZE] = subject
        frames.append(frame)
    return frames


@pytest.fixture(scope="module")
def moving_subject_video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("tracking-lite") / "moving-subject.avi"
    _write_video(path, _render())
    return path


@pytest.fixture(scope="module")
def vanishing_subject_video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("tracking-lite") / "vanishing-subject.avi"
    _write_video(path, _render(exit_frame=FRAME_COUNT // 3))
    return path


def request_for(capability: str, path: Path) -> TrackingRequest:
    centre_x = (START_X + SUBJECT_SIZE / 2) / FRAME_WIDTH
    centre_y = (START_Y + SUBJECT_SIZE / 2) / FRAME_HEIGHT
    left, top = START_X / FRAME_WIDTH, START_Y / FRAME_HEIGHT
    right = (START_X + SUBJECT_SIZE) / FRAME_WIDTH
    bottom = (START_Y + SUBJECT_SIZE) / FRAME_HEIGHT
    parameters = {
        "tracking.point": {"point": {"x": centre_x, "y": centre_y}},
        "tracking.region": {
            "region": {
                "x": left,
                "y": top,
                "width": SUBJECT_SIZE / FRAME_WIDTH,
                "height": SUBJECT_SIZE / FRAME_HEIGHT,
            }
        },
        "tracking.planar": {
            "corners": [
                {"x": left, "y": top},
                {"x": right, "y": top},
                {"x": right, "y": bottom},
                {"x": left, "y": bottom},
            ]
        },
    }[capability]
    parsed = parse_input_line(
        json.dumps(
            {
                "type": "request",
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": "decoded-1",
                "projectRevision": 3,
                "capability": capability,
                "media": {
                    "handleId": "handle-1",
                    "assetId": "asset-1",
                    "absolutePath": str(path),
                    "sourceStartSeconds": 0.0,
                    "sourceEndSeconds": FRAME_COUNT / 30.0,
                    "fps": 30.0,
                    "firstFrame": 0,
                    "lastFrameExclusive": FRAME_COUNT,
                },
                "parameters": parameters,
            }
        )
    )
    assert isinstance(parsed, TrackingRequest)
    return parsed


def track(capability: str, path: Path) -> list[TrackingSample]:
    backend = OpenCvBackend()
    request = request_for(capability, path)
    source = backend.open_frames(str(path), 0, FRAME_COUNT)
    try:
        tracker = build_tracker(request, backend, source.width, source.height)
        return list(run_tracker(request, source, tracker, should_cancel=lambda: False))
    finally:
        source.close()


def centre_pixels(sample: TrackingSample) -> tuple[float, float]:
    return (
        (sample.box.x + sample.box.width / 2) * FRAME_WIDTH,
        (sample.box.y + sample.box.height / 2) * FRAME_HEIGHT,
    )


def true_centre(frame_index: int) -> tuple[float, float]:
    left, top = subject_position(frame_index)
    return (left + SUBJECT_SIZE / 2, top + SUBJECT_SIZE / 2)


def tracking_error(samples: list[TrackingSample]) -> float:
    """Worst distance, in pixels, between a reported centre and the true subject."""
    worst = 0.0
    for sample in samples:
        reported = centre_pixels(sample)
        expected = true_centre(sample.frame)
        worst = max(worst, float(np.hypot(reported[0] - expected[0], reported[1] - expected[1])))
    return worst


@pytest.mark.parametrize("capability", ["tracking.point", "tracking.region", "tracking.planar"])
def test_tracks_a_real_moving_subject_from_decoded_pixels(
    capability: str, moving_subject_video: Path
) -> None:
    samples = track(capability, moving_subject_video)
    assert len(samples) == FRAME_COUNT
    assert [sample.frame for sample in samples] == list(range(FRAME_COUNT))
    assert tracking_error(samples) <= 8.0, f"{capability} lost the real subject"
    assert not any(sample.occluded for sample in samples)
    assert min(sample.confidence for sample in samples) > 0.3


@pytest.mark.parametrize("capability", ["tracking.point", "tracking.region", "tracking.planar"])
def test_a_wrong_trajectory_does_not_pass_as_the_track(
    capability: str, moving_subject_video: Path
) -> None:
    """Negative control: the subject moves right and down; a mirrored path must fail."""
    samples = track(capability, moving_subject_video)
    worst = 0.0
    for sample in samples:
        reported = centre_pixels(sample)
        wrong = (
            true_centre(0)[0] - STEP_X * sample.frame,
            true_centre(0)[1] - STEP_Y * sample.frame,
        )
        worst = max(worst, float(np.hypot(reported[0] - wrong[0], reported[1] - wrong[1])))
    assert worst > 40.0


@pytest.mark.parametrize("capability", ["tracking.point", "tracking.region"])
def test_results_are_byte_identical_across_runs(
    capability: str, moving_subject_video: Path
) -> None:
    first = track(capability, moving_subject_video)
    second = track(capability, moving_subject_video)
    assert first == second


def test_a_subject_that_disappears_is_reported_lost_not_invented(
    vanishing_subject_video: Path,
) -> None:
    """The strongest honesty check: no subject in frame must never yield a track."""
    samples: list[TrackingSample] | None = None
    error: Exception | None = None
    try:
        samples = track("tracking.region", vanishing_subject_video)
    except Exception as caught:  # either outcome asserted below is acceptable
        error = caught
    if error is not None:
        assert getattr(error, "code", None) == "target_lost"
        return
    assert samples is not None
    vanished_at = FRAME_COUNT // 3
    after = [sample for sample in samples if sample.frame >= vanished_at + 2]
    assert after, "the track ended early, which is also honest"
    # If frames after the subject vanished are reported at all, they must be
    # flagged: a confident lock on an absent subject is the failure mode.
    assert all(sample.occluded or sample.confidence < 0.5 for sample in after)
