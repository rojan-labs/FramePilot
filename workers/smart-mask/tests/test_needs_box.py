"""BR7.5: one click on a subject cut by the frame asks for a box instead of guessing one."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("cv2")
pytest.importorskip("PIL")

from fakes import GRAY, RED, FakeSam  # noqa: E402
from pipeline_harness import FakeProvider, make_clip, request_for, run_job  # noqa: E402

from framepilot_smart_mask.protocol import ProtocolError  # noqa: E402
from framepilot_smart_mask.tracker import (  # noqa: E402
    PointPrompt,
    click_needs_box,
    cut_by_frame,
    preprocess,
)

HEIGHT, WIDTH = 90, 160


def frames_with(count: int, top: int, bottom: int) -> np.ndarray:
    frames = np.empty((count, HEIGHT, WIDTH, 3), np.uint8)
    frames[:] = GRAY
    frames[:, top:bottom, 60:100] = RED
    return frames


def test_a_mask_cut_by_an_edge_of_the_picture_is_detected() -> None:
    mask = np.zeros((HEIGHT, WIDTH), bool)
    mask[30:60, 60:100] = True
    assert not cut_by_frame(mask)
    mask[60:, 60:100] = True
    assert cut_by_frame(mask), "40 of 160 bottom-edge pixels is a subject running off the frame"
    stray = np.zeros((HEIGHT, WIDTH), bool)
    stray[89, 0:2] = True
    assert not cut_by_frame(stray), "a couple of edge pixels are not a cut subject"


@pytest.mark.parametrize(("bottom", "expected"), [(60, False), (HEIGHT, True)])
def test_one_click_needs_a_box_only_when_its_subject_runs_off_the_picture(
    bottom: int, expected: bool
) -> None:
    frame = frames_with(1, 30, bottom)[0]
    sam = FakeSam()
    feats = sam.encode_image(preprocess(frame))
    click = PointPrompt(coords=((80 / WIDTH, 45 / HEIGHT),), labels=(1,))
    assert click_needs_box(sam, feats, click, frame) is expected


def test_a_box_or_several_points_never_need_another_box() -> None:
    frame = frames_with(1, 30, HEIGHT)[0]
    sam = FakeSam()
    feats = sam.encode_image(preprocess(frame))
    with_box = PointPrompt(
        coords=((0.3, 0.3), (0.7, 1.0), (0.5, 0.6)), labels=(2, 3, 1)
    )  # fmt: skip
    two_points = PointPrompt(coords=((0.5, 0.5), (0.5, 0.8)), labels=(1, 1))
    assert not click_needs_box(sam, feats, with_box, frame)
    assert not click_needs_box(sam, feats, two_points, frame)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_the_matte_job_refuses_with_needs_box_before_encoding_the_clip(tmp_path: Path) -> None:
    clip = tmp_path / "clip.mkv"
    make_clip(clip, frames_with(12, 30, HEIGHT))
    staging = tmp_path / "staging"
    (staging / "inputs").mkdir(parents=True)
    provider = FakeProvider()
    click = {"kind": "points", "pts": 0, "points": [{"x": 0.5, "y": 0.6, "label": "include"}]}
    with pytest.raises(ProtocolError) as refused:
        run_job(request_for(clip, staging, 12, [click]), provider)
    assert refused.value.code == "needs_box"
    assert "box" in refused.value.detail
    # The same click with the editor's box runs to the end.
    box = {"kind": "box", "pts": 0, "box": {"x": 0.3, "y": 0.3, "width": 0.4, "height": 0.7}}
    staging2 = tmp_path / "staging2"
    (staging2 / "inputs").mkdir(parents=True)
    outcome = run_job(request_for(clip, staging2, 12, [box, click]), FakeProvider())
    assert outcome.artifact.frame_count == 12
