"""Transcribing a video with no sound says so, instead of quoting ffmpeg at the model.

The baseline recorded this as an open defect: ``POST /transcribe`` on
``talk-1080p-98s.mp4`` returned a 422 whose detail was ffmpeg's whole banner followed by
"Output file does not contain any stream". That body is what ``sidecar-executor.ts`` puts
in front of the model, so a run asked to caption a silent screen recording was handed a
codec dump — naming no cause it could act on, and not saying the one thing that is true.

``analysis/silence.py`` already answered the identical case with a sentence
(``NoAudioStreamError``). This is the same classification, against the same probe.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest

from framepilot_engine.audio.asr import AsrNoAudioError, _prepare_mono16k_wav
from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.media.probe import MediaInfo, StreamInfo

FFMPEG_BANNER = (
    "ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers\n"
    "  built with Apple clang version 17.0.0\n"
    "  configuration: --prefix=/opt/homebrew --enable-gpl\n"
    "Output file does not contain any stream"
)


def _failing_run(_argv: Sequence[str], _timeout: float | None) -> None:
    raise FFmpegError(FFMPEG_BANNER)


def _probe(monkeypatch: pytest.MonkeyPatch, *, has_audio: bool) -> None:
    def fake(path: Path, *, timeout: float | None = None) -> MediaInfo:
        del path, timeout
        video = StreamInfo(index=0, codec_type="video")
        audio = StreamInfo(index=1, codec_type="audio")
        return MediaInfo(path="m.mp4", streams=[video, audio] if has_audio else [video])

    monkeypatch.setattr("framepilot_engine.audio.asr.inspect_media", fake)


def test_a_silent_video_is_named_as_such(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _probe(monkeypatch, has_audio=False)
    with pytest.raises(AsrNoAudioError) as exc:
        _prepare_mono16k_wav(
            tmp_path / "screen-recording.mp4",
            tmp_path / "out.wav",
            run=_failing_run,
            timeout=5.0,
        )
    message = str(exc.value)
    assert "screen-recording.mp4 has no audio track" in message
    assert "nothing to transcribe" in message
    # The regression: none of ffmpeg's banner may reach the caller.
    assert "ffmpeg version" not in message
    assert "does not contain any stream" not in message


def test_a_real_decode_failure_is_left_alone(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # A file that DOES carry audio and still failed to decode is a different fault — a
    # corrupt stream, a missing codec — and replacing its message would hide the cause.
    _probe(monkeypatch, has_audio=True)
    with pytest.raises(FFmpegError) as exc:
        _prepare_mono16k_wav(
            tmp_path / "corrupt.mp4", tmp_path / "out.wav", run=_failing_run, timeout=5.0
        )
    assert "does not contain any stream" in str(exc.value)


def test_an_unanswerable_probe_leaves_the_original_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Fail open: if ffprobe cannot tell us what the file holds, we do not get to claim
    # it is silent.
    def fake(path: Path, *, timeout: float | None = None) -> MediaInfo:
        del path, timeout
        raise FFmpegError("ffprobe exited 1")

    monkeypatch.setattr("framepilot_engine.audio.asr.inspect_media", fake)
    with pytest.raises(FFmpegError) as exc:
        _prepare_mono16k_wav(
            tmp_path / "unknown.mp4", tmp_path / "out.wav", run=_failing_run, timeout=5.0
        )
    assert "does not contain any stream" in str(exc.value)
