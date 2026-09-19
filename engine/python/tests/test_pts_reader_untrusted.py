"""BR4.12 re-review: the export's pts listing refuses indirection like the frame-hash routes."""

from __future__ import annotations

from pathlib import Path

import pytest

from framepilot_engine.render.pts_reader import VideoTimingError, video_timing
from tests.matte_fixtures import encode_ffv1, level_frames


def test_video_timing_reads_real_media(tmp_path: Path) -> None:
    path = tmp_path / "shot.mkv"
    encode_ffv1(path, level_frames(4), "gray", "gray")
    assert video_timing(path).count == 4


def test_video_timing_refuses_a_renamed_playlist_or_concat_file(tmp_path: Path) -> None:
    real = tmp_path / "real.mkv"
    encode_ffv1(real, level_frames(4), "gray", "gray")
    concat = tmp_path / "concat.mp4"
    concat.write_text(f"ffconcat version 1.0\nfile '{real}'\n", encoding="utf-8")
    playlist = tmp_path / "playlist.mov"
    playlist.write_text(f"#EXTM3U\n#EXTINF:1,\n{real}\n#EXT-X-ENDLIST\n", encoding="utf-8")
    for path in (concat, playlist):
        with pytest.raises(VideoTimingError):
            video_timing(path)
