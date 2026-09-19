"""Mattes on rotated and anamorphic footage (BR2.6): the artifact is in DISPLAY space.

The export decodes a rotated source already turned and an anamorphic source stretched to square
pixels (MK1.9, PX2.9), so a display-space matte lies on the picture pixel for pixel. Each test
exports a clip and compares it with ``picture * alpha`` computed from the export's own decoded
picture and the matte, so a matte read in coded orientation or coded width fails.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from moviepy import VideoFileClip

from framepilot_engine.media.assets import index_assets
from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.render.compiler import CompileError, compile_timeline
from framepilot_engine.render.mattes import matte_display_size
from framepilot_engine.render.presets import frame_target
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import AssetMedia, Project
from tests import matte_fixtures as fx

pytestmark = pytest.mark.usefixtures("require_ffprobe")

DISPLAY_W, DISPLAY_H = 64, 36
FRAMES = 6


def _coded_frames(width: int, height: int) -> list[np.ndarray]:
    ys, xs = np.mgrid[0:height, 0:width]
    frames = []
    for k in range(FRAMES):
        frame = np.stack(
            [(xs * 7 + ys * 2 + k * 5) % 256, (ys * 9) % 256, np.full_like(xs, 90 + k)], axis=-1
        )
        frames.append(frame.astype(np.uint8))
    return frames


def _display_alpha() -> list[np.ndarray]:
    ys, xs = np.mgrid[0:DISPLAY_H, 0:DISPLAY_W]
    return [((xs * 4 + ys * ys) % 256).astype(np.uint8) for _ in range(FRAMES)]


def _project(media: dict[str, Any], artifact: dict[str, Any]) -> Project:
    return Project.model_validate(
        {
            "id": "p",
            "name": "p",
            "fps": 30,
            "resolution": {"width": DISPLAY_W, "height": DISPLAY_H},
            "assets": [{"id": "a", "path": "src.mov", "kind": "video", "media": media}],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "c",
                                "assetId": "a",
                                "trackId": "v",
                                "start": 0.0,
                                "end": 0.1,
                                "sourceStart": 0.0,
                                "sourceEnd": 0.1,
                                "masks": [fx.matte_mask("m", artifact, decontaminate=False)],
                            }
                        ],
                    }
                ]
            },
        }
    )


def _encode(root: Path, frames: list[np.ndarray], extra: list[str]) -> Path:
    height, width = frames[0].shape[:2]
    coded = root / "coded.mov"
    subprocess.run(
        [
            find_ffmpeg(),
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{width}x{height}",
            "-r",
            "30",
            "-i",
            "-",
            *extra,
            "-c:v",
            "png",
            str(coded),
        ],
        input=b"".join(frame.tobytes() for frame in frames),
        check=True,
        capture_output=True,
        timeout=60,
    )
    return coded


def _export_matches_picture_times_matte(
    root: Path, media: dict[str, Any], decode: dict[str, Any]
) -> None:
    alpha = _display_alpha()
    artifact = fx.write_artifact(root, pts=list(range(FRAMES)), time_base=(1, 30), mattes=alpha)
    project = _project(media, artifact)
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], root)
    composite = compile_timeline(project, index, frame_target(DISPLAY_W, DISPLAY_H, 30))
    reference = VideoFileClip(str(root / "src.mov"), **decode)
    try:
        for k in (0, 2):
            picture = np.asarray(reference.get_frame(k / 30), dtype=np.float64)
            assert picture.shape == (DISPLAY_H, DISPLAY_W, 3)
            expected = picture * (alpha[k].astype(np.float64) / 255.0)[:, :, None]
            actual = np.asarray(composite.get_frame(k / 30), dtype=np.float64)
            assert float(np.abs(actual - expected).max()) <= 1.0
    finally:
        reference.close()
        close_clip_tree(composite)


def test_display_size_rule() -> None:
    assert matte_display_size(None) is None
    assert matte_display_size(AssetMedia.model_validate({"width": 36, "height": 64})) == (36, 64)
    rotated = AssetMedia.model_validate({"width": 36, "height": 64, "rotation": 270})
    assert matte_display_size(rotated) == (64, 36)
    anamorphic = AssetMedia.model_validate(
        {"width": 1440, "height": 1080, "pixelAspectRatio": 4 / 3}
    )
    assert matte_display_size(anamorphic) == (1920, 1080)
    half = AssetMedia.model_validate({"width": 3, "height": 2, "pixelAspectRatio": 1.5})
    assert matte_display_size(half) == (5, 2)  # 4.5 rounds up, as editor-core does


def test_rotated_source_takes_a_display_space_matte(tmp_path: Path) -> None:
    coded = _encode(tmp_path, _coded_frames(DISPLAY_H, DISPLAY_W), [])
    subprocess.run(
        [
            find_ffmpeg(),
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-display_rotation",
            "90",
            "-i",
            str(coded),
            "-c",
            "copy",
            str(tmp_path / "src.mov"),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )
    media = {"width": DISPLAY_H, "height": DISPLAY_W, "rotation": 270}
    _export_matches_picture_times_matte(tmp_path, media, {})


def test_rotated_source_refuses_a_coded_space_matte(tmp_path: Path) -> None:
    coded = _encode(tmp_path, _coded_frames(DISPLAY_H, DISPLAY_W), [])
    coded.rename(tmp_path / "src.mov")
    artifact = fx.write_artifact(
        tmp_path,
        pts=list(range(FRAMES)),
        time_base=(1, 30),
        mattes=[np.zeros((DISPLAY_W, DISPLAY_H), dtype=np.uint8)] * FRAMES,
    )
    project = _project({"width": DISPLAY_H, "height": DISPLAY_W, "rotation": 90}, artifact)
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], tmp_path)
    with pytest.raises(CompileError, match="matte_size_mismatch"):
        compile_timeline(project, index, frame_target(DISPLAY_W, DISPLAY_H, 30))


def test_anamorphic_source_takes_a_display_space_matte(tmp_path: Path) -> None:
    coded = _encode(tmp_path, _coded_frames(DISPLAY_W // 2, DISPLAY_H), ["-vf", "setsar=2"])
    coded.rename(tmp_path / "src.mov")
    media = {"width": DISPLAY_W // 2, "height": DISPLAY_H, "pixelAspectRatio": 2.0}
    _export_matches_picture_times_matte(
        tmp_path, media, {"target_resolution": (DISPLAY_W, DISPLAY_H)}
    )
