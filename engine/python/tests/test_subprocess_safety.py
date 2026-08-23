"""Tests for the subprocess argv hardening gate (subprocess_safety)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from framepilot_engine.audio import filters
from framepilot_engine.audio.asr import AsrTranscriptionError
from framepilot_engine.audio.asr import _default_runner as asr_runner
from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.subprocess_safety import (
    UnsafeArgvError,
    safe_operand,
    validate_safe_argv,
)


def test_validate_safe_argv_accepts_plain_vector() -> None:
    args = validate_safe_argv(["/usr/bin/ffmpeg", "-i", "clip.mp4", "-f", "null", "-"])
    assert args == ["/usr/bin/ffmpeg", "-i", "clip.mp4", "-f", "null", "-"]


def test_validate_safe_argv_returns_defensive_copy() -> None:
    original = ["binary", "-flag"]
    validated = validate_safe_argv(original)
    assert validated is not original


def test_validate_safe_argv_rejects_empty_vector() -> None:
    with pytest.raises(UnsafeArgvError):
        validate_safe_argv([])


@pytest.mark.parametrize("bad_element", [None, 42, b"/bin/ls", Path("clip.mp4")])
def test_validate_safe_argv_rejects_non_string_elements(bad_element: object) -> None:
    with pytest.raises(UnsafeArgvError):
        validate_safe_argv(["/usr/bin/ffmpeg", bad_element])  # type: ignore[list-item]


def test_validate_safe_argv_rejects_nul_byte() -> None:
    with pytest.raises(UnsafeArgvError):
        validate_safe_argv(["/usr/bin/ffmpeg", "-i", "clip\x00.mp4"])


def test_validate_safe_argv_rejects_option_shaped_binary() -> None:
    with pytest.raises(UnsafeArgvError):
        validate_safe_argv(["-i", "clip.mp4"])
    with pytest.raises(UnsafeArgvError):
        validate_safe_argv(["--config=x", "value"])


def test_safe_operand_passes_stdio_and_absolute_paths_through() -> None:
    assert safe_operand("-") == "-"
    assert safe_operand("/tmp/ok/clip.mp4") == "/tmp/ok/clip.mp4"
    assert safe_operand("relative/clip.mp4") == "relative/clip.mp4"


def test_safe_operand_defuses_dash_leading_relative_path() -> None:
    assert safe_operand("-weird-dir/clip.mp4") == "./-weird-dir/clip.mp4"
    assert safe_operand("--looks-like-flag") == "./--looks-like-flag"


def test_ffmpeg_run_rejects_unsafe_argv_before_exec() -> None:
    with pytest.raises(UnsafeArgvError):
        from framepilot_engine.media.ffmpeg import run

        run([sys.executable, "-c", 123])  # type: ignore[list-item]


def test_asr_default_runner_rejects_unsafe_argv() -> None:
    with pytest.raises(UnsafeArgvError):
        asr_runner([sys.executable, "-i", "\x00poison"], timeout=5.0)
    with pytest.raises(UnsafeArgvError):
        asr_runner([], timeout=5.0)


def test_filters_default_runner_rejects_unsafe_argv() -> None:
    with pytest.raises(UnsafeArgvError):
        filters._default_runner([sys.executable, b"not-a-str"])  # type: ignore[list-item]


def test_wired_runners_still_execute_happy_path() -> None:
    # The gate must not break the real invocation path.
    asr_runner([sys.executable, "-c", "pass"], timeout=10.0)
    filters._default_runner([sys.executable, "-c", "pass"])
    out = validate_safe_argv([sys.executable, "-c", "print('gate-ok')"])
    assert out[0] == sys.executable


def test_error_types_unchanged_for_operational_failures() -> None:
    # The gate must not mask the typed operational errors callers rely on.
    from framepilot_engine.media.ffmpeg import run

    with pytest.raises(FFmpegError):
        run(["framepilot-nonexistent-binary-xyz"])
    with pytest.raises((AsrTranscriptionError, UnsafeArgvError)):
        asr_runner(["framepilot-nonexistent-binary-xyz"], timeout=5.0)
