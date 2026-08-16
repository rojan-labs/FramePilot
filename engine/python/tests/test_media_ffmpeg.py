"""Tests for binary discovery and the subprocess runner (media.ffmpeg)."""

from __future__ import annotations

import sys

import pytest

from framepilot_engine.media import ffmpeg


def test_find_ffprobe_prefers_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRAMEPILOT_FFPROBE", "/custom/ffprobe")
    assert ffmpeg.find_ffprobe() == "/custom/ffprobe"


def test_find_ffprobe_blank_env_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRAMEPILOT_FFPROBE", "   ")
    monkeypatch.setattr("framepilot_engine.media.ffmpeg.shutil.which", lambda _: "/usr/bin/ffprobe")
    assert ffmpeg.find_ffprobe() == "/usr/bin/ffprobe"


def test_find_ffprobe_uses_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRAMEPILOT_FFPROBE", raising=False)
    monkeypatch.setattr("framepilot_engine.media.ffmpeg.shutil.which", lambda _: "/usr/bin/ffprobe")
    assert ffmpeg.find_ffprobe() == "/usr/bin/ffprobe"


def test_find_ffprobe_missing_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRAMEPILOT_FFPROBE", raising=False)
    monkeypatch.setattr("framepilot_engine.media.ffmpeg.shutil.which", lambda _: None)
    with pytest.raises(ffmpeg.FFmpegNotFoundError):
        ffmpeg.find_ffprobe()


def test_find_ffmpeg_prefers_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRAMEPILOT_FFMPEG", "/custom/ffmpeg")
    assert ffmpeg.find_ffmpeg() == "/custom/ffmpeg"


def test_find_ffmpeg_uses_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRAMEPILOT_FFMPEG", raising=False)
    monkeypatch.setattr("framepilot_engine.media.ffmpeg.shutil.which", lambda _: "/usr/bin/ffmpeg")
    assert ffmpeg.find_ffmpeg() == "/usr/bin/ffmpeg"


def test_find_ffmpeg_falls_back_to_imageio(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRAMEPILOT_FFMPEG", raising=False)
    monkeypatch.setattr("framepilot_engine.media.ffmpeg.shutil.which", lambda _: None)
    # imageio-ffmpeg is a hard dependency, so this returns a real bundled path.
    assert ffmpeg.find_ffmpeg()


def test_run_returns_stdout() -> None:
    # `python -c` is always present in the test environment and deterministic.
    out = ffmpeg.run([sys.executable, "-c", "print('hello-render')"])
    assert "hello-render" in out


def test_run_nonzero_exit_raises_with_stderr() -> None:
    with pytest.raises(ffmpeg.FFmpegError) as exc:
        ffmpeg.run([sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"])
    assert "boom" in str(exc.value)
    assert "exited 3" in str(exc.value)


def test_run_missing_binary_raises_not_found() -> None:
    with pytest.raises(ffmpeg.FFmpegNotFoundError):
        ffmpeg.run(["framepilot-nonexistent-binary-xyz"])


def test_run_timeout_raises() -> None:
    with pytest.raises(ffmpeg.FFmpegError) as exc:
        ffmpeg.run([sys.executable, "-c", "import time; time.sleep(2)"], timeout=0.05)
    assert "Timed out" in str(exc.value)


def test_run_logs_returns_stderr() -> None:
    logs = ffmpeg.run_logs([sys.executable, "-c", "import sys; sys.stderr.write('on-stderr')"])
    assert "on-stderr" in logs


def test_run_logs_nonzero_exit_raises() -> None:
    with pytest.raises(ffmpeg.FFmpegError):
        ffmpeg.run_logs([sys.executable, "-c", "import sys; sys.exit(2)"])
