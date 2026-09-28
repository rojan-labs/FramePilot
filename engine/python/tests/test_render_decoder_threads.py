"""The decoder-thread cap on preview and evidence readers (render/decoder_threads.py).

Pinned: the capped reader runs MoviePy's own command plus ``-threads`` on the input, decodes
the same pixels at every instant (seeks included), and reaches the readers of every preview
and evidence composite — and of none of the export's.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.render import decoder_threads as decoder_threads_module
from framepilot_engine.render.compiler import PREVIEW_DECODER_THREADS
from framepilot_engine.render.decoder_threads import ThreadCappedVideoReader, cap_decoder_threads
from framepilot_engine.timeline.models import Project

FPS = 30
#: Instants read in order: sequential steps, a forward jump past MoviePy's 100-frame skip
#: window (0.533 s -> 3.9 s) and backward reads; the last two each start ffmpeg at a new -ss.
INSTANTS = (0.0, 0.5, 0.533, 3.9, 1.2, 2.0, 0.1, 3.0)


@pytest.fixture(scope="module")
def moving_h264(ffmpeg_bin: str, tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Four seconds of a moving pattern in H.264 with B-frames and 1 s GOPs."""
    path = tmp_path_factory.mktemp("decoder-threads") / "moving.mp4"
    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=s=320x180:r={FPS}:d=4",
            "-c:v",
            "libx264",
            "-g",
            str(FPS),
            "-bf",
            "2",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


def _frames(path: Path, threads: int | None) -> list[np.ndarray[Any, Any]]:
    from moviepy import VideoFileClip

    clip = cap_decoder_threads(VideoFileClip(str(path), audio=False), threads)
    try:
        return [np.array(clip.get_frame(t)) for t in INSTANTS]
    finally:
        clip.close()


def test_capped_frames_are_the_uncapped_frames_to_the_pixel(moving_h264: Path) -> None:
    uncapped = _frames(moving_h264, None)
    for threads in (1, 2, PREVIEW_DECODER_THREADS):
        for at, expected, actual in zip(
            INSTANTS, uncapped, _frames(moving_h264, threads), strict=True
        ):
            np.testing.assert_array_equal(actual, expected, f"threads={threads} t={at}")


def test_the_capped_command_is_moviepys_plus_threads(
    moving_h264: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Kept in step with upstream: a MoviePy upgrade that changes its command fails here."""
    from moviepy.video.io.ffmpeg_reader import FFMPEG_VideoReader

    commands: list[list[str]] = []
    real_popen = subprocess.Popen

    def recording_popen(cmd: list[str], *args: Any, **kwargs: Any) -> Any:
        commands.append(list(cmd))
        return real_popen(cmd, *args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    upstream = FFMPEG_VideoReader(str(moving_h264))
    capped = FFMPEG_VideoReader(str(moving_h264))
    cap_decoder_threads(type("Clip", (), {"reader": capped})(), 3)
    assert isinstance(capped, ThreadCappedVideoReader)
    try:
        for start in (0.0, 2.5):
            commands.clear()
            upstream.initialize(start)
            capped.initialize(start)
            expected, actual = commands
            assert actual == [expected[0], "-threads", "3", *expected[1:]]
    finally:
        upstream.close()
        capped.close()


def test_the_export_leaves_the_reader_alone(moving_h264: Path) -> None:
    from moviepy import VideoFileClip
    from moviepy.video.io.ffmpeg_reader import FFMPEG_VideoReader

    clip = VideoFileClip(str(moving_h264), audio=False)
    try:
        assert cap_decoder_threads(clip, None) is clip
        assert type(clip.reader) is FFMPEG_VideoReader
    finally:
        clip.close()


def _project(media: Path) -> Project:
    clip = {
        "id": "shot",
        "assetId": "moving",
        "trackId": "v",
        "start": 0.0,
        "end": 2.0,
        "sourceStart": 1.0,
        "sourceEnd": 3.0,
        "effects": [],
        "keyframes": [],
    }
    return Project.model_validate(
        {
            "id": "p",
            "name": "threads",
            "fps": FPS,
            "resolution": {"width": 320, "height": 180},
            "timeline": {"tracks": [{"id": "v", "type": "video", "clips": [clip]}]},
            "assets": [
                {"id": "moving", "path": media.name, "kind": "video", "durationSeconds": 4.0}
            ],
            "transcript": [],
            "aiMemory": {},
            "history": [],
        }
    )


@pytest.fixture
def capped(monkeypatch: pytest.MonkeyPatch) -> list[int | None]:
    """The thread cap each opened source reader was given."""
    seen: list[int | None] = []
    real = decoder_threads_module.cap_decoder_threads

    def recording(clip: Any, threads: int | None) -> Any:
        seen.append(threads)
        return real(clip, threads)

    monkeypatch.setattr(decoder_threads_module, "cap_decoder_threads", recording)
    return seen


def test_frame_grabs_and_sheet_tiles_cap_their_readers(
    moving_h264: Path, capped: list[int | None]
) -> None:
    from framepilot_engine.render.frame_grab import grab_frame, render_frame_pixels_uncached

    project = _project(moving_h264)
    grab_frame(project, moving_h264.parent, 1.0)
    render_frame_pixels_uncached(
        project, moving_h264.parent, 0.5, max_dimension=128, burn_captions=False
    )
    assert capped == [PREVIEW_DECODER_THREADS, PREVIEW_DECODER_THREADS]


def test_review_and_scope_evidence_cap_their_readers(
    moving_h264: Path, capped: list[int | None]
) -> None:
    from framepilot_engine.validation.temporal_evidence import (
        FrameEvidenceRequest,
        ScopeEvidenceRequest,
        TemporalEvidenceRequest,
        acquire_temporal_evidence,
    )

    common = {"schemaVersion": 1, "projectRevision": 0, "reason": "threads"}
    requests: list[TemporalEvidenceRequest] = [
        FrameEvidenceRequest.model_validate(
            {**common, "requestId": "f", "kind": "frame", "atFrame": 10, "metrics": ["luma"]}
        ),
        ScopeEvidenceRequest.model_validate(
            {
                **common,
                "requestId": "s",
                "kind": "scope",
                "startFrame": 0,
                "endFrame": 60,
                "channels": ["luma"],
                "legalMin": 0,
                "legalMax": 1,
            }
        ),
    ]
    acquire_temporal_evidence(_project(moving_h264), moving_h264.parent, requests)
    assert capped == [PREVIEW_DECODER_THREADS, PREVIEW_DECODER_THREADS]


def test_the_export_compile_is_uncapped(moving_h264: Path, capped: list[int | None]) -> None:
    from framepilot_engine.media.assets import index_assets
    from framepilot_engine.render.compiler import compile_timeline
    from framepilot_engine.render.presets import ExportPreset
    from framepilot_engine.render.resources import close_clip_tree

    project = _project(moving_h264)
    assets = index_assets([a.model_dump() for a in project.assets], base_dir=moving_h264.parent)
    preset = ExportPreset(id="p", label="P", width=320, height=180, fps=FPS)
    close_clip_tree(compile_timeline(project, assets, preset))
    assert capped == [None]


@pytest.mark.usefixtures("require_ffprobe")
def test_a_variable_rate_reader_takes_the_cap_on_its_input(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """VFR sources get the pts reader, which builds its own command; the cap goes on it too."""
    from moviepy import VideoFileClip

    from framepilot_engine.render import pts_reader
    from tests import matte_fixtures as fx

    path = tmp_path / "vfr.mkv"
    pts = [0, 20, 60, 80, 140, 240]
    frames = [
        np.full((fx.HEIGHT, fx.WIDTH, 3), 10 + 20 * k, dtype=np.uint8) for k in range(len(pts))
    ]
    fx.write_vfr_source(path, frames, pts)
    commands: list[list[str]] = []
    from framepilot_engine.subprocess_safety import popen_argv as real_popen_argv

    def recording(binary: str, operands: list[str], **kwargs: Any) -> Any:
        commands.append(list(operands))
        return real_popen_argv(binary, operands, **kwargs)

    monkeypatch.setattr(f"{pts_reader.__name__}.popen_argv", recording)
    clip = pts_reader.use_pts_reader(VideoFileClip(str(path)), str(path), decoder_threads=2)
    try:
        assert isinstance(clip.reader, pts_reader.PtsVideoReader)
        clip.get_frame(0.1)
        operands = commands[-1]
        assert operands[operands.index("-threads") + 1] == "2"
        assert operands.index("-threads") < operands.index("-i")
    finally:
        clip.close()
