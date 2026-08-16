"""Tests for render validation (PRD §9.4, plan 2.3)."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.media.probe import MediaInfo, StreamInfo, inspect_media
from framepilot_engine.validation.render_validation import (
    CheckStatus,
    ExpectedRender,
    ValidationReport,
    detect_black_seconds,
    detect_max_volume_dbfs,
    parse_black_seconds,
    parse_max_volume_dbfs,
    validate_render,
)

_VIDEO_STREAM = StreamInfo(index=0, codec_type="video", width=1080, height=1920, fps=30.0)
_AUDIO_STREAM = StreamInfo(index=1, codec_type="audio", sample_rate=48000, channels=2)


def _media(duration: float | None, *, video: bool = True, audio: bool = True) -> MediaInfo:
    streams = []
    if video:
        streams.append(_VIDEO_STREAM)
    if audio:
        streams.append(_AUDIO_STREAM)
    return MediaInfo(path="/out.mp4", duration_seconds=duration, streams=streams)


def _status(report: ValidationReport, name: str) -> CheckStatus:
    return next(c.status for c in report.checks if c.name == name)


# --- pure parsers ------------------------------------------------------------


def test_parse_black_seconds_sums_intervals() -> None:
    logs = "black_start:0 black_end:2 black_duration:2\nblack_duration:1.5\n"
    assert parse_black_seconds(logs) == pytest.approx(3.5)


def test_parse_black_seconds_none() -> None:
    assert parse_black_seconds("no black here") == 0.0


def test_parse_max_volume_found() -> None:
    assert parse_max_volume_dbfs("[volumedetect] max_volume: -3.1 dB") == pytest.approx(-3.1)


def test_parse_max_volume_absent() -> None:
    assert parse_max_volume_dbfs("nothing useful") is None


# --- detection (injected runner builds correct argv) -------------------------


def test_detect_black_seconds_builds_blackdetect_argv() -> None:
    captured: dict[str, Sequence[str]] = {}

    def runner(argv: Sequence[str]) -> str:
        captured["argv"] = argv
        return "black_duration:4.0"

    assert detect_black_seconds(Path("/out.mp4"), runner=runner) == pytest.approx(4.0)
    assert "blackdetect=d=0.05:pic_th=0.98:pix_th=0.10" in captured["argv"]


def test_detect_max_volume_builds_volumedetect_argv() -> None:
    captured: dict[str, Sequence[str]] = {}

    def runner(argv: Sequence[str]) -> str:
        captured["argv"] = argv
        return "max_volume: -1.0 dB"

    assert detect_max_volume_dbfs(Path("/out.mp4"), runner=runner) == pytest.approx(-1.0)
    assert "volumedetect" in captured["argv"]


# --- validate_render matrix (injected probe + log runner) --------------------


def _ok_logs(_argv: Sequence[str]) -> str:
    # No black intervals, quiet audio peak.
    return "max_volume: -6.0 dB"


def test_validate_passes_clean_render(tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 1024)
    report = validate_render(
        out,
        ExpectedRender(duration_seconds=5.0),
        probe=lambda _p: _media(5.0),
        log_runner=_ok_logs,
    )
    assert report.ok
    assert _status(report, "video_stream") == CheckStatus.PASS
    assert _status(report, "audio_stream") == CheckStatus.PASS
    assert _status(report, "duration") == CheckStatus.PASS
    assert _status(report, "black_frames") == CheckStatus.PASS
    assert _status(report, "audio_clipping") == CheckStatus.PASS


def test_validate_missing_file_fails_fast(tmp_path: Path) -> None:
    report = validate_render(tmp_path / "nope.mp4", ExpectedRender())
    assert not report.ok
    assert report.checks == [report.checks[0]]
    assert _status(report, "file_exists") == CheckStatus.FAIL


def test_validate_empty_file_fails_fast(tmp_path: Path) -> None:
    out = tmp_path / "empty.mp4"
    out.write_bytes(b"")
    report = validate_render(out, ExpectedRender(), probe=lambda _p: _media(5.0))
    assert not report.ok
    assert _status(report, "non_empty") == CheckStatus.FAIL
    assert all(c.name != "duration" for c in report.checks)


def test_validate_probe_failure_fails(tmp_path: Path) -> None:
    out = tmp_path / "corrupt.mp4"
    out.write_bytes(b"\x00" * 16)

    def boom(_p: Path) -> MediaInfo:
        raise FFmpegError("invalid data")

    report = validate_render(out, ExpectedRender(), probe=boom)
    assert not report.ok
    assert _status(report, "probe") == CheckStatus.FAIL


def test_validate_missing_video_stream_fails(tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out, ExpectedRender(), probe=lambda _p: _media(5.0, video=False), log_runner=_ok_logs
    )
    assert _status(report, "video_stream") == CheckStatus.FAIL
    assert _status(report, "black_frames") == CheckStatus.SKIP
    assert not report.ok


def test_validate_missing_audio_stream_fails(tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out, ExpectedRender(), probe=lambda _p: _media(5.0, audio=False), log_runner=_ok_logs
    )
    assert _status(report, "audio_stream") == CheckStatus.FAIL
    assert _status(report, "audio_clipping") == CheckStatus.SKIP


def test_validate_streams_skipped_when_not_expected(tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out,
        ExpectedRender(expect_video=False, expect_audio=False),
        probe=lambda _p: _media(5.0, video=False, audio=False),
        log_runner=_ok_logs,
    )
    assert _status(report, "video_stream") == CheckStatus.SKIP
    assert _status(report, "audio_stream") == CheckStatus.SKIP
    assert report.ok


def test_validate_duration_skipped_without_expectation(tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out,
        ExpectedRender(duration_seconds=None),
        probe=lambda _p: _media(5.0),
        log_runner=_ok_logs,
    )
    assert _status(report, "duration") == CheckStatus.SKIP


def test_validate_duration_out_of_tolerance_fails(tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out,
        ExpectedRender(duration_seconds=5.0, duration_tolerance_seconds=0.1),
        probe=lambda _p: _media(6.0),
        log_runner=_ok_logs,
    )
    assert _status(report, "duration") == CheckStatus.FAIL


def test_validate_duration_unknown_actual_fails(tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out,
        ExpectedRender(duration_seconds=5.0),
        probe=lambda _p: _media(None),
        log_runner=_ok_logs,
    )
    assert _status(report, "duration") == CheckStatus.FAIL


def test_validate_all_black_fails(tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out,
        ExpectedRender(duration_seconds=5.0),
        probe=lambda _p: _media(5.0),
        log_runner=lambda _a: "black_duration:5.0\nmax_volume: -6.0 dB",
    )
    assert _status(report, "black_frames") == CheckStatus.FAIL
    assert not report.ok


def test_validate_black_ratio_unknown_duration_passes(tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out,
        ExpectedRender(duration_seconds=None),
        probe=lambda _p: _media(None),
        log_runner=lambda _a: "black_duration:1.0\nmax_volume: -6.0 dB",
    )
    assert _status(report, "black_frames") == CheckStatus.PASS


def test_validate_full_scale_audio_is_not_clipping(tmp_path: Path) -> None:
    # 0 dBFS is digital full scale — the normal ceiling, not clipping. A real
    # audio-packed export (and AAC's sub-dB decode overshoot) must not be rejected.
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out,
        ExpectedRender(duration_seconds=5.0),
        probe=lambda _p: _media(5.0),
        log_runner=lambda _a: "max_volume: 0.0 dB",
    )
    assert _status(report, "audio_clipping") == CheckStatus.PASS
    assert report.ok


def test_validate_clipping_fails(tmp_path: Path) -> None:
    # Gross overflow well past full scale still fails.
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out,
        ExpectedRender(duration_seconds=5.0),
        probe=lambda _p: _media(5.0),
        log_runner=lambda _a: "max_volume: 3.0 dB",
    )
    assert _status(report, "audio_clipping") == CheckStatus.FAIL
    assert not report.ok


def test_validate_clipping_unmeasurable_skips(tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    report = validate_render(
        out,
        ExpectedRender(duration_seconds=5.0),
        probe=lambda _p: _media(5.0),
        log_runner=lambda _a: "no volume line here",
    )
    assert _status(report, "audio_clipping") == CheckStatus.SKIP


# --- real ffmpeg integration -------------------------------------------------


@pytest.mark.usefixtures("require_ffprobe")
def test_validate_real_render_passes(media_factory: Callable[..., Path]) -> None:
    # Quiet audio (volume 0.3) so the real clipping check passes.
    path = media_factory("good.mp4", seconds=1.0, color="red")
    report = validate_render(
        path,
        ExpectedRender(duration_seconds=1.0, duration_tolerance_seconds=0.3, max_audio_dbfs=10.0),
    )
    assert _status(report, "file_exists") == CheckStatus.PASS
    assert _status(report, "video_stream") == CheckStatus.PASS
    assert _status(report, "black_frames") == CheckStatus.PASS


@pytest.mark.usefixtures("require_ffprobe")
def test_validate_real_black_render_flagged(media_factory: Callable[..., Path]) -> None:
    path = media_factory("black.mp4", seconds=1.0, color="black", with_audio=False)
    report = validate_render(
        path,
        ExpectedRender(expect_audio=False, duration_seconds=1.0, duration_tolerance_seconds=0.3),
    )
    assert _status(report, "black_frames") == CheckStatus.FAIL
    assert not report.ok


@pytest.mark.usefixtures("require_ffprobe")
def test_validate_real_via_inspect_media(media_factory: Callable[..., Path]) -> None:
    # Exercise the default probe (inspect_media) path end-to-end.
    path = media_factory("default_probe.mp4", seconds=1.0)
    report = validate_render(
        path,
        ExpectedRender(duration_seconds=1.0, duration_tolerance_seconds=0.3, max_audio_dbfs=10.0),
        probe=inspect_media,
    )
    assert _status(report, "file_exists") == CheckStatus.PASS
