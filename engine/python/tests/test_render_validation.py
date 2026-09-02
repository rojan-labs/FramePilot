"""Tests for render validation (PRD §9.4, plan 2.3)."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.analysis.black import BlackRange
from framepilot_engine.analysis.silence import SilentRange
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
    plain_failures,
    tail_seconds,
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


# --- the intended spec: resolution, frame rate, black/silent tails (goal.md F) ---------


def _logs_for(argv: Sequence[str], *, black: str = "", silence: str = "") -> str:
    """Answer each ffmpeg QC pass with its own canned stderr."""
    joined = " ".join(argv)
    if "blackdetect" in joined:
        return black
    if "silencedetect" in joined:
        return silence
    return "max_volume: -6.0 dB"


def _spec(**over: Any) -> ExpectedRender:
    base: dict[str, Any] = {
        "duration_seconds": 10.0,
        "width": 1080,
        "height": 1920,
        "fps": 30.0,
    }
    base.update(over)
    return ExpectedRender(**base)


def _out(tmp_path: Path) -> Path:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 1024)
    return out


def test_tail_seconds_measures_only_a_span_that_reaches_the_end() -> None:
    reaches = [BlackRange(start=8.5, end=9.97, duration=1.47)]
    assert tail_seconds(reaches, 10.0) == pytest.approx(1.5)
    interior = [BlackRange(start=2.0, end=4.0, duration=2.0)]
    assert tail_seconds(interior, 10.0) == 0.0
    assert tail_seconds([], 10.0) == 0.0
    assert tail_seconds([SilentRange(start=9.0, end=10.0, duration=1.0)], 10.0) == pytest.approx(
        1.0
    )


def test_validate_spec_passes_when_the_file_matches(tmp_path: Path) -> None:
    report = validate_render(
        _out(tmp_path), _spec(), probe=lambda _p: _media(10.0), log_runner=_logs_for
    )
    assert report.ok
    assert _status(report, "resolution") == CheckStatus.PASS
    assert _status(report, "frame_rate") == CheckStatus.PASS
    assert _status(report, "black_tail") == CheckStatus.PASS
    assert _status(report, "silent_tail") == CheckStatus.PASS


def test_validate_wrong_resolution_fails(tmp_path: Path) -> None:
    report = validate_render(
        _out(tmp_path),
        _spec(width=1920, height=1080),
        probe=lambda _p: _media(10.0),
        log_runner=_logs_for,
    )
    assert _status(report, "resolution") == CheckStatus.FAIL
    assert "actual=1080x1920 expected=1920x1080" in (
        next(c.detail for c in report.checks if c.name == "resolution") or ""
    )
    assert not report.ok


def test_validate_frame_rate_tolerates_ntsc_and_catches_a_wrong_rate(tmp_path: Path) -> None:
    ntsc = MediaInfo(
        path="/out.mp4",
        duration_seconds=10.0,
        streams=[
            StreamInfo(index=0, codec_type="video", width=1080, height=1920, fps=30000 / 1001),
            _AUDIO_STREAM,
        ],
    )
    ok = validate_render(_out(tmp_path), _spec(), probe=lambda _p: ntsc, log_runner=_logs_for)
    assert _status(ok, "frame_rate") == CheckStatus.PASS
    bad = validate_render(
        _out(tmp_path), _spec(fps=60.0), probe=lambda _p: _media(10.0), log_runner=_logs_for
    )
    assert _status(bad, "frame_rate") == CheckStatus.FAIL


def test_validate_spec_checks_skip_without_an_expectation(tmp_path: Path) -> None:
    report = validate_render(
        _out(tmp_path),
        ExpectedRender(duration_seconds=10.0),
        probe=lambda _p: _media(10.0),
        log_runner=_logs_for,
    )
    assert _status(report, "resolution") == CheckStatus.SKIP
    assert _status(report, "frame_rate") == CheckStatus.SKIP
    assert report.ok


def test_validate_black_tail_fails_while_the_black_ratio_passes(tmp_path: Path) -> None:
    # 1.5 s of black at the end of 10 s: 15% black overall (fine), but the picture ended
    # early — the duration tolerance alone would never see it.
    logs = "black_start:8.5 black_end:9.97 black_duration:1.47"
    report = validate_render(
        _out(tmp_path),
        _spec(),
        probe=lambda _p: _media(10.0),
        log_runner=lambda argv: _logs_for(argv, black=logs),
    )
    assert _status(report, "black_frames") == CheckStatus.PASS
    assert _status(report, "black_tail") == CheckStatus.FAIL
    assert not report.ok


def test_validate_black_tail_skips_when_the_whole_render_is_black(tmp_path: Path) -> None:
    logs = "black_start:0 black_end:9.97 black_duration:9.97"
    report = validate_render(
        _out(tmp_path),
        _spec(),
        probe=lambda _p: _media(10.0),
        log_runner=lambda argv: _logs_for(argv, black=logs),
    )
    assert _status(report, "black_frames") == CheckStatus.FAIL
    # One defect, reported once.
    assert _status(report, "black_tail") == CheckStatus.SKIP


def test_validate_interior_black_is_not_a_tail(tmp_path: Path) -> None:
    logs = "black_start:2 black_end:4 black_duration:2"
    report = validate_render(
        _out(tmp_path),
        _spec(),
        probe=lambda _p: _media(10.0),
        log_runner=lambda argv: _logs_for(argv, black=logs),
    )
    assert _status(report, "black_tail") == CheckStatus.PASS


def test_validate_silent_tail_fails_when_sound_should_reach_the_end(tmp_path: Path) -> None:
    # silencedetect leaves a trailing silence open; the parser closes it at the duration.
    logs = "[silencedetect @ 0x1] silence_start: 8.2"
    report = validate_render(
        _out(tmp_path),
        _spec(),
        probe=lambda _p: _media(10.0),
        log_runner=lambda argv: _logs_for(argv, silence=logs),
    )
    assert _status(report, "silent_tail") == CheckStatus.FAIL
    assert "silent_tail=1.800s" in (
        next(c.detail for c in report.checks if c.name == "silent_tail") or ""
    )


def test_validate_silent_tail_is_the_edit_when_audio_ends_early_by_design(tmp_path: Path) -> None:
    logs = "[silencedetect @ 0x1] silence_start: 8.2"
    report = validate_render(
        _out(tmp_path),
        _spec(expect_audio_to_end=False),
        probe=lambda _p: _media(10.0),
        log_runner=lambda argv: _logs_for(argv, silence=logs),
    )
    assert _status(report, "silent_tail") == CheckStatus.SKIP
    assert report.ok


def test_validate_silent_tail_under_a_second_is_a_fade_not_a_defect(tmp_path: Path) -> None:
    logs = "[silencedetect @ 0x1] silence_start: 9.4"
    report = validate_render(
        _out(tmp_path),
        _spec(),
        probe=lambda _p: _media(10.0),
        log_runner=lambda argv: _logs_for(argv, silence=logs),
    )
    assert _status(report, "silent_tail") == CheckStatus.PASS


def test_validate_silent_tail_skips_without_audio(tmp_path: Path) -> None:
    report = validate_render(
        _out(tmp_path),
        _spec(expect_audio=False),
        probe=lambda _p: _media(10.0, audio=False),
        log_runner=_logs_for,
    )
    assert _status(report, "silent_tail") == CheckStatus.SKIP


def test_plain_failures_speak_to_the_editor(tmp_path: Path) -> None:
    logs = "black_start:8.5 black_end:9.97 black_duration:1.47"
    report = validate_render(
        _out(tmp_path),
        _spec(width=1920, height=1080, fps=60.0),
        probe=lambda _p: _media(10.0),
        log_runner=lambda argv: _logs_for(argv, black=logs),
    )
    lines = plain_failures(report)
    assert lines == [
        "The export is not the requested size (actual=1080x1920 expected=1920x1080).",
        "The export is not the requested frame rate (actual=30.000 expected=60.000).",
        "The export ends on black (black_tail=1.500s).",
    ]
    assert plain_failures(ValidationReport.from_checks("/x", [])) == []


@pytest.mark.usefixtures("require_ffprobe")
def test_validate_real_black_tail_flagged(
    media_factory: Callable[..., Path], ffmpeg_bin: str, tmp_path: Path
) -> None:
    # 1 s of red then 1 s of black, one file: the picture "ends" a second early.
    red = media_factory("tail_red.mp4", seconds=1.0, color="red", with_audio=False)
    black = media_factory("tail_black.mp4", seconds=1.0, color="black", with_audio=False)
    listing = tmp_path / "concat.txt"
    listing.write_text(f"file '{red}'\nfile '{black}'\n")
    out = red.parent / "tail.mp4"
    import subprocess

    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listing),
            "-c",
            "copy",
            str(out),
        ],
        check=True,
        capture_output=True,
    )
    report = validate_render(
        out,
        ExpectedRender(
            expect_audio=False,
            duration_seconds=2.0,
            duration_tolerance_seconds=0.3,
            width=320,
            height=240,
            fps=30.0,
        ),
    )
    assert _status(report, "resolution") == CheckStatus.PASS
    assert _status(report, "frame_rate") == CheckStatus.PASS
    assert _status(report, "black_frames") == CheckStatus.PASS
    assert _status(report, "black_tail") == CheckStatus.FAIL
    assert not report.ok
