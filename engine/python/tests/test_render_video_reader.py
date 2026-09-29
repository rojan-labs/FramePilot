"""How the compiler opens a video source (render/video_reader.py).

Pinned: the probed reader IS MoviePy's reader — its attributes, its command (plus ``-threads``
when capped), and its pixels at every instant whatever is read first, seeks and short reads
included — while it probes once, opens once and starts no decoder until a frame is asked for.
The cap reaches the readers of every preview and evidence composite, and none of the export's.
"""

from __future__ import annotations

import subprocess
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.render import video_reader
from framepilot_engine.render.compiler import PREVIEW_DECODER_THREADS
from framepilot_engine.render.video_reader import (
    ProbedVideoFileClip,
    ProbedVideoReader,
    probe_video,
)
from framepilot_engine.timeline.models import Project

FPS = 30
#: Instants read in order: sequential steps, a forward jump past MoviePy's 100-frame skip
#: window (0.533 s -> 3.9 s) and backward reads; the last two each start ffmpeg at a new -ss.
INSTANTS = (0.0, 0.5, 0.533, 3.9, 1.2, 2.0, 0.1, 3.0)
#: The same reads started elsewhere: a first read inside the skip window, and one past it.
FIRST_READS = (INSTANTS, (0.5, *INSTANTS), (3.9, *INSTANTS))


@pytest.fixture(scope="module")
def moving_h264(ffmpeg_bin: str, tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Four seconds of a moving pattern in H.264 with B-frames and 1 s GOPs."""
    path = tmp_path_factory.mktemp("video-reader") / "moving.mp4"
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


def _moviepy_frames(path: Path, instants: tuple[float, ...]) -> list[np.ndarray[Any, Any]]:
    from moviepy import VideoFileClip

    clip = VideoFileClip(str(path), audio=False)
    try:
        return [np.array(clip.get_frame(t)) for t in instants]
    finally:
        clip.close()


def _probed_frames(
    path: Path, instants: tuple[float, ...], threads: int | None
) -> list[np.ndarray[Any, Any]]:
    clip = ProbedVideoFileClip(path, infos=probe_video(path), audio=False, decoder_threads=threads)
    try:
        return [np.array(clip.get_frame(t)) for t in instants]
    finally:
        clip.close()


@pytest.mark.parametrize("instants", FIRST_READS, ids=["from-0", "near-first", "far-first"])
def test_probed_frames_are_moviepys_frames_to_the_pixel(
    moving_h264: Path, instants: tuple[float, ...]
) -> None:
    expected = _moviepy_frames(moving_h264, instants)
    for threads in (None, 1, 2, PREVIEW_DECODER_THREADS):
        for at, want, got in zip(
            instants, expected, _probed_frames(moving_h264, instants, threads), strict=True
        ):
            np.testing.assert_array_equal(got, want, f"threads={threads} t={at}")


@pytest.mark.parametrize("threads", [None, PREVIEW_DECODER_THREADS])
@pytest.mark.parametrize("past_the_end", [4.5, 9.0], ids=["inside-skip-window", "past-it"])
def test_a_first_read_past_the_end_falls_back_like_moviepy(
    moving_h264: Path, threads: int | None, past_the_end: float
) -> None:
    """MoviePy answers a short read with the frame it holds; its eager reader held frame 0."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        expected = _moviepy_frames(moving_h264, (past_the_end, 1.0))
        actual = _probed_frames(moving_h264, (past_the_end, 1.0), threads)
    for want, got in zip(expected, actual, strict=True):
        np.testing.assert_array_equal(got, want)


def test_the_probed_reader_is_moviepys_reader(moving_h264: Path) -> None:
    """Kept in step with upstream: every attribute MoviePy's constructor sets, the same."""
    from moviepy import VideoFileClip
    from moviepy.video.io.ffmpeg_reader import FFMPEG_VideoReader

    lazy = {"proc", "last_read", "pos", "decoder_threads", "started"}
    for target in (None, (160, 90), (None, 90), (240, None)):
        upstream = FFMPEG_VideoReader(str(moving_h264), target_resolution=target)
        probed = ProbedVideoReader(
            str(moving_h264), probe_video(moving_h264), target_resolution=target
        )
        try:
            assert {k: v for k, v in vars(probed).items() if k not in lazy} == {
                k: v for k, v in vars(upstream).items() if k not in lazy
            }
        finally:
            upstream.close()
            probed.close()
    moviepy_clip = VideoFileClip(str(moving_h264), target_resolution=(160, 90))
    probed_clip = ProbedVideoFileClip(
        moving_h264, infos=probe_video(moving_h264), target_resolution=(160, 90)
    )
    try:
        for attribute in ("duration", "end", "fps", "size", "rotation", "filename", "start"):
            assert getattr(probed_clip, attribute) == getattr(moviepy_clip, attribute), attribute
        assert (probed_clip.audio is None) == (moviepy_clip.audio is None)
    finally:
        moviepy_clip.close()
        probed_clip.close()


def test_the_capped_command_is_moviepys_plus_threads(
    moving_h264: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A MoviePy upgrade that changes its command fails here; uncapped, the command is its own."""
    from moviepy.video.io.ffmpeg_reader import FFMPEG_VideoReader

    commands: list[list[str]] = []
    real_popen = subprocess.Popen

    def recording_popen(cmd: list[str], *args: Any, **kwargs: Any) -> Any:
        commands.append(list(cmd))
        return real_popen(cmd, *args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    upstream = FFMPEG_VideoReader(str(moving_h264))
    capped = ProbedVideoReader(str(moving_h264), probe_video(moving_h264), decoder_threads=3)
    uncapped = ProbedVideoReader(str(moving_h264), probe_video(moving_h264))
    try:
        for start in (0.0, 2.5):
            commands.clear()
            upstream.initialize(start)
            capped.initialize(start)
            uncapped.initialize(start)
            expected, actual, own = commands
            assert actual == [expected[0], "-threads", "3", *expected[1:]]
            assert own == expected
    finally:
        upstream.close()
        capped.close()
        uncapped.close()


def test_a_source_is_probed_once_per_version(
    moving_h264: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    from moviepy.video.io.ffmpeg_reader import ffmpeg_parse_infos as real

    def recording(path: str, *args: Any, **kwargs: Any) -> Any:
        calls.append(path)
        return real(path, *args, **kwargs)

    monkeypatch.setattr(f"{video_reader.__name__}.ffmpeg_parse_infos", recording)
    monkeypatch.setattr(video_reader, "_PROBES", {})
    first = probe_video(moving_h264)
    first["video_size"][0] = -1  # a caller's copy: mutating it must not reach the cache
    second = probe_video(moving_h264)
    assert calls == [str(moving_h264)]
    assert second["video_size"][0] == 320


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


class _Work:
    """What opening sources cost: probes, readers (with their thread cap), decoder starts."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.probes: list[str] = []
        self.readers: list[int | None] = []
        self.decoder_starts: list[list[str]] = []
        from moviepy.video.io.ffmpeg_reader import ffmpeg_parse_infos as real_parse

        real_clip = video_reader.ProbedVideoFileClip
        real_popen = subprocess.Popen

        def parse(path: str, *args: Any, **kwargs: Any) -> Any:
            self.probes.append(path)
            return real_parse(path, *args, **kwargs)

        def clip(*args: Any, **kwargs: Any) -> Any:
            self.readers.append(kwargs.get("decoder_threads"))
            return real_clip(*args, **kwargs)

        def popen(cmd: Any, *args: Any, **kwargs: Any) -> Any:
            if isinstance(cmd, list) and "rawvideo" in cmd:
                self.decoder_starts.append(list(cmd))
            return real_popen(cmd, *args, **kwargs)

        monkeypatch.setattr(f"{video_reader.__name__}.ffmpeg_parse_infos", parse)
        monkeypatch.setattr(video_reader, "_PROBES", {})
        monkeypatch.setattr(video_reader, "ProbedVideoFileClip", clip)
        monkeypatch.setattr(subprocess, "Popen", popen)

    def threads_of_starts(self) -> list[str | None]:
        return [
            cmd[cmd.index("-threads") + 1] if "-threads" in cmd else None
            for cmd in self.decoder_starts
        ]


@pytest.fixture
def work(monkeypatch: pytest.MonkeyPatch) -> _Work:
    from framepilot_engine.render.composition_cache import (
        COMPOSITION_CACHE,
        FRAME_WINDOW_CACHE,
        REVIEW_WINDOW_CACHE,
    )

    for cache in (COMPOSITION_CACHE, FRAME_WINDOW_CACHE, REVIEW_WINDOW_CACHE):
        cache.clear()
    return _Work(monkeypatch)


def test_a_frame_grab_probes_opens_and_starts_one_capped_decoder(
    moving_h264: Path, work: _Work
) -> None:
    """AL38: one probe, one reader, one decoder start — capped from its first frame."""
    from framepilot_engine.render.frame_grab import grab_frame, render_frame_pixels_uncached

    project = _project(moving_h264)
    grab_frame(project, moving_h264.parent, 1.0)
    assert work.probes == [str(moving_h264)]
    assert work.readers == [PREVIEW_DECODER_THREADS]
    assert work.threads_of_starts() == [str(PREVIEW_DECODER_THREADS)]
    render_frame_pixels_uncached(
        project, moving_h264.parent, 0.5, max_dimension=128, burn_captions=False
    )
    assert work.probes == [str(moving_h264)], "the second compile reuses the probe"
    assert work.readers == [PREVIEW_DECODER_THREADS, PREVIEW_DECODER_THREADS]
    assert work.threads_of_starts() == [str(PREVIEW_DECODER_THREADS)] * 2


def test_review_and_scope_evidence_cap_their_readers(moving_h264: Path, work: _Work) -> None:
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
    assert work.readers == [PREVIEW_DECODER_THREADS, PREVIEW_DECODER_THREADS]
    assert len(work.probes) == 1
    assert set(work.threads_of_starts()) == {str(PREVIEW_DECODER_THREADS)}


def test_the_export_compile_is_uncapped_and_starts_no_decoder(
    moving_h264: Path, work: _Work
) -> None:
    from framepilot_engine.media.assets import index_assets
    from framepilot_engine.render.compiler import compile_timeline
    from framepilot_engine.render.presets import ExportPreset
    from framepilot_engine.render.resources import close_clip_tree

    project = _project(moving_h264)
    assets = index_assets([a.model_dump() for a in project.assets], base_dir=moving_h264.parent)
    preset = ExportPreset(id="p", label="P", width=320, height=180, fps=FPS)
    composite = compile_timeline(project, assets, preset)
    try:
        assert work.readers == [None]
        assert work.probes == [str(moving_h264)]
        composite.get_frame(0.0)
        assert work.threads_of_starts() == [None]
    finally:
        close_clip_tree(composite)


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
