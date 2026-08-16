"""Tests for ffprobe parsing and inspect_media (media.probe)."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.media.probe import (
    MediaInfo,
    StreamInfo,
    inspect_media,
    parse_ffprobe_json,
)

# A representative ffprobe payload: one video stream (NTSC-ish fps) + one audio.
_AV_JSON = json.dumps(
    {
        "streams": [
            {
                "index": 0,
                "codec_type": "video",
                "codec_name": "h264",
                "width": 1920,
                "height": 1080,
                "avg_frame_rate": "30000/1001",
                "r_frame_rate": "30/1",
                "duration": "5.0",
            },
            {
                "index": 1,
                "codec_type": "audio",
                "codec_name": "aac",
                "sample_rate": "48000",
                "channels": "2",
                "duration": "5.0",
            },
        ],
        "format": {"duration": "5.0", "format_name": "mov,mp4,m4a", "size": "123456"},
    }
)


def _image_info(format_name: str | None, duration: float | None) -> MediaInfo:
    """A single-frame video stream, no audio — the shape ffprobe returns for a photo."""
    return MediaInfo(
        path="/photo",
        duration_seconds=duration,
        format_name=format_name,
        streams=[StreamInfo(index=0, codec_type="video", codec_name="mjpeg")],
    )


@pytest.mark.parametrize(
    "format_name",
    ["image2", "png_pipe", "mjpeg", "jpeg_pipe", "webp_pipe", "bmp_pipe", "tiff_pipe"],
)
def test_is_image_true_for_still_formats_despite_bogus_duration(format_name: str) -> None:
    # ffprobe hands a photo a bogus ~0.04s duration; the container format wins.
    assert _image_info(format_name, 0.04).is_image is True


def test_is_image_true_for_durationless_single_frame() -> None:
    # No known image format and no duration → still safest read as a single frame.
    assert _image_info(None, None).is_image is True


def test_is_image_false_for_real_video() -> None:
    assert parse_ffprobe_json("/x.mp4", _AV_JSON).is_image is False


def test_is_image_false_for_silent_video_with_duration() -> None:
    # A silent clip with a real duration and a container (mp4) format is a video.
    assert _image_info("mov,mp4,m4a", 8.0).is_image is False


def test_is_image_false_when_audio_present() -> None:
    info = MediaInfo(
        path="/x",
        duration_seconds=0.04,
        format_name="image2",
        streams=[
            StreamInfo(index=0, codec_type="video", codec_name="mjpeg"),
            StreamInfo(index=1, codec_type="audio", codec_name="aac"),
        ],
    )
    assert info.is_image is False


def test_parse_av_streams() -> None:
    info = parse_ffprobe_json("/x.mp4", _AV_JSON)
    assert info.duration_seconds == 5.0
    assert info.format_name == "mov,mp4,m4a"
    assert info.size_bytes == 123456
    assert info.has_video and info.has_audio
    assert info.width == 1920
    assert info.height == 1080
    assert info.fps == pytest.approx(30000 / 1001)
    assert info.audio_streams[0].sample_rate == 48000
    assert info.audio_streams[0].channels == 2


def test_parse_falls_back_to_r_frame_rate_when_avg_zero() -> None:
    payload = json.dumps(
        {
            "streams": [
                {"index": 0, "codec_type": "video", "avg_frame_rate": "0/0", "r_frame_rate": "25/1"}
            ],
            "format": {},
        }
    )
    info = parse_ffprobe_json("/x.mp4", payload)
    assert info.fps == 25.0


def test_fps_none_for_audio_even_with_rate() -> None:
    payload = json.dumps(
        {"streams": [{"index": 0, "codec_type": "audio", "avg_frame_rate": "30/1"}], "format": {}}
    )
    info = parse_ffprobe_json("/x.mp4", payload)
    assert info.audio_streams[0].fps is None


def test_parse_handles_na_and_missing_fields() -> None:
    payload = json.dumps(
        {
            "streams": [{"index": "N/A", "codec_type": "video", "width": "N/A", "duration": "N/A"}],
            "format": {"duration": "N/A", "size": None},
        }
    )
    info = parse_ffprobe_json("/x.mp4", payload)
    assert info.duration_seconds is None
    assert info.size_bytes is None
    assert info.streams[0].index == 0
    assert info.streams[0].width is None


def test_parse_bad_fraction_yields_none_fps() -> None:
    payload = json.dumps(
        {
            "streams": [{"index": 0, "codec_type": "video", "avg_frame_rate": "abc/def"}],
            "format": {},
        }
    )
    info = parse_ffprobe_json("/x.mp4", payload)
    assert info.streams[0].fps is None


def test_no_video_streams_properties_none() -> None:
    info = parse_ffprobe_json("/a.wav", json.dumps({"streams": [], "format": {}}))
    assert not info.has_video
    assert info.width is None and info.height is None and info.fps is None


def test_parse_invalid_json_raises() -> None:
    with pytest.raises(FFmpegError):
        parse_ffprobe_json("/x.mp4", "not json {")


def test_inspect_media_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        inspect_media(tmp_path / "nope.mp4")


def test_inspect_media_with_injected_runner(tmp_path: Path) -> None:
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"\x00")  # existence is all the primitive checks
    captured: dict[str, list[str]] = {}

    def fake_runner(argv: Sequence[str]) -> str:
        captured["argv"] = list(argv)
        return _AV_JSON

    info = inspect_media(media, runner=fake_runner)
    assert isinstance(info, MediaInfo)
    assert info.fps == pytest.approx(30000 / 1001)
    assert str(media) in captured["argv"]
    assert "-show_streams" in captured["argv"]


@pytest.mark.usefixtures("require_ffprobe")
def test_inspect_media_real_file(media_factory: Callable[..., Path]) -> None:
    path = media_factory("probe_av.mp4", seconds=1.0, with_audio=True)
    info = inspect_media(path)
    assert info.has_video and info.has_audio
    assert info.width == 320 and info.height == 240
    assert info.duration_seconds == pytest.approx(1.0, abs=0.2)
