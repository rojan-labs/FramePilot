"""The matte artifact reader (BR2.1): frame identity, forward cursor, LRU random access."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from framepilot_engine.render.mattes import (
    MATTES_DIR,
    MatteFrameMissing,
    MatteFrames,
    MatteReader,
    PreparedMatte,
    parse_frames,
)
from tests import matte_fixtures as fx

pytestmark = pytest.mark.usefixtures("require_ffprobe")


def _prepared(project: Path, frames: MatteFrames, *, matte_format: str = "gray") -> PreparedMatte:
    return PreparedMatte(
        mask_id="m",
        clip_id="c",
        directory=project / MATTES_DIR / fx.KEY,
        frames=frames,
        width=fx.WIDTH,
        height=fx.HEIGHT,
        matte_pixel_format=matte_format,
        matte_maximum=65535 if matte_format == "gray16le" else 255,
        has_foreground=True,
    )


def _frames(project: Path) -> MatteFrames:
    import json

    path = project / MATTES_DIR / fx.KEY / "frames.json"
    return parse_frames(json.loads(path.read_text(encoding="utf-8")))


# --- frames.json -----------------------------------------------------------------------------


def test_parse_frames_rejects_malformed_documents() -> None:
    good = {"version": 1, "timeBase": [1, 30], "originPts": 0, "firstFrame": 0, "pts": [0, 1]}
    assert parse_frames(good).count == 2
    for broken in (
        {**good, "version": 2},
        {**good, "timeBase": [0, 30]},
        {**good, "timeBase": [1]},
        {**good, "originPts": 0.5},
        {**good, "firstFrame": -1},
        {**good, "pts": []},
        {**good, "pts": [0, 0]},
        {**good, "pts": [2, 1]},
        {**good, "pts": [0, True]},
        [0, 1],
    ):
        with pytest.raises(ValueError):
            parse_frames(broken)


def test_vfr_pts_lookup_is_exact_and_never_nearest() -> None:
    """Variable-rate source pts (ticks of 1/90000): each pts maps to its own frame only."""
    pts = [0, 3003, 9009, 10010, 18018]
    frames = parse_frames(
        {"version": 1, "timeBase": [1, 90000], "originPts": 0, "firstFrame": 4, "pts": pts}
    )
    assert [frames.index_for_pts(value) for value in pts] == [0, 1, 2, 3, 4]
    for gap in (1, 3002, 6006, 18019, -1):
        with pytest.raises(MatteFrameMissing):
            frames.index_for_pts(gap)
    assert frames.index_for_source_seconds(9009 / 90000) == 2
    with pytest.raises(MatteFrameMissing):
        frames.index_for_source_seconds(6006 / 90000)
    assert frames.constant_step() is None
    assert frames.index_for_source_frame(4) == 0
    assert frames.index_for_source_frame(8) == 4
    for outside in (3, 9):
        with pytest.raises(MatteFrameMissing):
            frames.index_for_source_frame(outside)


def test_edit_list_origin_maps_raw_pts_to_the_asset_clock() -> None:
    """A source whose first frame has pts 1.5 s: asset second 0 is that frame, not pts 0."""
    frames = parse_frames(
        {
            "version": 1,
            "timeBase": [1, 1000],
            "originPts": 1500,
            "firstFrame": 3,
            "pts": [1600, 1700, 1800],
        }
    )
    assert frames.source_seconds(0) == pytest.approx(0.1)
    assert frames.index_for_source_seconds(0.2) == 1
    assert frames.constant_step() == 100


def test_constant_step_tolerates_one_tick_of_container_rounding() -> None:
    """29.97 fps in a 1 ms time base stores 33/34 ms steps; that is still constant rate."""
    pts = [round(i * 1001 / 30) for i in range(12)]
    frames = parse_frames(
        {"version": 1, "timeBase": [1, 1000], "originPts": 0, "firstFrame": 0, "pts": pts}
    )
    assert frames.constant_step() == 33


# --- Decoding --------------------------------------------------------------------------------


def _assert_frame(reader: MatteReader, index: int) -> None:
    frame = reader.frame(index)
    assert frame.index == index
    assert frame.alpha.shape == (fx.HEIGHT, fx.WIDTH)
    assert int(frame.alpha[0, 0]) == fx.frame_level(index)
    assert bool(np.all(frame.alpha == frame.alpha[0, 0]))
    assert frame.foreground is not None
    assert tuple(int(v) for v in frame.foreground[3, 5]) == fx.foreground_rgb(index)


def test_export_reads_forward_with_one_decoder_per_file(tmp_path: Path) -> None:
    fx.write_artifact(tmp_path, pts=list(range(10)))
    reader = MatteReader(_prepared(tmp_path, _frames(tmp_path)), want_foreground=True)
    try:
        for index in range(10):
            _assert_frame(reader, index)
        # A repeated frame (two output frames on one source frame) is served from the LRU.
        _assert_frame(reader, 9)
        assert reader.decoder_starts == 2
        with pytest.raises(MatteFrameMissing):
            reader.frame(10)
    finally:
        reader.close()


def test_forward_skips_read_through_instead_of_reseeking(tmp_path: Path) -> None:
    fx.write_artifact(tmp_path, pts=list(range(12)))
    reader = MatteReader(_prepared(tmp_path, _frames(tmp_path)), want_foreground=False)
    try:
        for index in (0, 2, 5, 11):
            assert int(reader.frame(index).alpha[0, 0]) == fx.frame_level(index)
            assert reader.frame(index).foreground is None
        assert reader.decoder_starts == 1
    finally:
        reader.close()


@pytest.mark.parametrize("ts_offset", [0.0, 1.5])
def test_random_access_equals_sequential_decode(tmp_path: Path, ts_offset: float) -> None:
    """Seeks land on the exact frame, including a file whose timestamps start at 1.5 s."""
    fx.write_artifact(tmp_path, pts=list(range(9)), ts_offset=ts_offset)
    reader = MatteReader(_prepared(tmp_path, _frames(tmp_path)), want_foreground=True, lru_frames=1)
    try:
        for index in (8, 3, 0, 7, 1, 6, 2, 5, 4):
            _assert_frame(reader, index)
    finally:
        reader.close()


def test_reverse_playback_uses_the_lru_between_restarts(tmp_path: Path) -> None:
    fx.write_artifact(tmp_path, pts=list(range(6)))
    reader = MatteReader(_prepared(tmp_path, _frames(tmp_path)), want_foreground=False)
    try:
        for index in (5, 4, 3, 4, 5):
            assert int(reader.frame(index).alpha[0, 0]) == fx.frame_level(index)
        starts = reader.decoder_starts
        for index in (3, 4, 5):
            reader.frame(index)
        assert reader.decoder_starts == starts
    finally:
        reader.close()


def test_gray16_mattes_keep_their_precision(tmp_path: Path) -> None:
    levels = [np.full((fx.HEIGHT, fx.WIDTH), 257 * i + 1, dtype=np.uint16) for i in range(4)]
    fx.write_artifact(tmp_path, pts=list(range(4)), mattes=levels, matte_format="gray16le")
    reader = MatteReader(
        _prepared(tmp_path, _frames(tmp_path), matte_format="gray16le"), want_foreground=False
    )
    try:
        for index in range(4):
            frame = reader.frame(index)
            assert frame.alpha.dtype == np.uint16
            assert frame.maximum == 65535
            assert int(frame.alpha[7, 9]) == 257 * index + 1
    finally:
        reader.close()


def test_frame_for_source_frame_uses_first_frame(tmp_path: Path) -> None:
    fx.write_artifact(tmp_path, pts=[30, 31, 32], first_frame=30)
    reader = MatteReader(_prepared(tmp_path, _frames(tmp_path)), want_foreground=False)
    try:
        assert int(reader.frame_for_source_frame(31).alpha[0, 0]) == fx.frame_level(1)
        with pytest.raises(MatteFrameMissing):
            reader.frame_for_source_frame(29)
    finally:
        reader.close()
