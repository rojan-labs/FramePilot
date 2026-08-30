"""Encoder selection (plan/system-mission P7.4)."""

from __future__ import annotations

import pytest

from framepilot_engine.render.encoders import (
    choose_encoder,
    hardware_encoding_enabled,
    parse_encoder_list,
)

SAMPLE = """Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
"""


def test_parses_video_encoder_names_only() -> None:
    assert parse_encoder_list(SAMPLE) == {"libx264", "h264_videotoolbox", "libx265"}


def test_prefers_hardware_when_available_and_allowed() -> None:
    choice = choose_encoder("h264", available={"libx264", "h264_videotoolbox"}, allow_hardware=True)
    assert choice.name == "h264_videotoolbox" and choice.hardware is True and choice.preset is None
    assert "-movflags" in choice.ffmpeg_params and "-allow_sw" in choice.ffmpeg_params


def test_falls_back_to_software_with_a_quality_preset() -> None:
    choice = choose_encoder("hevc", quality="high", available={"libx265"}, allow_hardware=True)
    assert (choice.name, choice.hardware, choice.preset) == ("libx265", False, "slow")
    assert choice.ffmpeg_params[-2:] == ["-tag:v", "hvc1"]
    fast = choose_encoder("h264", quality="low", available={"libx264"}, allow_hardware=False)
    assert fast.preset == "veryfast" and "-tag:v" not in fast.ffmpeg_params


def test_env_toggle_disables_hardware() -> None:
    assert hardware_encoding_enabled({"FRAMEPILOT_HW_ENCODE": "0"}) is False
    assert hardware_encoding_enabled({}) is True
    choice = choose_encoder(
        "h264", available={"h264_videotoolbox", "libx264"}, allow_hardware=False
    )
    assert choice.name == "libx264"


def test_rejects_an_unknown_codec() -> None:
    with pytest.raises(ValueError):
        choose_encoder("av1", available=set())
