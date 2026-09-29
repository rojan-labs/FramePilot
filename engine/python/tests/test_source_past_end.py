"""AL42: a short sound, and a clip that reads a little past its file, render and measure.

Audio past its file is silence; a video past its file holds its last frame.

Harness run 17 crashed ``measure_loudness`` twice with ``OSError: Error in file
Swipe_Whoosh.mp3, Accessing time t=1.00-1.00 seconds, with clip duration=0.500000``. MoviePy's
audio reader splits a request whose samples span more than half its buffer and recurses on the
in-range MASK instead of the times; ``AudioFileClip`` caps the buffer at a short file's own
length, so a 0.45 s whoosh took that path on every 32768-sample loudness block
(``render/audio_reads.py``). These tests pin the reader contract on a real short file, then
run the loudness evidence and the export on a clip whose source out-point is the asset's length
rounded UP to the 30 fps frame grid (the run's ``add_music``/``add_clip`` placement).
"""

from __future__ import annotations

import io
import math
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from framepilot_engine.media.assets import index_assets
from framepilot_engine.render.audio_reads import bound_audio_reads
from framepilot_engine.render.compiler import compile_timeline
from framepilot_engine.render.export_settings import ExportSettings
from framepilot_engine.render.frame_grab import grab_frame
from framepilot_engine.render.pipeline import export_video
from framepilot_engine.render.presets import ExportPreset
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Project
from framepilot_engine.validation.temporal_evidence import (
    LoudnessEvidenceRequest,
    acquire_temporal_evidence,
)

_FPS = 30
#: The run's whoosh: 0.447506 s long, so a 14-frame span (0.4667 s) runs past it.
_WHOOSH_SECONDS = 0.447506
_WHOOSH_FRAMES_UP = math.ceil(_WHOOSH_SECONDS * _FPS)
_SOURCE_END = _WHOOSH_FRAMES_UP / _FPS
_SAMPLE_RATE = 44_100
_TIMELINE_END_FRAME = round((1.0 + _SOURCE_END) * _FPS)


def _tone(path: Path, ffmpeg_bin: str, seconds: float) -> Path:
    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:sample_rate={_SAMPLE_RATE}:duration={seconds}",
            "-ac",
            "2",
            str(path),
        ],
        check=True,
    )
    return path


@pytest.fixture
def whoosh(tmp_project_dir: Path, ffmpeg_bin: str) -> Path:
    return _tone(tmp_project_dir / "whoosh.mp3", ffmpeg_bin, _WHOOSH_SECONDS)


def _opened(path: Path) -> Any:
    from moviepy import AudioFileClip

    return bound_audio_reads(AudioFileClip(str(path)))


def _reference(clip: Any, times: np.ndarray[Any, np.dtype[np.float64]]) -> Any:
    """The file's samples read by MoviePy itself, in slices too small for it to split."""
    slices = [clip.reader.get_frame(times[i : i + 1_000]) for i in range(0, len(times), 1_000)]
    return np.concatenate(slices)


class TestReadAudioSamples:
    def test_a_block_wider_than_half_a_short_files_buffer_reads_the_file(
        self, whoosh: Path
    ) -> None:
        clip = _opened(whoosh)
        try:
            # The run's shape: a block starting before the clip and ending inside it, whose
            # in-file samples span far more than the 22051-sample buffer's half.
            assert clip.reader.buffersize < 32_768
            times = -0.1 + np.arange(24_000) / 48_000.0
            got = clip.get_frame(times)
            assert got.shape == (len(times), 2)
            before = times < 0
            assert not got[before].any()
            np.testing.assert_allclose(got[~before], _reference(clip, times[~before]))
            # lavfi's sine peaks at 1/8 of full scale.
            assert np.abs(got[~before]).max() > 0.05
        finally:
            clip.close()

    def test_a_request_entirely_past_the_file_is_silence_not_an_error(self, whoosh: Path) -> None:
        clip = _opened(whoosh)
        try:
            times = 1.0 + np.arange(4_096) / 48_000.0
            assert not clip.get_frame(times).any()
            assert not np.asarray(clip.get_frame(5.0)).any()
            assert not np.asarray(clip.get_frame(-0.01)).any()
        finally:
            clip.close()

    def test_a_reversed_request_reads_the_same_samples_backwards(self, whoosh: Path) -> None:
        clip = _opened(whoosh)
        try:
            times = np.arange(20_000) / 48_000.0
            np.testing.assert_allclose(clip.get_frame(times[::-1]), clip.get_frame(times)[::-1])
        finally:
            clip.close()

    def test_a_long_files_reads_are_unchanged(self, tmp_project_dir: Path, ffmpeg_bin: str) -> None:
        from moviepy import AudioFileClip

        path = _tone(tmp_project_dir / "long.wav", ffmpeg_bin, 6.0)
        plain, bound = AudioFileClip(str(path)), _opened(path)
        try:
            times = 1.0 + np.arange(32_768) / 48_000.0
            np.testing.assert_array_equal(bound.get_frame(times), plain.get_frame(times))
        finally:
            plain.close()
            bound.close()


def _overrun_project(extra_tracks: list[dict[str, Any]], assets: list[dict[str, Any]]) -> Project:
    """A whoosh clip whose source out-point is the asset's length rounded up to a frame."""
    return Project.model_validate(
        {
            "id": "al42",
            "name": "AL42",
            "fps": _FPS,
            "resolution": {"width": 640, "height": 480},
            "assets": [
                {
                    "id": "whoosh",
                    "path": "whoosh.mp3",
                    "kind": "audio",
                    "durationSeconds": _WHOOSH_SECONDS,
                },
                *assets,
            ],
            "timeline": {
                "revision": 4,
                "tracks": [
                    *extra_tracks,
                    {
                        "id": "sfx",
                        "type": "audio",
                        "clips": [
                            {
                                "id": "hit",
                                "assetId": "whoosh",
                                "trackId": "sfx",
                                "start": 1.0,
                                "end": 1.0 + _SOURCE_END,
                                "sourceStart": 0.0,
                                "sourceEnd": _SOURCE_END,
                                "effects": [
                                    {
                                        "id": "hit__gain",
                                        "type": "audio_gain",
                                        "params": {"gainDb": -12},
                                        "keyframes": [],
                                    }
                                ],
                            }
                        ],
                    },
                ],
            },
        }
    )


def test_the_clip_overruns_its_asset_by_less_than_a_frame() -> None:
    assert _SOURCE_END > _WHOOSH_SECONDS
    assert _SOURCE_END - _WHOOSH_SECONDS < 1 / _FPS


def test_loudness_evidence_measures_a_short_overrunning_sound(
    whoosh: Path, tmp_project_dir: Path
) -> None:
    project = _overrun_project([], [])
    request = LoudnessEvidenceRequest.model_validate(
        {
            "schemaVersion": 1,
            "requestId": "loudness",
            "projectRevision": 4,
            "reason": "AL42",
            "kind": "loudness",
            "startFrame": 0,
            "endFrame": _TIMELINE_END_FRAME,
            "channels": "mix",
        }
    )

    [result] = acquire_temporal_evidence(project, tmp_project_dir, [request]).results

    assert result.kind == "loudness"
    assert result.sample.sample_peak_dbfs is not None
    clip = _opened(whoosh)
    try:
        file_peak = float(np.abs(clip.get_frame(np.arange(20_000) / 44_100.0)).max())
    finally:
        clip.close()
    # The whole whoosh is measured, 12 dB down (the clip's gain), and nothing else.
    expected = 20 * math.log10(file_peak) - 12.0
    assert result.sample.sample_peak_dbfs == pytest.approx(expected, abs=0.5)
    assert result.sample.integrated_lufs is not None


def test_the_whole_mix_reads_past_a_layer_end_as_silence(
    whoosh: Path, tmp_project_dir: Path
) -> None:
    """Every block the loudness window reads, including one that starts at the clip's end."""
    project = _overrun_project([], [])
    preset = ExportPreset(id="al42", label="AL42", width=640, height=480, fps=_FPS)
    assets = index_assets(
        [asset.model_dump() for asset in project.assets], base_dir=tmp_project_dir
    )
    composition = compile_timeline(project, assets, preset)
    try:
        end = 1.0 + _SOURCE_END
        # Starting exactly at the layer's end: MoviePy's is_playing is inclusive there.
        tail = composition.audio.get_frame(end + np.arange(4_096) / 48_000.0)
        assert not np.asarray(tail).any()
        whole = composition.audio.get_frame(np.arange(end * 48_000) / 48_000.0)
        assert np.abs(whole).max() > 0.01
    finally:
        close_clip_tree(composition)


def test_export_with_a_short_overrunning_sound_passes_validation(
    whoosh: Path, tmp_project_dir: Path, ffmpeg_bin: str
) -> None:
    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size=640x480:rate={_FPS}:duration=2",
            "-pix_fmt",
            "yuv420p",
            str(tmp_project_dir / "picture.mp4"),
        ],
        check=True,
    )
    picture = {
        "id": "v",
        "type": "video",
        "clips": [
            {
                "id": "shot",
                "assetId": "picture",
                "trackId": "v",
                "start": 0.0,
                "end": 2.0,
                "sourceStart": 0.0,
                "sourceEnd": 2.0,
            }
        ],
    }
    project = _overrun_project(
        [picture],
        [{"id": "picture", "path": "picture.mp4", "kind": "video", "durationSeconds": 2.0}],
    )

    job = export_video(
        project,
        base_dir=tmp_project_dir,
        settings=ExportSettings(resolution="480p", fps=_FPS),
    )

    assert job.state == "completed", job.error
    assert job.validation is not None and job.validation.ok
    assert job.output_path is not None and Path(job.output_path).stat().st_size > 0


def _colour_source(path: Path, ffmpeg_bin: str, colour: str, seconds: float) -> None:
    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c={colour}:size=320x240:rate={_FPS}:duration={seconds}",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
    )


def test_a_video_clip_one_frame_past_its_file_holds_its_last_frame(
    tmp_project_dir: Path, ffmpeg_bin: str
) -> None:
    """Before AL42 its last timeline frame showed the layer beneath (black on one track)."""
    _colour_source(tmp_project_dir / "red.mp4", ffmpeg_bin, "red", 1.0)
    _colour_source(tmp_project_dir / "blue.mp4", ffmpeg_bin, "blue", 2.0)
    over = 1.0 + 1 / _FPS
    project = Project.model_validate(
        {
            "id": "al42-video",
            "name": "AL42 video",
            "fps": _FPS,
            "resolution": {"width": 320, "height": 240},
            "assets": [
                {"id": "red", "path": "red.mp4", "kind": "video", "durationSeconds": 1.0},
                {"id": "blue", "path": "blue.mp4", "kind": "video", "durationSeconds": 2.0},
            ],
            "timeline": {
                "tracks": [
                    {
                        "id": "front",
                        "type": "video",
                        "clips": [
                            {
                                "id": "shot",
                                "assetId": "red",
                                "trackId": "front",
                                "start": 0.0,
                                "end": over,
                                "sourceStart": 0.0,
                                "sourceEnd": over,
                            }
                        ],
                    },
                    {
                        "id": "back",
                        "type": "video",
                        "clips": [
                            {
                                "id": "under",
                                "assetId": "blue",
                                "trackId": "back",
                                "start": 0.0,
                                "end": 2.0,
                                "sourceStart": 0.0,
                                "sourceEnd": 2.0,
                            }
                        ],
                    },
                ]
            },
        }
    )

    def red(pixel: Any) -> bool:
        return bool(pixel[0] > 200 and pixel[2] < 50)

    for t, expect_red in ((29 / _FPS, True), (1.0, True), (over, False)):
        grabbed = grab_frame(project, tmp_project_dir, t, lossless=True, image_format="png")
        pixels = np.asarray(Image.open(io.BytesIO(grabbed.data)).convert("RGB"))
        assert red(pixels[120, 160]) is expect_red, t

    job = export_video(
        project, base_dir=tmp_project_dir, settings=ExportSettings(resolution="480p", fps=_FPS)
    )
    assert job.state == "completed", job.error
    assert job.output_path is not None
    from moviepy import VideoFileClip

    with VideoFileClip(job.output_path) as exported:
        # The frame at 1.0 s is the one the overrun covers; 1.05 s is past the clip.
        assert red(exported.get_frame(1.0 + 0.5 / _FPS)[120, 160])
        assert not red(exported.get_frame(over + 0.5 / _FPS)[120, 160])
