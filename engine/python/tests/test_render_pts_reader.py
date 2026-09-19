"""Frame-exact VFR decoding (BR2.5): timing probe, pts frame selection, CFR left untouched."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from moviepy import VideoFileClip
from moviepy.video.io import ffmpeg_reader
from moviepy.video.io.ffmpeg_reader import FFMPEG_VideoReader

from framepilot_engine.render.pts_reader import (
    PtsVideoReader,
    reader_frame_index,
    use_pts_reader,
    video_timing,
)
from tests import matte_fixtures as fx

pytestmark = pytest.mark.usefixtures("require_ffprobe")

PTS = [0, 20, 60, 80, 140, 240, 260, 300, 360, 380]


def _numbered(count: int) -> list[np.ndarray]:
    return [np.full((fx.HEIGHT, fx.WIDTH, 3), 10 + 20 * k, dtype=np.uint8) for k in range(count)]


def _number(frame: np.ndarray) -> int:
    return round((float(frame[..., 0].mean()) - 10.0) / 20.0)


def test_timing_classifies_constant_and_variable_rate(tmp_path: Path) -> None:
    fx.write_source(tmp_path / "cfr.mkv", _numbered(6))
    fx.write_source(tmp_path / "late.mkv", _numbered(6), ts_offset=1.5)
    fx.write_vfr_source(tmp_path / "vfr.mkv", _numbered(len(PTS)), PTS)
    cfr = video_timing(tmp_path / "cfr.mkv")
    assert cfr.constant_rate and cfr.count == 6
    late = video_timing(tmp_path / "late.mkv")
    assert late.constant_rate and late.pts[0] == 1500 and late.start_time == pytest.approx(1.5)
    vfr = video_timing(tmp_path / "vfr.mkv")
    assert not vfr.constant_rate
    assert vfr.pts == tuple(PTS)
    assert video_timing(tmp_path / "vfr.mkv") is vfr  # cached


def test_constant_rate_sources_keep_moviepys_reader(tmp_path: Path) -> None:
    fx.write_source(tmp_path / "cfr.mkv", _numbered(6))
    clip = VideoFileClip(str(tmp_path / "cfr.mkv"))
    try:
        reader = clip.reader
        assert use_pts_reader(clip, str(tmp_path / "cfr.mkv")) is clip
        assert clip.reader is reader and isinstance(reader, FFMPEG_VideoReader)
        assert reader_frame_index(clip, 2 / 30, 30.0) == 2
    finally:
        clip.close()


def test_variable_rate_frames_are_picked_by_pts(tmp_path: Path) -> None:
    path = tmp_path / "vfr.mkv"
    fx.write_vfr_source(path, _numbered(len(PTS)), PTS)
    clip = use_pts_reader(VideoFileClip(str(path)), str(path))
    try:
        assert isinstance(clip.reader, PtsVideoReader)
        seconds = [value / 1000 for value in PTS]
        times = [k / 100 for k in range(45)]
        for t in times:  # forward, as an export reads
            expected = max(i for i, pts in enumerate(seconds) if pts <= t + 1e-9)
            assert reader_frame_index(clip, t, 30.0) == expected
            assert _number(clip.get_frame(t)) == expected, t
        assert clip.reader.decoder_starts == 1
        for t in reversed(times):  # backwards: every frame by an exact seek
            expected = max(i for i, pts in enumerate(seconds) if pts <= t + 1e-9)
            assert _number(clip.get_frame(t)) == expected, t
    finally:
        clip.close()
    assert clip.reader is None


def test_variable_rate_decode_runs_moviepys_ffmpeg_not_path_or_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """BR2.8: a VFR clip must decode through the binary MoviePy decodes CFR clips with.

    Another ffmpeg on PATH and in FRAMEPILOT_FFMPEG is a broken decoy: if the pts reader ran
    either, the frame read would fail. Different builds convert YUV to RGB differently, so one
    export must never draw its clips with two of them.
    """
    path = tmp_path / "vfr.mkv"
    fx.write_vfr_source(path, _numbered(len(PTS)), PTS)
    decoy = tmp_path / "bin" / "ffmpeg"
    decoy.parent.mkdir()
    decoy.write_text("#!/bin/sh\nexit 1\n")
    decoy.chmod(0o755)
    monkeypatch.setenv("PATH", f"{decoy.parent}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("FRAMEPILOT_FFMPEG", str(decoy))
    launched: list[str] = []
    real_popen = subprocess.Popen

    def recording_popen(argv: Any, **kwargs: Any) -> Any:
        if "image2pipe" in argv:  # a decode (MoviePy's or the pts reader's), not a probe
            launched.append(str(argv[0]))
        return real_popen(argv, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    clip = use_pts_reader(VideoFileClip(str(path)), str(path))
    try:
        assert isinstance(clip.reader, PtsVideoReader)
        assert _number(clip.get_frame(0.3)) == 7
    finally:
        clip.close()
    assert launched and set(launched) == {ffmpeg_reader.FFMPEG_BINARY}
