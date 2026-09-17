"""Export refuses a matte whose source media changed after it was made (BR4.14)."""

from __future__ import annotations

import json
import subprocess
from fractions import Fraction
from pathlib import Path

import pytest

from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.render.frame_hashes import frame_hashes_by_pts
from framepilot_engine.render.matte_media import (
    assert_media_unchanged,
    source_content_fingerprint,
)
from framepilot_engine.render.mattes import (
    MATTE_REMEDIES,
    MatteFrames,
    MatteRefusal,
    MatteRefusalCode,
    MatteStatus,
    PreparedMatte,
)
from framepilot_engine.render.pts_reader import video_timing

KEY = "b" * 64


def _video(path: Path, pattern: str, container_args: tuple[str, ...] = ()) -> Path:
    subprocess.run(
        [
            find_ffmpeg(),
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"{pattern}=size=64x36:rate=30",
            "-frames:v",
            "12",
            "-c:v",
            "ffv1",
            *container_args,
            str(path),
        ],
        check=True,
        timeout=60,
    )
    return path


def _prepared(project: Path) -> PreparedMatte:
    directory = project / ".framepilot-derived" / "mattes" / KEY
    directory.mkdir(parents=True)
    return PreparedMatte(
        mask_id="m1",
        clip_id="c1",
        directory=directory,
        frames=MatteFrames(time_base=Fraction(1, 30), origin_pts=0, first_frame=0, pts=(0, 1)),
        width=64,
        height=36,
        matte_pixel_format="gray",
        matte_maximum=255,
        has_foreground=False,
    )


def _record(prepared: PreparedMatte, source: Path, *, samples: bool = True) -> None:
    timing = video_timing(source)
    pts = [timing.pts[0], timing.pts[5], timing.pts[-1]]
    hashes = frame_hashes_by_pts(source, pts, "native")
    results = prepared.directory.parent / ".results"
    results.mkdir(exist_ok=True)
    (results / f"{KEY}.json").write_text(
        json.dumps(
            {
                "key": KEY,
                "contentFingerprint": source_content_fingerprint(source, timing),
                "sourceSamples": (
                    [{"pts": p, "sha256": h} for p, h in zip(pts, hashes, strict=True)]
                    if samples
                    else []
                ),
            }
        ),
        encoding="utf-8",
    )


def test_same_file_passes_without_decoding(tmp_path: Path) -> None:
    source = _video(tmp_path / "shot.mkv", "testsrc2")
    prepared = _prepared(tmp_path)
    _record(prepared, source)
    assert_media_unchanged(prepared, source)


def test_a_remux_with_identical_frames_passes(tmp_path: Path) -> None:
    source = _video(tmp_path / "shot.mkv", "testsrc2")
    prepared = _prepared(tmp_path)
    _record(prepared, source)
    # Same pictures, different container bytes: fingerprint differs, frames do not.
    _video(source, "testsrc2", ("-metadata", "title=remuxed"))
    assert_media_unchanged(prepared, source)


def test_different_footage_is_refused_with_the_media_changed_sentence(tmp_path: Path) -> None:
    source = _video(tmp_path / "shot.mkv", "testsrc2")
    prepared = _prepared(tmp_path)
    _record(prepared, source)
    _video(source, "smptebars")
    with pytest.raises(MatteRefusal) as caught:
        assert_media_unchanged(prepared, source)
    assert caught.value.code is MatteRefusalCode.MEDIA_CHANGED
    assert caught.value.status is MatteStatus.STALE
    assert caught.value.remedy == (
        "Media changed since background removal ran — run Remove background again."
    )
    assert (
        MATTE_REMEDIES[MatteRefusalCode.MEDIA_CHANGED]
        == MATTE_REMEDIES[MatteRefusalCode.SIZE_MISMATCH]
    )


def test_unsampled_or_missing_media_cannot_vouch_for_the_matte(tmp_path: Path) -> None:
    source = _video(tmp_path / "shot.mkv", "testsrc2")
    prepared = _prepared(tmp_path)
    _record(prepared, source, samples=False)
    _video(source, "testsrc2", ("-metadata", "title=changed"))
    with pytest.raises(MatteRefusal):
        assert_media_unchanged(prepared, source)
    with pytest.raises(MatteRefusal):
        assert_media_unchanged(prepared, tmp_path / "gone.mkv")


def test_a_matte_without_a_host_record_is_not_rechecked(tmp_path: Path) -> None:
    source = _video(tmp_path / "shot.mkv", "testsrc2")
    prepared = _prepared(tmp_path)
    assert_media_unchanged(prepared, source)
    results = prepared.directory.parent / ".results"
    results.mkdir()
    (results / f"{KEY}.json").write_text(json.dumps({"key": "c" * 64}), encoding="utf-8")
    assert_media_unchanged(prepared, source)
