"""Tests for derived media: proxy, frame, thumbnails (media.derive)."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from itertools import pairwise
from pathlib import Path

import pytest

from framepilot_engine.media.derive import (
    DEFAULT_PROXY_FPS,
    extract_frame,
    generate_proxy,
    generate_thumbnails,
    thumbnail_timestamps,
)
from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.media.probe import inspect_media

# --- pure timestamp helper ---------------------------------------------------


def test_thumbnail_timestamps_are_segment_midpoints() -> None:
    assert thumbnail_timestamps(8.0, 4) == [1.0, 3.0, 5.0, 7.0]


def test_thumbnail_timestamps_single() -> None:
    assert thumbnail_timestamps(10.0, 1) == [5.0]


def test_thumbnail_timestamps_rejects_bad_count() -> None:
    with pytest.raises(ValueError, match="count must be"):
        thumbnail_timestamps(5.0, 0)


def test_thumbnail_timestamps_rejects_bad_duration() -> None:
    with pytest.raises(ValueError, match="duration_seconds must be"):
        thumbnail_timestamps(0.0, 3)


# --- ffmpeg argv (injected runner, no real encode) ---------------------------


def test_generate_proxy_builds_scale_argv(tmp_path: Path) -> None:
    source = tmp_path / "in.mp4"
    source.write_bytes(b"\x00")
    captured: dict[str, Sequence[str]] = {}

    def runner(argv: Sequence[str]) -> str:
        captured["argv"] = argv
        return ""

    out = generate_proxy(source, tmp_path / "proxy.mp4", height=480, runner=runner)
    assert out == tmp_path / "proxy.mp4"
    assert "scale=-2:480,fps=30" in captured["argv"]


def _argv_pairs(argv: Sequence[str]) -> dict[str, str]:
    """Zip ``[..., "-flag", "value", ...]`` into ``{"-flag": "value"}`` for assertions."""
    return dict(pairwise(argv))


def test_generate_proxy_p1_cfr_and_gop_are_short_and_closed(tmp_path: Path) -> None:
    """P-1 (preview WebCodecs compositor plan): CFR + a short closed GOP with no
    B-frames, so a seek to an arbitrary cut point never decodes more than
    ~0.5s of runway — this is what made the reported preview jitter possible
    with the prior ~250-frame scene-cut GOP."""
    source = tmp_path / "in.mp4"
    source.write_bytes(b"\x00")
    captured: dict[str, Sequence[str]] = {}

    def runner(argv: Sequence[str]) -> str:
        captured["argv"] = argv
        return ""

    generate_proxy(source, tmp_path / "proxy.mp4", runner=runner)
    argv = captured["argv"]
    flags = _argv_pairs(argv)

    assert f"scale=-2:{540},fps={DEFAULT_PROXY_FPS}" in argv
    assert flags["-g"] == flags["-keyint_min"] == str(DEFAULT_PROXY_FPS // 2)
    assert flags["-sc_threshold"] == "0"
    assert flags["-bf"] == "0"
    assert "+cgop" in argv


def test_generate_proxy_p1_tags_bt709_and_faststart(tmp_path: Path) -> None:
    """Untagged color space is a real "preview != export" bug class (601 vs 709
    guessed differently by resolution); faststart gives O(1) random access for
    a future demuxer instead of a trailing moov atom."""
    source = tmp_path / "in.mp4"
    source.write_bytes(b"\x00")
    captured: dict[str, Sequence[str]] = {}

    def runner(argv: Sequence[str]) -> str:
        captured["argv"] = argv
        return ""

    generate_proxy(source, tmp_path / "proxy.mp4", runner=runner)
    flags = _argv_pairs(captured["argv"])

    assert flags["-colorspace"] == "bt709"
    assert flags["-color_primaries"] == "bt709"
    assert flags["-color_trc"] == "bt709"
    assert flags["-pix_fmt"] == "yuv420p"
    assert flags["-profile:v"] == "high"
    assert "+faststart" in captured["argv"]
    assert flags["-ar"] == "48000"


def test_generate_proxy_gop_scales_with_fps(tmp_path: Path) -> None:
    source = tmp_path / "in.mp4"
    source.write_bytes(b"\x00")
    captured: dict[str, Sequence[str]] = {}

    def runner(argv: Sequence[str]) -> str:
        captured["argv"] = argv
        return ""

    generate_proxy(source, tmp_path / "proxy.mp4", fps=24, runner=runner)
    flags = _argv_pairs(captured["argv"])
    assert flags["-g"] == flags["-keyint_min"] == "12"


def test_generate_proxy_gop_never_zero_at_low_fps(tmp_path: Path) -> None:
    """``fps // 2`` cannot floor to a 0-frame GOP even at pathological low fps."""
    source = tmp_path / "in.mp4"
    source.write_bytes(b"\x00")
    captured: dict[str, Sequence[str]] = {}

    def runner(argv: Sequence[str]) -> str:
        captured["argv"] = argv
        return ""

    generate_proxy(source, tmp_path / "proxy.mp4", fps=1, runner=runner)
    flags = _argv_pairs(captured["argv"])
    assert flags["-g"] == flags["-keyint_min"] == "1"


def test_generate_proxy_missing_source_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        generate_proxy(tmp_path / "nope.mp4", tmp_path / "out.mp4")


def test_extract_frame_missing_source_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        extract_frame(tmp_path / "nope.mp4", tmp_path / "f.png")


# --- real ffmpeg integration -------------------------------------------------


@pytest.mark.usefixtures("require_ffprobe")
def test_generate_proxy_real(tmp_path: Path, media_factory: Callable[..., Path]) -> None:
    source = media_factory("proxy_src.mp4", seconds=1.0, size="640x480", with_audio=False)
    out = generate_proxy(source, tmp_path / "proxy.mp4", height=120)
    assert out.is_file()
    info = inspect_media(out)
    assert info.height == 120


@pytest.mark.usefixtures("require_ffprobe")
def test_generate_proxy_real_is_cfr_at_target_fps(
    tmp_path: Path, media_factory: Callable[..., Path]
) -> None:
    """P-1: the proxy must be constant-frame-rate at the requested fps — a real
    encode assertion, since ffprobe's average-fps can mask VFR passthrough that
    a hand-built argv assertion cannot catch."""
    source = media_factory("proxy_cfr_src.mp4", seconds=1.0, size="640x480", with_audio=False)
    out = generate_proxy(source, tmp_path / "proxy.mp4", height=120, fps=24)
    info = inspect_media(out)
    assert info.video_streams
    assert info.video_streams[0].fps == pytest.approx(24.0, abs=0.1)


@pytest.mark.usefixtures("require_ffprobe")
def test_extract_frame_real(tmp_path: Path, media_factory: Callable[..., Path]) -> None:
    source = media_factory("frame_src.mp4", seconds=1.0, with_audio=False)
    out = extract_frame(source, tmp_path / "still.png", time_seconds=0.5)
    assert out.is_file() and out.stat().st_size > 0


@pytest.mark.usefixtures("require_ffprobe")
def test_generate_thumbnails_real(tmp_path: Path, media_factory: Callable[..., Path]) -> None:
    source = media_factory("thumb_src.mp4", seconds=2.0, with_audio=False)
    paths = generate_thumbnails(source, tmp_path / "thumbs", count=3)
    assert len(paths) == 3
    assert all(p.is_file() for p in paths)
    assert [p.name for p in paths] == ["thumb_000.png", "thumb_001.png", "thumb_002.png"]


def test_generate_thumbnails_no_duration_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "weird.mp4"
    source.write_bytes(b"\x00")

    from framepilot_engine.media.probe import MediaInfo

    monkeypatch.setattr(
        "framepilot_engine.media.derive.inspect_media",
        lambda _p, *, timeout=None: MediaInfo(path=str(source), duration_seconds=None),
    )
    with pytest.raises(FFmpegError, match="no known duration"):
        generate_thumbnails(source, tmp_path / "thumbs", count=2)


def test_generate_thumbnails_bounds_probe_with_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The internal duration probe must receive the caller's timeout so a crafted
    source cannot hang the lookup that precedes frame extraction."""
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"\x00")

    from framepilot_engine.media.probe import MediaInfo

    seen: dict[str, float | None] = {}

    def _fake_inspect(_p: Path, *, timeout: float | None = None) -> MediaInfo:
        seen["timeout"] = timeout
        return MediaInfo(path=str(source), duration_seconds=8.0)

    monkeypatch.setattr("framepilot_engine.media.derive.inspect_media", _fake_inspect)

    def _runner(_argv: Sequence[str]) -> str:
        return ""

    generate_thumbnails(source, tmp_path / "thumbs", count=2, runner=_runner, timeout=17.0)
    assert seen["timeout"] == 17.0
