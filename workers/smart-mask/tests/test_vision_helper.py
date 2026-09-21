"""The native Vision helper's pipe protocol, against the REAL binary (macOS with the helper built).

Everywhere else this skips: CI's Linux and Windows jobs have no Vision, and a Mac without
``native/vision-matte/build.sh`` run has no binary. What Vision SEES is measured on footage
(plan 13, ``eval/fast_gates.py``); this holds the contract the worker depends on: exact frame
sizes both ways, one answer per request, a usable process after an empty answer, a clean exit.
"""

from __future__ import annotations

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("cv2")

from framepilot_smart_mask.vision import Seed, VisionEstimator, helper_path  # noqa: E402

pytestmark = pytest.mark.skipif(helper_path() is None, reason="the Vision helper is not built")

WIDTH, HEIGHT = 320, 180


def test_every_request_gets_one_exactly_sized_answer_and_the_process_survives_empty_frames() -> (
    None
):
    flat = np.full((HEIGHT, WIDTH, 3), 96, np.uint8)
    noisy = np.random.default_rng(7).integers(0, 255, (HEIGHT, WIDTH, 3), dtype=np.uint8)
    with VisionEstimator(WIDTH, HEIGHT) as estimator:
        for frame, seed in ((flat, None), (noisy, Seed(0.2, 0.2, 0.8, 0.8)), (flat, None)):
            estimate = estimator.estimate(frame, seed)
            assert estimate.alpha.shape == (HEIGHT, WIDTH) and estimate.alpha.dtype == np.uint8
            assert estimate.person.dtype == np.bool_
            # A flat grey frame has no subject: an all-zero matte, reported as not found.
            if frame is flat:
                assert not estimate.found and not estimate.alpha.any()
        estimator.reset()
        assert estimator.estimate(flat).alpha.shape == (HEIGHT, WIDTH)


def test_closing_ends_the_helper_process() -> None:
    estimator = VisionEstimator(WIDTH, HEIGHT)
    process = estimator._process
    assert process is not None and process.poll() is None
    estimator.close()
    assert process.poll() is not None
    estimator.close()  # idempotent
