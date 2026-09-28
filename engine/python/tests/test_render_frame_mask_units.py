"""Frame-space masks are drawn in PROJECT pixels at every render size.

WHY: a clip mask fixed to the frame (``space: 'frame'``, MK9.1) and an adjustment lane's mask
(MK5.2) are authored on the monitor in the project's own frame (``MaskCanvasTools`` edits them in
a ``viewBox`` of the project resolution; the schema calls them output-frame pixels). The engine
drew their geometry on whatever frame it was rendering, as if that frame were the project's. The
export at the project's size was right; a frame grab (512 px) or the temporal review evidence
(540x960) drew the same numbers on a smaller frame, so a mask over the right of the picture fell
off a 160 px grab entirely. Same bug class as keyframed ``x``/``y``
(``test_render_keyframe_offset_units.py``).
"""

from __future__ import annotations

import io
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.frame_grab import grab_frame
from framepilot_engine.render.frame_masks import layer_mask_stack
from framepilot_engine.render.layer_mattes import PicturePlacement
from framepilot_engine.render.mask_stack import clip_mask_stacks
from framepilot_engine.timeline.models import Clip, EffectLayer, Project

PROJECT = (640, 360)
SMALL = (160, 90)

#: A feathered, turned rectangle over the upper right of the project frame, in project pixels.
RECT: dict[str, Any] = {
    "id": "m",
    "kind": "rectangle",
    "space": "frame",
    "cx": 480.0,
    "cy": 90.0,
    "width": 160.0,
    "height": 120.0,
    "rotation": 10.0,
    "featherOuterPx": 8.0,
}


def _lane(masks: list[dict[str, Any]]) -> EffectLayer:
    return EffectLayer.model_validate(
        {
            "id": "fx",
            "effectId": "fx",
            "kind": "neon-edge",
            "start": 0.0,
            "end": 2.0,
            "params": {},
            "keyframes": [],
            "masks": masks,
        }
    )


def _box(alpha: np.ndarray, threshold: float = 0.5) -> tuple[float, float, float, float] | None:
    """Where ``alpha`` exceeds ``threshold``, as ``(x0, x1, y0, y1)`` fractions of its frame."""
    ys, xs = np.nonzero(alpha > threshold)
    if xs.size == 0:
        return None
    height, width = alpha.shape
    return (
        float(xs.min()) / width,
        float(xs.max() + 1) / width,
        float(ys.min()) / height,
        float(ys.max() + 1) / height,
    )


def _one_pixel_of(size: tuple[int, int]) -> float:
    return 1.0 / min(size) + 1e-9


class TestAdjustmentLaneMask:
    def test_a_smaller_frame_draws_the_project_frame_mask_scaled(self) -> None:
        stack = layer_mask_stack(_lane([RECT]))
        assert stack is not None
        full = stack.alpha_at(0.0, *PROJECT)
        small = stack.alpha_at(0.0, *SMALL, geometry_size=(float(PROJECT[0]), float(PROJECT[1])))
        full_box, small_box = _box(full), _box(small)
        assert full_box is not None
        assert small_box == pytest.approx(full_box, abs=_one_pixel_of(SMALL))
        # Unconverted, the same numbers on the small frame miss it entirely.
        assert _box(stack.alpha_at(0.0, *SMALL)) is None

    def test_the_project_frame_itself_is_unchanged_to_the_byte(self) -> None:
        stack = layer_mask_stack(_lane([RECT]))
        assert stack is not None
        converted = stack.alpha_at(0.0, *PROJECT, geometry_size=(640.0, 360.0))
        assert np.array_equal(converted, stack.alpha_at(0.0, *PROJECT))


class TestFrameSpaceClipMask:
    def _alpha(self, frame: tuple[int, int], geometry: tuple[float, float] | None) -> np.ndarray:
        """A full-frame clip's frame-space mask, drawn on ``frame`` with the picture filling it."""
        clip = Clip.model_validate(
            {
                "id": "c",
                "assetId": "a",
                "trackId": "v",
                "start": 0.0,
                "end": 2.0,
                "sourceStart": 0.0,
                "sourceEnd": 2.0,
                "masks": [RECT],
            }
        )

        def placements(
            _t: float, width: int, height: int
        ) -> tuple[PicturePlacement, tuple[int, int]]:
            return PicturePlacement(width, height, frame[0], frame[1], 0.0, 0, 0), frame

        stacks = clip_mask_stacks(
            clip, (1920.0, 1080.0), placements=placements, frame_geometry_size=geometry
        )
        assert stacks is not None
        alpha = stacks.alpha_at(0.0, *frame)
        assert alpha is not None
        return alpha

    def test_a_smaller_frame_draws_the_project_frame_mask_scaled(self) -> None:
        full_box = _box(self._alpha(PROJECT, None))
        small_box = _box(self._alpha(SMALL, (float(PROJECT[0]), float(PROJECT[1]))))
        assert full_box is not None
        assert small_box == pytest.approx(full_box, abs=_one_pixel_of(SMALL))
        assert _box(self._alpha(SMALL, None)) is None

    def test_the_project_frame_itself_is_unchanged_to_the_byte(self) -> None:
        assert np.array_equal(self._alpha(PROJECT, (640.0, 360.0)), self._alpha(PROJECT, None))


def _render_project(clip_masks: list[dict[str, Any]] | None, lane: bool) -> Project:
    clip: dict[str, Any] = {
        "id": "c",
        "assetId": "a",
        "trackId": "v",
        "start": 0.0,
        "end": 2.0,
        "sourceStart": 0.0,
        "sourceEnd": 2.0,
    }
    if clip_masks:
        clip["masks"] = clip_masks
    track: dict[str, Any] = {"id": "v", "type": "video", "clips": [clip]}
    if lane:
        track["effectLayers"] = [_lane([RECT]).model_dump(by_alias=True, mode="json")]
    return Project.model_validate(
        {
            "id": "p",
            "name": "frame mask units",
            "fps": 30,
            "resolution": {"width": PROJECT[0], "height": PROJECT[1]},
            "assets": [
                {
                    "id": "a",
                    "path": "white.mp4",
                    "kind": "video",
                    "durationSeconds": 2.0,
                    "media": {"width": PROJECT[0], "height": PROJECT[1]},
                }
            ],
            "timeline": {"tracks": [track]},
        }
    )


def _luma(data: bytes) -> np.ndarray:
    from PIL import Image

    return np.asarray(Image.open(io.BytesIO(data)).convert("L"), dtype=np.float64) / 255.0


def _region(data: bytes, region: str) -> np.ndarray:
    """1 where the frame shows the mask: a frame-space cut-out keeps the white picture inside it
    (``bright``); a masked neon-edge lane dims the white only inside it (``dim``)."""
    luma = _luma(data)
    inside = luma > 0.5 if region == "bright" else luma < 0.78
    return inside.astype(np.float64)


@pytest.mark.usefixtures("require_ffprobe")
class TestRenderedAtAnotherSize:
    @pytest.fixture
    def white(self, ffmpeg_bin: str, tmp_project_dir: Path) -> Path:
        pytest.importorskip("PIL")
        subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"color=c=white:s={PROJECT[0]}x{PROJECT[1]}:r=30:d=2",
                "-pix_fmt",
                "yuv420p",
                str(tmp_project_dir / "white.mp4"),
            ],
            check=True,
            capture_output=True,
        )
        return tmp_project_dir

    def _boxes(
        self, project: Project, base: Path, region: str
    ) -> tuple[tuple[float, ...] | None, tuple[float, ...] | None]:
        full = grab_frame(project, base, 1.0, image_format="png", lossless=True)
        small = grab_frame(project, base, 1.0, max_dimension=SMALL[0], image_format="png")
        assert (small.width, small.height) == SMALL
        return (_box(_region(full.data, region)), _box(_region(small.data, region)))

    def test_a_frame_space_clip_mask_lands_where_the_project_frame_puts_it(
        self, white: Path
    ) -> None:
        full_box, small_box = self._boxes(_render_project([RECT], lane=False), white, "bright")
        assert full_box is not None
        assert small_box is not None, "the mask left a 160 px grab it should sit inside"
        assert small_box == pytest.approx(full_box, abs=1.5 / min(SMALL))

    def test_an_adjustment_lane_mask_lands_where_the_project_frame_puts_it(
        self, white: Path
    ) -> None:
        full_box, small_box = self._boxes(_render_project(None, lane=True), white, "dim")
        assert full_box is not None
        assert small_box is not None, "the lane's mask left a 160 px grab it should sit inside"
        assert small_box == pytest.approx(full_box, abs=1.5 / min(SMALL))
