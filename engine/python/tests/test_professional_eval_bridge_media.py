"""The eval bridge must stage media a rendered proof can actually measure.

Before this, every staged clip was a flat colour fill. A solid frame cannot show
that anything moved, so any "motion happened" assertion against it could only
ever be checking metadata. These tests decode the staged file and require the
structure the proofs depend on to really be there.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.timeline.models import Project
from framepilot_engine.validation.professional_eval_bridge import (
    _stage_asset,
    block_speed,
    expected_block_left,
)

WIDTH, HEIGHT = 320, 240
DURATION = 4.0


def _project() -> Project:
    return Project.model_validate(
        {
            "id": "p_bridge_media",
            "name": "Bridge media",
            "fps": 30,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": [{"id": "hero", "path": "hero.mp4", "kind": "video"}],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "c",
                                "assetId": "hero",
                                "trackId": "v",
                                "start": 0.0,
                                "end": DURATION,
                                "sourceStart": 0.0,
                                "sourceEnd": DURATION,
                            }
                        ],
                    }
                ]
            },
        }
    )


def _asset(asset_id: str = "hero", kind: str = "video") -> dict[str, Any]:
    suffix = "wav" if kind == "audio" else "mp4"
    return {
        "id": asset_id,
        "path": f"{asset_id}.{suffix}",
        "kind": kind,
        "durationSeconds": DURATION,
    }


def _brightest_column(ffmpeg: str, media: Path, seconds: float) -> int:
    """Column of the brightest pixel on the centre row of one decoded frame."""
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            str(seconds),
            "-i",
            str(media),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    frame = result.stdout
    assert len(frame) == WIDTH * HEIGHT, "unexpected decoded frame size"
    row = frame[(HEIGHT // 2) * WIDTH : (HEIGHT // 2 + 1) * WIDTH]
    return max(range(WIDTH), key=lambda column: row[column])


def test_block_position_is_a_formula_not_a_pasted_number() -> None:
    assert expected_block_left(WIDTH, DURATION, 0.0) == 0.0
    assert expected_block_left(WIDTH, DURATION, DURATION) == pytest.approx(WIDTH * 0.5)
    # Halving the duration doubles the speed, so travel over the clip is constant.
    assert block_speed(WIDTH, DURATION / 2) == pytest.approx(block_speed(WIDTH, DURATION) * 2)


def test_the_block_stays_inside_the_frame_for_the_whole_clip() -> None:
    # A block that leaves frame would clip the centroid and under-report travel.
    assert expected_block_left(WIDTH, DURATION, DURATION) + WIDTH * 0.2 <= WIDTH


def test_staged_video_actually_contains_a_moving_block(tmp_path: Path) -> None:
    ffmpeg = find_ffmpeg()
    _stage_asset(ffmpeg, tmp_path, _asset(), _project())
    media = tmp_path / "hero.mp4"
    assert media.stat().st_size > 1_000

    early = _brightest_column(ffmpeg, media, 0.5)
    late = _brightest_column(ffmpeg, media, 3.0)

    travelled = late - early
    expected = block_speed(WIDTH, DURATION) * 2.5
    assert travelled == pytest.approx(expected, abs=12.0), (
        "the staged clip does not carry the motion the proofs measure"
    )


def test_a_wrong_direction_fails_the_same_measurement(tmp_path: Path) -> None:
    """Negative control: the measurement must reject a plausible wrong answer."""
    ffmpeg = find_ffmpeg()
    _stage_asset(ffmpeg, tmp_path, _asset(), _project())
    media = tmp_path / "hero.mp4"

    travelled = _brightest_column(ffmpeg, media, 3.0) - _brightest_column(ffmpeg, media, 0.5)

    assert travelled > 0, "the block must move right, not left or nowhere"
    assert travelled != pytest.approx(0.0, abs=12.0)


def test_different_assets_stay_visually_distinguishable(tmp_path: Path) -> None:
    ffmpeg = find_ffmpeg()
    project = _project()
    _stage_asset(ffmpeg, tmp_path, _asset("hero"), project)
    _stage_asset(ffmpeg, tmp_path, _asset("angle_b"), project)

    assert (tmp_path / "hero.mp4").read_bytes() != (tmp_path / "angle_b.mp4").read_bytes()


def test_audio_assets_still_stage(tmp_path: Path) -> None:
    ffmpeg = find_ffmpeg()
    _stage_asset(ffmpeg, tmp_path, _asset("music", kind="audio"), _project())

    assert (tmp_path / "music.wav").stat().st_size > 1_000
