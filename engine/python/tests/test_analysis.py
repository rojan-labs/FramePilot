"""Tests for ffmpeg-backed media analysis (plan Phase 9.2).

Covers, to 100%: the pure log parsers (fed sample ffmpeg stderr) and the
detection wrappers (injected runner asserts the argv and returns canned logs),
so the whole analysis matrix is exercised without the ffmpeg binary.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest

from framepilot_engine.analysis import silence as silence_module
from framepilot_engine.analysis.scenes import (
    DEFAULT_SCENE_THRESHOLD,
    SceneCut,
    detect_scenes,
    parse_scene_changes,
)
from framepilot_engine.analysis.silence import (
    DEFAULT_MIN_SILENCE_SECONDS,
    DEFAULT_NOISE_FLOOR_DB,
    SilentRange,
    detect_silence,
    parse_silence_ranges,
)
from framepilot_engine.media.ffmpeg import FFmpegError, NoAudioStreamError
from framepilot_engine.media.probe import MediaInfo, StreamInfo

# --- Sample ffmpeg stderr ----------------------------------------------------

_SILENCE_LOG = (
    "[silencedetect @ 0x1] silence_start: 3.20049\n"
    "[silencedetect @ 0x1] silence_end: 5.80000 | silence_duration: 2.59951\n"
    "[silencedetect @ 0x1] silence_start: 9.0\n"
    "[silencedetect @ 0x1] silence_end: 10.5 | silence_duration: 1.5\n"
)

_SCENE_LOG = (
    "[Parsed_showinfo_1 @ 0x1] n:0 pts:0 pts_time:0 duration_time:0.033\n"
    "[Parsed_showinfo_1 @ 0x1] n:1 pts:370688 pts_time:12.3456 duration_time:0.033\n"
    "[Parsed_showinfo_1 @ 0x1] n:2 pts:740000 pts_time:24.5 duration_time:0.033\n"
)


# --- Silence: pure parser ----------------------------------------------------


def test_parse_silence_pairs_start_end() -> None:
    ranges = parse_silence_ranges(_SILENCE_LOG)
    assert ranges == [
        SilentRange(start=3.20049, end=5.8, duration=2.59951),
        SilentRange(start=9.0, end=10.5, duration=1.5),
    ]


def test_parse_silence_none() -> None:
    assert parse_silence_ranges("nothing to see") == []


def test_parse_silence_negative_start_clamped_to_zero() -> None:
    logs = "silence_start: -0.001\nsilence_end: 2.0 | silence_duration: 2.001\n"
    assert parse_silence_ranges(logs) == [SilentRange(start=0.0, end=2.0, duration=2.001)]


def test_parse_silence_trailing_open_closed_with_total_duration() -> None:
    logs = "silence_start: 8.0\n"  # runs to EOF, no silence_end line
    assert parse_silence_ranges(logs, total_duration=10.0) == [
        SilentRange(start=8.0, end=10.0, duration=2.0)
    ]


def test_parse_silence_trailing_open_dropped_without_duration() -> None:
    # Without a known total duration we cannot honestly report an end — drop it.
    assert parse_silence_ranges("silence_start: 8.0\n") == []
    # A total_duration that does not exceed the open start is likewise ignored.
    assert parse_silence_ranges("silence_start: 8.0\n", total_duration=8.0) == []


# --- Silence: injected runner ------------------------------------------------


def test_detect_silence_builds_expected_argv() -> None:
    captured: list[Sequence[str]] = []

    def runner(argv: Sequence[str]) -> str:
        captured.append(argv)
        return _SILENCE_LOG

    ranges = detect_silence(Path("/media/clip.mp4"), runner=runner)
    assert len(ranges) == 2
    argv = list(captured[0])
    assert "-i" in argv and "/media/clip.mp4" in argv
    assert f"silencedetect=noise={DEFAULT_NOISE_FLOOR_DB}dB:d={DEFAULT_MIN_SILENCE_SECONDS}" in argv
    assert argv[-3:] == ["-f", "null", "-"]


def test_detect_silence_honours_custom_thresholds_and_duration() -> None:
    captured: list[Sequence[str]] = []

    def runner(argv: Sequence[str]) -> str:
        captured.append(argv)
        return "silence_start: 1.0\n"  # trailing open range

    ranges = detect_silence(
        Path("/a.wav"),
        noise_floor_db=-40.0,
        min_silence_seconds=0.25,
        total_duration=4.0,
        runner=runner,
    )
    assert ranges == [SilentRange(start=1.0, end=4.0, duration=3.0)]
    assert "silencedetect=noise=-40.0dB:d=0.25" in list(captured[0])


# --- Silence: decode failures are classified, not forwarded raw --------------


def _silence_media(*, audio: bool) -> MediaInfo:
    streams = [StreamInfo(index=0, codec_type="video", codec_name="h264")]
    if audio:
        streams.append(StreamInfo(index=1, codec_type="audio", codec_name="aac"))
    return MediaInfo(path="/tmp/clip.mp4", duration_seconds=6.0, streams=streams)


def _failing_silence_runner(_argv: Sequence[str]) -> str:
    # What ffmpeg really returns for `-vn`/`-f null` against a video with no audio track.
    raise FFmpegError(
        "'ffmpeg' exited 234: Output #0, null, to 'pipe:':\n"
        "[out#0/null] Output file does not contain any stream\n"
        "Error opening output files: Invalid argument"
    )


def test_detect_silence_on_a_video_only_clip_says_so_instead_of_dumping_ffmpeg(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        silence_module, "inspect_media", lambda _path, timeout=None: _silence_media(audio=False)
    )
    with pytest.raises(NoAudioStreamError) as raised:
        detect_silence(Path("/tmp/clip.mp4"), runner=_failing_silence_runner)
    message = str(raised.value)
    assert "clip.mp4 has no audio track" in message
    # The creator (and the model) must never be handed the raw ffmpeg dump.
    assert "null" not in message and "exited 234" not in message


def test_detect_silence_keeps_a_real_decode_failure_as_itself(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        silence_module, "inspect_media", lambda _path, timeout=None: _silence_media(audio=True)
    )
    with pytest.raises(FFmpegError) as raised:
        detect_silence(Path("/tmp/clip.mp4"), runner=_failing_silence_runner)
    assert not isinstance(raised.value, NoAudioStreamError)
    assert "exited 234" in str(raised.value)


def test_detect_silence_falls_back_to_the_original_error_when_the_probe_cannot_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unprobeable(_path: Path, timeout: float | None = None) -> MediaInfo:
        raise FileNotFoundError("gone")

    monkeypatch.setattr(silence_module, "inspect_media", unprobeable)
    with pytest.raises(FFmpegError) as raised:
        detect_silence(Path("/tmp/clip.mp4"), runner=_failing_silence_runner)
    assert "exited 234" in str(raised.value)


# --- Scenes: pure parser -----------------------------------------------------


def test_parse_scene_changes_extracts_and_sorts_pts_times() -> None:
    assert parse_scene_changes(_SCENE_LOG) == [
        SceneCut(time=0.0),
        SceneCut(time=12.3456),
        SceneCut(time=24.5),
    ]


def test_parse_scene_changes_none() -> None:
    assert parse_scene_changes("no showinfo lines") == []


def test_parse_scene_changes_clamps_negative() -> None:
    assert parse_scene_changes("pts_time:-0.01\n") == [SceneCut(time=0.0)]


# --- Scenes: injected runner -------------------------------------------------


def test_detect_scenes_builds_expected_argv() -> None:
    captured: list[Sequence[str]] = []

    def runner(argv: Sequence[str]) -> str:
        captured.append(argv)
        return _SCENE_LOG

    cuts = detect_scenes(Path("/media/movie.mp4"), runner=runner)
    assert cuts == [SceneCut(time=0.0), SceneCut(time=12.3456), SceneCut(time=24.5)]
    argv = list(captured[0])
    assert f"select='gt(scene,{DEFAULT_SCENE_THRESHOLD})',showinfo" in argv
    assert "-an" in argv and argv[-3:] == ["-f", "null", "-"]


def test_detect_scenes_honours_custom_threshold() -> None:
    captured: list[Sequence[str]] = []

    def runner(argv: Sequence[str]) -> str:
        captured.append(argv)
        return ""

    assert detect_scenes(Path("/m.mp4"), threshold=0.7, runner=runner) == []
    assert "select='gt(scene,0.7)',showinfo" in list(captured[0])


def test_scene_threshold_bounds() -> None:
    with pytest.raises(ValueError):
        SceneCut(time=-1.0)
