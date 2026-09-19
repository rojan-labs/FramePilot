"""Prompts resolve to exact frames; brush and lock inputs are validated before any work."""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import SHA, line, matte_request

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")

from framepilot_smart_mask.prompts import (  # noqa: E402
    BRUSH_EDGE,
    apply_constraints,
    constrained_pixels,
    edge_band,
    resolve_prompts,
)
from framepilot_smart_mask.protocol import (  # noqa: E402
    InputHandle,
    MatteRequest,
    ProtocolError,
    parse_input_line,
)
from framepilot_smart_mask.sandbox import InputDirectory  # noqa: E402

PTS = (100, 612, 1124, 1636)


def request(
    prompts: list[dict[str, object]], files: list[str] | None = None, root: Path | None = None
) -> MatteRequest:
    extra: dict[str, object] = {"prompts": prompts}
    if files is not None:
        extra["inputs"] = {"handleId": "in", "absolutePath": str(root), "files": files}
        extra["previousArtifact"] = SHA
    parsed = parse_input_line(line(matte_request(**extra)))
    assert isinstance(parsed, MatteRequest)
    return parsed


def png(path: Path, image: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    assert cv2.imwrite(str(path), image)


def test_box_then_points_on_one_frame_in_upstream_order() -> None:
    resolved = resolve_prompts(
        request(
            [
                {"kind": "points", "pts": 612, "points": [{"x": 0.5, "y": 0.5, "label": "exclude"}]},
                {"kind": "box", "pts": 612, "box": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4}},
            ]
        ),
        PTS, 64, 36, None,
    )  # fmt: skip
    frame = resolved.frames[1]
    assert frame.labels == [2, 3, 0]
    assert frame.coords[1] == pytest.approx((0.4, 0.6))
    assert resolved.point_frames == [1]


def test_pts_must_be_an_exact_requested_frame() -> None:
    with pytest.raises(ProtocolError, match="not one of the requested frames"):
        resolve_prompts(
            request(
                [{"kind": "box", "pts": 613, "box": {"x": 0, "y": 0, "width": 1, "height": 1}}]
            ),
            PTS,
            64,
            36,
            None,
        )


def test_two_boxes_on_one_frame_are_refused() -> None:
    box = {"x": 0, "y": 0, "width": 1, "height": 1}
    with pytest.raises(ProtocolError, match="at most one box"):
        resolve_prompts(
            request(
                [{"kind": "box", "pts": 100, "box": box}, {"kind": "box", "pts": 100, "box": box}]
            ),
            PTS,
            64,
            36,
            None,
        )


def test_brush_and_lock_inputs(tmp_path: Path) -> None:
    lock = np.zeros((36, 64), np.uint8)
    lock[10:20, 10:30] = 200
    lock[12, 12] = 97  # fractional alpha survives verbatim
    brush = np.full((36, 64), 128, np.uint8)
    brush[0:4, 0:4] = 255
    brush[30:36, 60:64] = 0
    png(tmp_path / "locked" / "1124.png", lock)
    png(tmp_path / "corrections" / "612.png", brush)
    parsed = request(
        [
            {"kind": "box", "pts": 100, "box": {"x": 0, "y": 0, "width": 1, "height": 1}},
            {"kind": "lock", "pts": 1124, "file": "locked/1124.png"},
            {"kind": "brush", "pts": 612, "file": "corrections/612.png"},
        ],
        ["locked/1124.png", "corrections/612.png"],
        tmp_path,
    )
    inputs = InputDirectory(
        InputHandle("in", str(tmp_path), ("locked/1124.png", "corrections/612.png"))
    )
    resolved = resolve_prompts(parsed, PTS, 64, 36, inputs)
    assert np.array_equal(resolved.locked[2], lock)
    assert resolved.brushed == [1]
    alpha = np.full((36, 64), 90, np.uint8)
    corrected = apply_constraints(alpha, resolved.frames[1])
    assert corrected[0, 0] == 255 and corrected[35, 63] == 0 and corrected[18, 30] == 90
    assert np.array_equal(apply_constraints(alpha, resolved.frames[2]), lock)
    assert constrained_pixels(resolved.frames[2], (36, 64)).all()
    assert constrained_pixels(resolved.frames[1], (36, 64)).sum() == 16 + 24


def test_edge_brush_widens_the_band_and_never_sets_alpha(tmp_path: Path) -> None:
    """BR6.10: edge pixels are neither forced nor constrained; they only mark the band."""
    brush = np.full((36, 64), 128, np.uint8)
    brush[0:4, 0:4] = 255
    brush[10:14, 20:40] = BRUSH_EDGE
    png(tmp_path / "corrections" / "612.png", brush)
    parsed = request(
        [
            {"kind": "box", "pts": 100, "box": {"x": 0, "y": 0, "width": 1, "height": 1}},
            {"kind": "brush", "pts": 612, "file": "corrections/612.png"},
        ],
        ["corrections/612.png"],
        tmp_path,
    )
    inputs = InputDirectory(InputHandle("in", str(tmp_path), ("corrections/612.png",)))
    frame = resolve_prompts(parsed, PTS, 64, 36, inputs).frames[1]
    band = edge_band(frame)
    assert band is not None and int(band.sum()) == 4 * 20 and band[12, 30]
    alpha = np.full((36, 64), 90, np.uint8)
    corrected = apply_constraints(alpha, frame)
    assert corrected[0, 0] == 255, "keep still forces"
    assert (corrected[10:14, 20:40] == 90).all(), "edge leaves alpha to the matting model"
    assert constrained_pixels(frame, (36, 64)).sum() == 16, "edge pixels are not constraints"


def test_a_brush_without_edge_pixels_has_no_edge_band(tmp_path: Path) -> None:
    brush = np.full((36, 64), 128, np.uint8)
    brush[0:4, 0:4] = 0
    png(tmp_path / "corrections" / "612.png", brush)
    parsed = request(
        [
            {"kind": "box", "pts": 100, "box": {"x": 0, "y": 0, "width": 1, "height": 1}},
            {"kind": "brush", "pts": 612, "file": "corrections/612.png"},
        ],
        ["corrections/612.png"],
        tmp_path,
    )
    inputs = InputDirectory(InputHandle("in", str(tmp_path), ("corrections/612.png",)))
    resolved = resolve_prompts(parsed, PTS, 64, 36, inputs)
    assert edge_band(resolved.frames[1]) is None
    assert edge_band(None) is None and edge_band(resolved.frames[0]) is None


@pytest.mark.parametrize(
    ("image", "fragment"),
    [
        (np.full((36, 64), 77, np.uint8), "keep \\(255\\), remove \\(0\\), edge \\(64\\)"),
        (np.full((36, 64), 63, np.uint8), "edge \\(64\\) or untouched"),
        (np.full((36, 64), 65, np.uint8), "edge \\(64\\) or untouched"),
        (np.full((35, 64), 128, np.uint8), "display size"),
        (np.full((36, 64, 3), 128, np.uint8), "grayscale"),
    ],
)
def test_bad_correction_pngs_are_refused(tmp_path: Path, image: np.ndarray, fragment: str) -> None:
    png(tmp_path / "corrections" / "612.png", image)
    parsed = request(
        [
            {"kind": "box", "pts": 100, "box": {"x": 0, "y": 0, "width": 1, "height": 1}},
            {"kind": "brush", "pts": 612, "file": "corrections/612.png"},
        ],
        ["corrections/612.png"],
        tmp_path,
    )
    inputs = InputDirectory(InputHandle("in", str(tmp_path), ("corrections/612.png",)))
    with pytest.raises(ProtocolError, match=fragment):
        resolve_prompts(parsed, PTS, 64, 36, inputs)


def test_non_png_input_is_refused(tmp_path: Path) -> None:
    (tmp_path / "locked").mkdir()
    (tmp_path / "locked" / "100.png").write_bytes(b"GIF89a")
    parsed = request(
        [{"kind": "lock", "pts": 100, "file": "locked/100.png"}],
        ["locked/100.png"],
        tmp_path,
    )
    inputs = InputDirectory(InputHandle("in", str(tmp_path), ("locked/100.png",)))
    with pytest.raises(ProtocolError, match="not a PNG"):
        resolve_prompts(parsed, PTS, 64, 36, inputs)
