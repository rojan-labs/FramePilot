"""Typed pre-render refusals for matte masks (BR2.3): each code, its state and its remedy."""

from __future__ import annotations

import json
import re
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.media.assets import index_assets
from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.render.compiler import CompileError, compile_timeline
from framepilot_engine.render.mattes import (
    FRAMES_FILE,
    MATTE_FILE,
    MATTE_REMEDIES,
    MATTES_DIR,
    MatteRefusal,
    MatteRefusalCode,
    MatteStatus,
    assert_frames_align,
    prepare_matte,
)
from framepilot_engine.render.pipeline import plain_render_error
from framepilot_engine.render.presets import frame_target
from framepilot_engine.render.pts_reader import VideoTiming
from framepilot_engine.timeline.models import AssetMedia, Clip, MatteMask, Project
from tests import matte_fixtures as fx

pytestmark = pytest.mark.usefixtures("require_ffprobe")

FPS = 30


def _mask(artifact: dict[str, Any], **extra: Any) -> MatteMask:
    return MatteMask.model_validate(fx.matte_mask("m", artifact, **extra))


def _clip(source_start: float = 0.0, source_end: float = 0.2) -> Clip:
    return Clip.model_validate(
        {
            "id": "c",
            "assetId": "a",
            "trackId": "v",
            "start": 0.0,
            "end": source_end - source_start,
            "sourceStart": source_start,
            "sourceEnd": source_end,
        }
    )


def _media(**extra: Any) -> AssetMedia:
    return AssetMedia.model_validate({"width": fx.WIDTH, "height": fx.HEIGHT, **extra})


def _refusal(
    artifact: dict[str, Any],
    project: Path,
    *,
    clip: Clip | None = None,
    media: AssetMedia | None = None,
    **mask: Any,
) -> MatteRefusal:
    with pytest.raises(MatteRefusal) as caught:
        prepare_matte(_mask(artifact, **mask), clip or _clip(), project, media or _media(), FPS)
    return caught.value


def _pin(artifact: dict[str, Any], project: Path, name: str) -> None:
    """Re-pin a file's digest after a test rewrote it (so a later check is reached)."""
    for entry in artifact["files"]:
        if entry["name"] == name:
            entry["sha256"] = fx.sha256(project / MATTES_DIR / fx.KEY / name)


def test_remedies_are_constant_sentences_without_magnitudes() -> None:
    assert set(MATTE_REMEDIES) == set(MatteRefusalCode)
    for status, remedy in MATTE_REMEDIES.values():
        assert isinstance(status, MatteStatus)
        assert not re.search(r"\d", remedy), remedy
        assert remedy.endswith(".")
    assert MATTE_REMEDIES[MatteRefusalCode.MISSING] == (
        MatteStatus.BROKEN,
        "Background removal data is missing — run Remove background again.",
    )
    assert MATTE_REMEDIES[MatteRefusalCode.OUT_OF_COVERAGE][0] is MatteStatus.STALE


def test_a_good_artifact_prepares(tmp_path: Path) -> None:
    artifact = fx.write_artifact(tmp_path, pts=list(range(6)))
    prepared = prepare_matte(_mask(artifact), _clip(), tmp_path, _media(), FPS)
    assert prepared.frames.count == 6
    assert prepared.has_foreground
    assert prepared.matte_maximum == 255


def test_missing_directory_file_or_pin_is_broken(tmp_path: Path) -> None:
    artifact = fx.write_artifact(tmp_path, pts=list(range(6)))
    bad_key = {**artifact, "key": "../../etc"}
    assert _refusal(bad_key, tmp_path).code is MatteRefusalCode.MISSING
    other_key = {**artifact, "key": "c" * 64}
    refusal = _refusal(other_key, tmp_path)
    assert refusal.code is MatteRefusalCode.MISSING
    assert refusal.status is MatteStatus.BROKEN
    assert str(refusal).startswith(
        "Background removal data is missing — run Remove background again."
    )
    unpinned = {**artifact, "files": [f for f in artifact["files"] if f["name"] != FRAMES_FILE]}
    assert _refusal(unpinned, tmp_path).code is MatteRefusalCode.MISSING
    (tmp_path / MATTES_DIR / fx.KEY / "foreground.mkv").unlink()
    assert _refusal(artifact, tmp_path).code is MatteRefusalCode.MISSING
    # Without decontamination the foreground is not needed.
    prepare_matte(_mask(artifact, decontaminate=False), _clip(), tmp_path, _media(), FPS)


def test_changed_file_is_a_digest_mismatch(tmp_path: Path) -> None:
    artifact = fx.write_artifact(tmp_path, pts=list(range(6)))
    frames = tmp_path / MATTES_DIR / fx.KEY / FRAMES_FILE
    frames.write_text(frames.read_text(encoding="utf-8") + " ", encoding="utf-8")
    refusal = _refusal(artifact, tmp_path)
    assert refusal.code is MatteRefusalCode.DIGEST_MISMATCH
    assert refusal.status is MatteStatus.BROKEN


def test_unparseable_frames_json_is_unreadable(tmp_path: Path) -> None:
    artifact = fx.write_artifact(tmp_path, pts=list(range(6)))
    (tmp_path / MATTES_DIR / fx.KEY / FRAMES_FILE).write_text("{}", encoding="utf-8")
    _pin(artifact, tmp_path, FRAMES_FILE)
    assert _refusal(artifact, tmp_path).code is MatteRefusalCode.UNREADABLE


def test_lossy_matte_pixel_format_is_refused(tmp_path: Path) -> None:
    artifact = fx.write_artifact(tmp_path, pts=list(range(4)))
    fx.encode_ffv1(
        tmp_path / MATTES_DIR / fx.KEY / MATTE_FILE, fx.level_frames(4), "gray", "yuv420p"
    )
    _pin(artifact, tmp_path, MATTE_FILE)
    assert _refusal(artifact, tmp_path).code is MatteRefusalCode.UNSUPPORTED_PIXEL_FORMAT


def test_frame_count_disagreeing_with_frames_json_is_misaligned(tmp_path: Path) -> None:
    artifact = fx.write_artifact(tmp_path, pts=list(range(4)))
    frames = tmp_path / MATTES_DIR / fx.KEY / FRAMES_FILE
    document = json.loads(frames.read_text(encoding="utf-8"))
    document["pts"] = [0, 1, 2]
    frames.write_text(json.dumps(document), encoding="utf-8")
    _pin(artifact, tmp_path, FRAMES_FILE)
    assert _refusal(artifact, tmp_path).code is MatteRefusalCode.FRAME_MISALIGNED


def test_size_and_media_changes_are_stale(tmp_path: Path) -> None:
    artifact = fx.write_artifact(tmp_path, pts=list(range(6)))
    refusal = _refusal(artifact, tmp_path, media=_media(width=fx.WIDTH * 2))
    assert refusal.code is MatteRefusalCode.SIZE_MISMATCH
    assert refusal.status is MatteStatus.STALE
    assert (
        _refusal({**artifact, "width": fx.WIDTH + 2}, tmp_path).code
        is MatteRefusalCode.SIZE_MISMATCH
    )
    assert (
        _refusal(artifact, tmp_path, media=_media(rotation=90)).code
        is MatteRefusalCode.UNSUPPORTED_MEDIA
    )


def test_clip_range_outside_coverage_is_stale(tmp_path: Path) -> None:
    artifact = fx.write_artifact(tmp_path, pts=list(range(6)))  # covers [0, 0.2]
    # Half a frame of slack either side, as the TypeScript validator allows.
    prepare_matte(_mask(artifact), _clip(0.0, 0.2 + 0.4 / FPS), tmp_path, _media(), FPS)
    refusal = _refusal(artifact, tmp_path, clip=_clip(0.0, 0.3))
    assert refusal.code is MatteRefusalCode.OUT_OF_COVERAGE
    assert refusal.status is MatteStatus.STALE
    assert refusal.remedy.endswith("update the background removal for the new range.")


def _timing(pts: list[int], time_base: tuple[int, int] = (1, 30)) -> VideoTiming:
    return VideoTiming(time_base=Fraction(*time_base), pts=tuple(pts), start_time=0.0)


def test_frame_alignment_gate(tmp_path: Path) -> None:
    artifact = fx.write_artifact(tmp_path, pts=list(range(3, 9)), first_frame=3)
    prepared = prepare_matte(_mask(artifact), _clip(0.1, 0.25), tmp_path, _media(), FPS)
    source = _timing(list(range(24)))
    assert_frames_align(prepared, [3, 4, 8], source)
    assert_frames_align(prepared, [3, 4, 8], None)
    with pytest.raises(MatteRefusal) as missing:
        assert_frames_align(prepared, [3, 9], source)
    assert missing.value.code is MatteRefusalCode.FRAME_MISALIGNED
    # A matte made at another frame rate: its pts are not the source frames' pts.
    with pytest.raises(MatteRefusal) as other_rate:
        assert_frames_align(prepared, [3], _timing([k * 36 for k in range(24)], (1, 1000)))
    assert other_rate.value.code is MatteRefusalCode.FRAME_MISALIGNED
    # A source shorter than the matte claims.
    with pytest.raises(MatteRefusal):
        assert_frames_align(prepared, [3], _timing(list(range(7))))


def test_variable_frame_rate_pts_align_exactly(tmp_path: Path) -> None:
    """VFR pts in a 1/90000 time base agree with a source listed in milliseconds."""
    vfr = [0, 3003, 9009, 10010]
    artifact = fx.write_artifact(tmp_path, pts=vfr, time_base=(1, 90000))
    prepared = prepare_matte(_mask(artifact), _clip(0.0, 0.1), tmp_path, _media(), FPS)
    assert_frames_align(prepared, [0, 1, 2, 3], _timing([0, 33, 100, 111], (1, 1000)))
    with pytest.raises(MatteRefusal) as dropped:
        assert_frames_align(prepared, [0, 1], _timing([0, 33, 67, 100], (1, 1000)))
    assert dropped.value.code is MatteRefusalCode.FRAME_MISALIGNED
    assert dropped.value.status is MatteStatus.STALE


# --- Wired into the export -----------------------------------------------------------------


def _source(project: Path) -> None:
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
            f"testsrc2=s={fx.WIDTH}x{fx.HEIGHT}:r={FPS}:d=0.2",
            "-c:v",
            "png",
            str(project / "src.mov"),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )


def _project(artifact: dict[str, Any]) -> Project:
    return Project.model_validate(
        {
            "id": "p",
            "name": "p",
            "fps": FPS,
            "resolution": {"width": fx.WIDTH, "height": fx.HEIGHT},
            "assets": [
                {
                    "id": "a",
                    "path": "src.mov",
                    "kind": "video",
                    "media": {"width": fx.WIDTH, "height": fx.HEIGHT},
                }
            ],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                **_clip().model_dump(by_alias=True, exclude_none=True),
                                "masks": [fx.matte_mask("m", artifact)],
                            }
                        ],
                    }
                ]
            },
        }
    )


def test_export_refuses_before_rendering_and_shows_the_remedy(tmp_path: Path) -> None:
    _source(tmp_path)
    artifact = fx.write_artifact(tmp_path, pts=list(range(6)))
    (tmp_path / MATTES_DIR / fx.KEY / MATTE_FILE).unlink()
    project = _project(artifact)
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], tmp_path)
    with pytest.raises(CompileError) as caught:
        compile_timeline(project, index, frame_target(fx.WIDTH, fx.HEIGHT, FPS))
    assert isinstance(caught.value.__cause__, MatteRefusal)
    assert plain_render_error(caught.value) == (
        "Background removal data is missing — run Remove background again."
    )


def test_export_refuses_frames_the_matte_does_not_hold(tmp_path: Path) -> None:
    """Coverage passes within half a frame, but the clip's last decoded frame is not in it."""
    _source(tmp_path)
    artifact = fx.write_artifact(tmp_path, pts=list(range(5)))
    artifact["coverage"]["sourceEnd"] = 0.2
    project = _project(artifact)
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], tmp_path)
    with pytest.raises(CompileError) as caught:
        compile_timeline(project, index, frame_target(fx.WIDTH, fx.HEIGHT, FPS))
    assert plain_render_error(caught.value) == MATTE_REMEDIES[MatteRefusalCode.FRAME_MISALIGNED][1]
