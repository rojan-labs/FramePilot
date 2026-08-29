"""Quality-driven export settings (plan/system-mission P7.1)."""

from __future__ import annotations

import pytest

from framepilot_engine.render.export_settings import (
    ExportSettings,
    Resolution,
    SourceFacts,
    estimate_size_bytes,
    resolve_export_target,
    resolve_frame,
    video_bitrate_kbps,
)


def facts(w: int, h: int, fps: float = 30.0, max_short: int | None = 2160) -> SourceFacts:
    return SourceFacts(project_width=w, project_height=h, project_fps=fps, max_short_edge=max_short)


@pytest.mark.parametrize(
    ("w", "h", "res", "expect"),
    [
        (1080, 1920, "1080p", (1080, 1920)),
        (1080, 1920, "2160p", (2160, 3840)),
        (1920, 1080, "720p", (1280, 720)),
        (1920, 1080, "1440p", (2560, 1440)),
        (1080, 1080, "480p", (480, 480)),
        (1080, 1350, "1080p", (1080, 1350)),
    ],
)
def test_frame_follows_project_aspect_at_every_resolution(
    w: int, h: int, res: Resolution, expect: tuple[int, int]
) -> None:
    width, height, effective, capped = resolve_frame(res, facts(w, h))
    assert (width, height) == expect
    assert effective == res and capped is False


def test_frame_is_capped_at_the_source_and_says_so() -> None:
    width, height, effective, capped = resolve_frame("2160p", facts(1080, 1920, max_short=1080))
    assert (width, height, effective, capped) == ((1080, 1920, "1080p", True))
    # An unknown source cap never blocks the request.
    assert resolve_frame("2160p", facts(1920, 1080, max_short=None))[3] is False


def test_source_resolution_means_the_largest_source_short_edge() -> None:
    assert resolve_frame("source", facts(1080, 1920, max_short=1440))[:2] == (1440, 2560)


def test_dimensions_are_always_even() -> None:
    width, height, _, _ = resolve_frame("1080p", facts(1079, 1920))
    assert width % 2 == 0 and height % 2 == 0


def test_bitrate_ladder_applies_codec_and_frame_rate_factors() -> None:
    assert video_bitrate_kbps(1080, "recommended", "h264", 30) == 8_000
    assert video_bitrate_kbps(1080, "recommended", "hevc", 30) == 5_200
    assert video_bitrate_kbps(1080, "recommended", "h264", 60) == 12_000
    assert video_bitrate_kbps(2160, "high", "h264", 24) == 45_000
    assert video_bitrate_kbps(900, "low", "h264", 25) == 4_500  # rounds up to the 1080 rung


def test_target_and_size_estimate() -> None:
    settings = ExportSettings(
        resolution="1080p", fps="source", quality="high", video_codec="hevc", container="mov"
    )
    target = resolve_export_target(settings, facts(1080, 1920, fps=29.97))
    assert (target.width, target.height, target.fps) == (1080, 1920, 29.97)
    assert target.video_bitrate_kbps == round(12_000 * 0.65)
    assert target.audio_bitrate_kbps == 256 and target.container == "mov"
    assert estimate_size_bytes(target, 30) == int((7_800 + 256) * 1000 / 8 * 30)
    explicit = resolve_export_target(ExportSettings(bitrate_kbps=3_000), facts(1920, 1080))
    assert explicit.video_bitrate_kbps == 3_000
