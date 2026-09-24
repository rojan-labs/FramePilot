"""Where a cut-out subject sits on the delivered frame (``masking/subject_layout.py``).

The captured 2026-09-23 runs placed a "MOTION" title at 11 % of the frame height on a 9:16 crop
where the speaker's head filled most of the frame's width: the head hid the middle of the word.
These tests pin the geometry that would have said so before the edit was made.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.masking import subject_layout as sl
from framepilot_engine.timeline.models import Project

TARGET = (1080, 1920)


@dataclass(frozen=True)
class _Placement:
    x: int
    y: int
    width: int
    height: int


def _head_and_shoulders(
    width: int = 1920,
    height: int = 1080,
    *,
    head: tuple[float, float, float, float] = (0.44, 0.10, 0.56, 0.45),
    body: tuple[float, float, float, float] = (0.34, 0.45, 0.66, 1.0),
) -> np.ndarray:
    """A 16:9 matte: a head rectangle over a wider body rectangle (fractions of the source)."""
    alpha = np.zeros((height, width), dtype=np.float32)
    for x0, y0, x1, y1 in (head, body):
        alpha[int(y0 * height) : int(y1 * height), int(x0 * width) : int(x1 * width)] = 1.0
    return alpha


def test_coverage_maps_the_matte_through_the_crop_onto_the_output_frame() -> None:
    # A centred 9:16 crop of a 16:9 source fills the 9:16 frame exactly.
    crop = (0.342, 0.0, 0.316406, 1.0)
    grid = sl._coverage_on_frame(_head_and_shoulders(), crop, _Placement(0, 0, 1080, 1920), TARGET)
    box = sl._box_of(grid)
    assert box is not None
    # The head starts 10 % down the source, and the crop keeps the full height.
    assert box[1] == pytest.approx(0.10, abs=0.015)
    # The head is 12 % of the SOURCE width but ~38 % of the cropped frame's width.
    head_row = grid[int(0.2 * grid.shape[0])]
    assert head_row.mean() == pytest.approx(0.12 / 0.316406, abs=0.03)


def test_a_scaled_up_picture_pushes_the_head_wider_and_higher() -> None:
    crop = (0.342, 0.0, 0.316406, 1.0)
    alpha = _head_and_shoulders()
    at_rest = sl._coverage_on_frame(alpha, crop, _Placement(0, 0, 1080, 1920), TARGET)
    # A 1.25x punch-in about the centre, as the compiler places it.
    zoomed = sl._coverage_on_frame(alpha, crop, _Placement(-135, -240, 1350, 2400), TARGET)
    row = int(0.25 * at_rest.shape[0])
    assert zoomed[row].mean() > at_rest[row].mean()
    assert sl._box_of(zoomed)[1] < sl._box_of(at_rest)[1]  # type: ignore[index]


def test_bands_report_the_width_the_subject_covers_and_the_shoulders() -> None:
    crop = (0.342, 0.0, 0.316406, 1.0)
    grid = sl._coverage_on_frame(_head_and_shoulders(), crop, _Placement(0, 0, 1080, 1920), TARGET)
    bands = sl._bands(grid)
    assert len(bands) == sl.REPORT_BANDS
    assert bands[0].width_covered == 0.0  # clear above the head
    assert bands[0].span is None
    assert bands[2].width_covered < bands[7].width_covered  # head narrower than body
    shoulders = sl._shoulders(grid)
    assert shoulders == pytest.approx(0.45, abs=0.03)


def test_a_wide_title_at_head_height_reads_as_behind() -> None:
    crop = (0.342, 0.0, 0.316406, 1.0)
    grid = sl._coverage_on_frame(_head_and_shoulders(), crop, _Placement(0, 0, 1080, 1920), TARGET)
    placement = sl.solve_text_behind([grid], text_width=0.9, text_height=0.1)
    assert placement.ends_visible
    assert sl.BEHIND_MIN_OCCLUSION <= placement.occluded <= sl.BEHIND_MAX_OCCLUSION
    # Behind the head, above the shoulders — not on the body, not floating above the head.
    assert 10 <= placement.y_percent <= 45


def test_a_head_filling_the_width_leaves_no_readable_height_and_says_so() -> None:
    # The captured project: in a tight 9:16 crop the head spans almost the whole width.
    crop = (0.342, 0.0, 0.316406, 1.0)
    grid = sl._coverage_on_frame(
        _head_and_shoulders(head=(0.345, 0.02, 0.655, 0.45)),
        crop,
        _Placement(0, 0, 1080, 1920),
        TARGET,
    )
    placement = sl.solve_text_behind([grid], text_width=0.86, text_height=0.13)
    assert not placement.ends_visible
    assert "Zoom the picture out" in placement.note


class _FakeReader:
    """Stands in for the export's ``MatteReader`` over a synthetic matte (no ffmpeg)."""

    def __init__(self, alpha: np.ndarray, count: int) -> None:
        self._alpha = (alpha * 255).astype(np.uint8)
        frames = type(
            "Frames",
            (),
            {
                "count": count,
                "source_seconds": staticmethod(lambda index: index / 30.0),
            },
        )()
        self.prepared = type("Prepared", (), {"frames": frames})()
        self.closed = False
        self.read: list[int] = []

    def frame(self, index: int) -> Any:
        self.read.append(index)
        return type("Frame", (), {"alpha": self._alpha, "maximum": 255})()

    def close(self) -> None:
        self.closed = True


def _project(crop: dict[str, float] | None, masks: list[dict[str, Any]]) -> Project:
    clip: dict[str, Any] = {
        "id": "talk",
        "assetId": "a",
        "trackId": "v",
        "start": 2.0,
        "end": 12.0,
        "sourceStart": 0.0,
        "sourceEnd": 10.0,
        "effects": [],
        "masks": masks,
    }
    if crop is not None:
        clip["crop"] = crop
    return Project.model_validate(
        {
            "schemaVersion": 23,
            "id": "p",
            "name": "p",
            "fps": 30,
            "resolution": {"width": 1080, "height": 1920},
            "assets": [
                {
                    "id": "a",
                    "path": "media/a.mp4",
                    "kind": "video",
                    "durationSeconds": 10,
                    "media": {"width": 1920, "height": 1080},
                }
            ],
            "timeline": {"tracks": [{"id": "v", "type": "video", "clips": [clip]}]},
            "transcript": [],
        }
    )


_MATTE = {
    "id": "m1",
    "kind": "matte",
    "name": "Background removal",
    "target": {"kind": "alpha"},
    "artifact": {
        "key": "0" * 64,
        "files": [],
        "width": 1920,
        "height": 1080,
        "coverage": {"sourceStart": 0, "sourceEnd": 10},
        "packId": "framepilot.smart-mask",
        "packVersion": "1.1.0",
        "modelDigests": [],
    },
}


def test_measures_a_range_through_the_real_placement(monkeypatch: pytest.MonkeyPatch) -> None:
    reader = _FakeReader(_head_and_shoulders(), count=300)
    monkeypatch.setattr(sl, "prepare_matte", lambda *args, **kwargs: object())
    monkeypatch.setattr(sl, "MatteReader", lambda *args, **kwargs: reader)
    layout = sl.measure_subject_layout(
        _project({"x": 0.342, "y": 0.0, "width": 0.316406, "height": 1.0}, [_MATTE]),
        Path("/nowhere"),
        "talk",
        start=4.0,
        end=6.0,
        samples=4,
        text_box=(0.9, 0.1),
    )
    assert reader.closed
    assert len(layout.samples) == 4
    # Timeline 4-6 s is source 2-4 s: matte frames 60-120 at 30 fps.
    assert all(60 <= index <= 120 for index in reader.read)
    assert layout.head_top == pytest.approx(0.10, abs=0.015)
    assert layout.text_behind is not None and layout.text_behind.ends_visible
    assert (layout.start, layout.end) == (4.0, 6.0)


def test_refuses_a_clip_with_no_cut_out() -> None:
    with pytest.raises(sl.SubjectLayoutError, match="remove_background"):
        sl.measure_subject_layout(_project(None, []), Path("/nowhere"), "talk")


def test_refuses_a_range_outside_the_clip(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sl, "prepare_matte", lambda *args, **kwargs: object())
    with pytest.raises(sl.SubjectLayoutError, match="outside clip"):
        sl.measure_subject_layout(
            _project(None, [_MATTE]), Path("/nowhere"), "talk", start=20.0, end=25.0
        )


def test_refuses_an_unknown_clip() -> None:
    with pytest.raises(sl.SubjectLayoutError, match="Unknown clip"):
        sl.measure_subject_layout(_project(None, [_MATTE]), Path("/nowhere"), "ghost")
