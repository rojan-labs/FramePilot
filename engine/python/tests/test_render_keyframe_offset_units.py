"""Keyframed ``x``/``y`` are PROJECT pixels at every render size.

WHY: the editor, the AI tools and the preview author a clip's ``x``/``y`` keyframes as offsets
from the frame centre in the project's own pixels. The engine added them raw to a position
computed in the RENDER TARGET's pixels, so the export at the project's size was right and every
smaller render — the agent's frame grab (512 px), the temporal review evidence (540x960) —
moved the picture by the full project-pixel offset. A reframing pan (a 16:9 shot covering a
9:16 frame, walked edge to edge by ``x``) came out entirely black at both ends of a 288x512 grab.

These pin the rule where it lives (``frame_plan.authored_offset_scale``), through the plan every
layer kind takes, through the compiler's placement, and through real renders.
"""

from __future__ import annotations

import io
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.compiler import picture_placement_at
from framepilot_engine.render.frame_grab import grab_frame
from framepilot_engine.render.frame_plan import (
    FramePlan,
    authored_offset_scale,
    frame_plan_at,
)
from framepilot_engine.timeline.models import Project

#: A channel at or below this reads as black (codec noise on a pure black frame stays under it).
_BLACK_LEVEL = 16

#: The vertical project of the reported run, and the size ``grab_frame`` picks for it at 512 px.
_PORTRAIT = (1080, 1920)
_GRAB_512 = (288, 512)


def _keyframe(kid: str, time: float, prop: str, value: float) -> dict[str, Any]:
    return {"id": kid, "time": time, "property": prop, "value": value, "easing": "linear"}


def _project(
    resolution: tuple[int, int],
    tracks: list[dict[str, Any]],
    assets: list[dict[str, Any]],
) -> Project:
    return Project.model_validate(
        {
            "id": "p",
            "name": "offset units",
            "fps": 30,
            "resolution": {"width": resolution[0], "height": resolution[1]},
            "assets": assets,
            "timeline": {"tracks": tracks},
        }
    )


def _video_asset(asset_id: str, path: str, size: tuple[int, int]) -> dict[str, Any]:
    return {
        "id": asset_id,
        "path": path,
        "kind": "video",
        "durationSeconds": 2.0,
        "media": {"width": size[0], "height": size[1]},
    }


def _clip(
    clip_id: str, asset_id: str, track_id: str, keyframes: list[dict[str, Any]], **extra: Any
) -> dict[str, Any]:
    return {
        "id": clip_id,
        "assetId": asset_id,
        "trackId": track_id,
        "start": 0.0,
        "end": 2.0,
        "sourceStart": 0.0,
        "sourceEnd": 2.0,
        "keyframes": keyframes,
        **extra,
    }


def _pan_keyframes(scale: float, reach: float) -> list[dict[str, Any]]:
    """Cover at ``scale`` and pan from ``+reach`` to ``-reach`` over the first second, then hold."""
    return [
        _keyframe("s0", 0.0, "scale", scale),
        _keyframe("x0", 0.0, "x", reach),
        _keyframe("x1", 1.0, "x", -reach),
    ]


def _anchors(plan: FramePlan) -> list[tuple[str | None, float, float]]:
    return [
        (layer.clip_id, layer.geometry.anchor_x, layer.geometry.anchor_y)
        for layer in plan.layers
        if layer.geometry is not None
    ]


class TestAuthoredOffsetScale:
    def test_is_the_identity_at_the_project_frame(self) -> None:
        assert authored_offset_scale((288, 512), None) == (1.0, 1.0)
        assert authored_offset_scale(_PORTRAIT, _PORTRAIT) == (1.0, 1.0)

    def test_scales_each_axis_by_its_own_ratio(self) -> None:
        assert authored_offset_scale((640, 480), (1280, 720)) == (0.5, 480 / 720)

    def test_leaves_an_axis_with_no_project_size_unscaled(self) -> None:
        assert authored_offset_scale((640, 480), (0, 720)) == (1.0, 480 / 720)


class TestFramePlanAtAnotherSize:
    """The plan at a smaller frame is the project-size plan scaled, for every layer kind."""

    def _mixed_project(self) -> Project:
        moving = [_keyframe("x0", 0.0, "x", 300.0), _keyframe("y0", 0.0, "y", -240.0)]
        text = {
            "id": "title__text",
            "type": "text",
            "params": {"text": "Moving", "xPercent": 25, "yPercent": 75},
        }
        return _project(
            _PORTRAIT,
            [
                {
                    "id": "o",
                    "type": "overlay",
                    "clips": [_clip("title", "__text__", "o", moving, effects=[text])],
                },
                {
                    "id": "v",
                    "type": "video",
                    "clips": [_clip("pan", "land", "v", _pan_keyframes(3.1605, 1166.67))],
                },
                {"id": "s", "type": "video", "clips": [_clip("still", "png", "s", moving)]},
            ],
            [
                _video_asset("land", "land.mp4", (1920, 1080)),
                {
                    "id": "png",
                    "path": "still.png",
                    "kind": "image",
                    "media": {"width": 800, "height": 600},
                },
            ],
        )

    @pytest.mark.parametrize("t", [0.0, 0.5, 1.5])
    def test_every_anchor_lands_at_the_same_relative_place(self, t: float) -> None:
        project = self._mixed_project()
        full = frame_plan_at(project, t)
        small = frame_plan_at(project, t, target=_GRAB_512)
        ratio_x, ratio_y = _GRAB_512[0] / _PORTRAIT[0], _GRAB_512[1] / _PORTRAIT[1]
        full_anchors, small_anchors = _anchors(full), _anchors(small)
        assert [a[0] for a in small_anchors] == ["still", "pan", "title"]
        for (clip_id, full_x, full_y), (_, small_x, small_y) in zip(
            full_anchors, small_anchors, strict=True
        ):
            assert small_x == pytest.approx(full_x * ratio_x, abs=1e-9), clip_id
            assert small_y == pytest.approx(full_y * ratio_y, abs=1e-9), clip_id

    @pytest.mark.parametrize("t", [0.0, 1.5])
    def test_a_reframing_pan_still_covers_a_grab_sized_frame_at_its_ends(self, t: float) -> None:
        project = self._mixed_project()
        layer = next(
            layer
            for layer in frame_plan_at(project, t, target=_GRAB_512).layers
            if layer.clip_id == "pan"
        )
        geometry = layer.geometry
        assert geometry is not None and geometry.left is not None and geometry.width is not None
        # The pan reaches the edge of the picture, never past it: no black on either side.
        assert geometry.left <= 0.5
        assert geometry.left + geometry.width >= _GRAB_512[0] - 0.5

    def test_a_shape_moves_by_the_converted_offset(self) -> None:
        arrow = {
            "id": "arrow__shape",
            "type": "shape",
            "params": {
                "shape": "line-arrow",
                "x1": 20,
                "y1": 20,
                "x2": 45,
                "y2": 42,
                "fill": None,
                "stroke": "#FF3B30",
                "strokeWidth": 0.8,
                "strokeStyle": "solid",
                "startCap": "none",
                "endCap": "arrow",
                "headSize": 4,
            },
        }
        still = [_keyframe("x0", 0.0, "x", 0.0)]
        moved = [_keyframe("x0", 0.0, "x", 400.0), _keyframe("y0", 0.0, "y", 200.0)]

        def anchor(keyframes: list[dict[str, Any]]) -> tuple[float, float]:
            project = _project(
                (1280, 720),
                [
                    {
                        "id": "s",
                        "type": "overlay",
                        "clips": [_clip("a", "__shape__", "s", keyframes, effects=[arrow])],
                    }
                ],
                [],
            )
            geometry = frame_plan_at(project, 1.0, target=(320, 180)).layers[0].geometry
            assert geometry is not None
            return geometry.anchor_x, geometry.anchor_y

        (x0, y0), (x1, y1) = anchor(still), anchor(moved)
        # 400 x 200 project pixels are 100 x 50 at a quarter of the frame.
        assert (x1 - x0, y1 - y0) == pytest.approx((100.0, 50.0), abs=1e-9)


class TestCompilerPlacement:
    def test_picture_placement_at_a_smaller_frame_is_the_plan_scaled(self) -> None:
        project = _project(
            _PORTRAIT,
            [
                {
                    "id": "v",
                    "type": "video",
                    "clips": [_clip("pan", "land", "v", _pan_keyframes(3.1605, 1166.67))],
                }
            ],
            [_video_asset("land", "land.mp4", (1920, 1080))],
        )
        clip = project.timeline.tracks[0].clips[0]
        for t in (0.0, 1.5):
            planned = frame_plan_at(project, t, target=_GRAB_512).layers[0].geometry
            assert planned is not None and planned.left is not None and planned.top is not None
            placement = picture_placement_at(
                clip, t, (1920, 1080), _GRAB_512, None, project_size=_PORTRAIT
            )
            assert (placement.x, placement.y) == (int(planned.left), int(planned.top))
            # The raw project-pixel offset, the old behaviour, lands somewhere else entirely.
            raw = picture_placement_at(clip, t, (1920, 1080), _GRAB_512, None)
            assert abs(raw.x - placement.x) > 500


def _black_ratio(data: bytes) -> float:
    from PIL import Image

    pixels = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
    return float((pixels.max(axis=2) <= _BLACK_LEVEL).mean())


def _bright_centroid(data: bytes) -> tuple[float, float] | None:
    """The centre of the bright pixels, as fractions of the frame (``None`` when there are none)."""
    from PIL import Image

    pixels = np.asarray(Image.open(io.BytesIO(data)).convert("L"), dtype=np.float64)
    ys, xs = np.nonzero(pixels > 128)
    if xs.size == 0:
        return None
    height, width = pixels.shape
    return (float(xs.mean() + 0.5) / width, float(ys.mean() + 0.5) / height)


@pytest.mark.usefixtures("require_ffprobe")
class TestRenderedAtAnotherSize:
    def test_a_reframing_pan_shows_no_black_at_its_ends_in_a_512_px_grab(
        self, media_factory: Callable[..., Path], tmp_project_dir: Path
    ) -> None:
        pytest.importorskip("PIL")
        source = media_factory(
            "pan_source.mp4", seconds=2.0, with_audio=False, color="red", size="640x360"
        )
        (tmp_project_dir / "pan.mp4").write_bytes(source.read_bytes())
        # 640x360 fit into 1080x1920 is 1080x607.5; x3.2 covers the frame at 3456 wide, and
        # ±1188 project pixels is exactly how far it can pan before its edge enters the frame.
        project = _project(
            _PORTRAIT,
            [
                {
                    "id": "v",
                    "type": "video",
                    "clips": [_clip("pan", "a", "v", _pan_keyframes(3.2, 1188.0))],
                }
            ],
            [_video_asset("a", "pan.mp4", (640, 360))],
        )
        for t in (0.0, 1.5):
            frame = grab_frame(project, tmp_project_dir, t, max_dimension=512, image_format="png")
            assert (frame.width, frame.height) == _GRAB_512
            assert _black_ratio(frame.data) < 0.01, t

    def test_an_x_y_keyframed_clip_lands_where_the_project_size_frame_puts_it(
        self, ffmpeg_bin: str, tmp_project_dir: Path
    ) -> None:
        pytest.importorskip("PIL")
        # A white box in the middle of a black 320x180 shot: its centre is where the picture is.
        subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=320x180:r=30:d=2,drawbox=x=140:y=70:w=40:h=40:color=white:t=fill",
                "-pix_fmt",
                "yuv420p",
                str(tmp_project_dir / "box.mp4"),
            ],
            check=True,
            capture_output=True,
        )
        project = _project(
            (640, 360),
            [
                {
                    "id": "v",
                    "type": "video",
                    "clips": [
                        _clip(
                            "box",
                            "a",
                            "v",
                            [_keyframe("x0", 0.0, "x", 160.0), _keyframe("y0", 0.0, "y", -60.0)],
                        )
                    ],
                }
            ],
            [_video_asset("a", "box.mp4", (320, 180))],
        )
        full = grab_frame(project, tmp_project_dir, 1.0, image_format="png", lossless=True)
        small = grab_frame(project, tmp_project_dir, 1.0, max_dimension=160, image_format="png")
        assert (full.width, full.height) == (640, 360)
        assert (small.width, small.height) == (160, 90)
        full_centre, small_centre = _bright_centroid(full.data), _bright_centroid(small.data)
        assert full_centre == pytest.approx((0.75, 1 / 3), abs=0.01)
        assert small_centre is not None, "the box left a 160 px frame it should sit inside"
        assert small_centre == pytest.approx(full_centre, abs=1.5 / 90)
