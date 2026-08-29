"""Preview and export agree on which frame a cut is on — measured, in frames.

Context-management P3.4 / ADR 0146. Until the frame grid existed there was no grid to
measure a cut against, so "the export cuts where the editor asked" was an invariant nobody
could put a number on. This suite puts a number on it, and the number is expected to be
**0 frames**.

How it measures. A timeline is built from two visually unambiguous sources — one solid
red, one solid blue — cut at frames chosen to be nowhere near a round second. It is
exported through the real ``export_video`` pipeline, and the exported FILE is then probed
frame by frame around each cut:

* the frame BEFORE the cut must still be the outgoing shot,
* the frame AT the cut must already be the incoming one.

If the export placed the cut one frame early or late, exactly one of those two reads flips
and the divergence is reported in frames rather than as a vague "looks wrong".

The preview leg is asserted in TypeScript (``preview-frame-parity.test.ts``): the editor
seeks by converting a time to a frame with the SAME grid this render honours, so the two
legs meet at ``secondsToFrame``.

What this does NOT prove. The sources are synthetic. A camera original brings its own
container timebase and B-frames, and verifying against one is recorded as outstanding
work in the phase file rather than claimed here — ``product-discipline.mdc`` forbids
supporting that claim with a fixture, so it is not made.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import pytest

from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.render.export_settings import ExportSettings
from framepilot_engine.render.frame_grid import frame_to_seconds, seconds_to_frame
from framepilot_engine.render.pipeline import export_video
from framepilot_engine.timeline.models import Project

#: Long enough that a cut is nowhere near the head of the file, short enough that CI does
#: not pay a minute of encode per rate. Each source is one flat colour, so the only thing a
#: probe can be reading is WHICH clip is on screen.
_SOURCE_SECONDS = 12.0

#: Every shipped export preset sets fps=30 and `pipeline.render` writes
#: `fps=preset.fps or project.fps`, so the OUTPUT rate is 30 whatever the project says.
#: Measuring against the project rate instead is how a passing test would hide that.
_SETTINGS = ExportSettings(fps=30)
_OUTPUT_FPS = 30


def _solid_source(path: Path, colour: str, fps: float) -> None:
    subprocess.run(
        [
            find_ffmpeg(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c={colour}:s=320x240:r={fps}:d={_SOURCE_SECONDS}",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _cut_project(fps: float, cut_seconds: float, end_seconds: float) -> Project:
    """Red until ``cut_seconds``, blue after it — one cut, at a known frame."""
    return Project.model_validate(
        {
            "id": "frameacc",
            "name": "Frame accuracy",
            "fps": fps,
            "assets": [
                {"id": "red", "path": "red.mp4", "kind": "video"},
                {"id": "blue", "path": "blue.mp4", "kind": "video"},
            ],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "c_red",
                                "assetId": "red",
                                "trackId": "v",
                                "start": 0.0,
                                "end": cut_seconds,
                                "sourceStart": 0.0,
                                "sourceEnd": cut_seconds,
                            },
                            {
                                "id": "c_blue",
                                "assetId": "blue",
                                "trackId": "v",
                                "start": cut_seconds,
                                "end": end_seconds,
                                "sourceStart": 0.0,
                                "sourceEnd": end_seconds - cut_seconds,
                            },
                        ],
                    }
                ]
            },
        }
    )


def _is_blue(frame: np.ndarray) -> bool:
    """Which shot this frame is, robust to codec colour drift."""
    mean = np.asarray(frame, dtype=np.float64).reshape(-1, 3).mean(axis=0)
    return bool(mean[2] > mean[0])


def _first_frame_of_shot_two(output_path: str, around: int) -> int:
    """The output frame index where the second shot first appears.

    Samples the MIDDLE of each frame's interval: a sample taken exactly on a boundary is
    asking a decoder to break a tie, which is a question about the probe rather than about
    the edit.
    """
    from moviepy import VideoFileClip

    half = 0.5 / _OUTPUT_FPS
    with VideoFileClip(output_path) as clip:
        for frame in range(max(0, around - 8), around + 9):
            time = frame_to_seconds(frame, _OUTPUT_FPS) + half
            if time >= clip.duration:
                break
            if _is_blue(clip.get_frame(time)):
                return frame
    raise AssertionError("the second shot never appears in the export")


def _render_one_cut(tmp_project_dir: Path, project_fps: int) -> tuple[str, float]:
    """Export a two-shot timeline cut at a frame of ``project_fps``'s grid."""
    _solid_source(tmp_project_dir / "red.mp4", "red", project_fps)
    _solid_source(tmp_project_dir / "blue.mp4", "blue", project_fps)
    # A cut deliberately not on a round second, at a frame the project's grid names exactly.
    cut_seconds = frame_to_seconds(seconds_to_frame(4.7, project_fps), project_fps)
    end_seconds = frame_to_seconds(seconds_to_frame(9.0, project_fps), project_fps)
    job = export_video(
        _cut_project(project_fps, cut_seconds, end_seconds),
        base_dir=tmp_project_dir,
        settings=_SETTINGS,
    )
    assert job.state == "completed", job.error
    assert job.output_path is not None
    return job.output_path, cut_seconds


@pytest.mark.usefixtures("require_ffprobe")
def test_preview_and_export_agree_to_the_frame_at_the_delivery_rate(
    tmp_project_dir: Path,
) -> None:
    """**Divergence: 0 frames.** The headline number P3.4 exists to produce.

    When the project's frame rate is the rate the file is delivered at — the ordinary
    case, since every shipped preset is 30 — the cut in the exported file is on exactly
    the frame the editor named, and the number can be stated rather than assumed.
    """
    output_path, cut_seconds = _render_one_cut(tmp_project_dir, _OUTPUT_FPS)
    requested = seconds_to_frame(cut_seconds, _OUTPUT_FPS)
    divergence = _first_frame_of_shot_two(output_path, requested) - requested
    assert divergence == 0, f"the export cut {divergence:+d} frame(s) from where it was asked to"


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize("project_fps", [24, 25])
def test_a_resampling_preset_never_cuts_EARLY_and_never_by_more_than_one_frame(
    tmp_project_dir: Path, project_fps: int
) -> None:
    """The measured limit, pinned rather than papered over.

    ``pipeline.render`` writes ``fps=preset.fps or project.fps`` and every shipped preset
    sets ``fps=30``, so a 24fps project exported to Reels is RESAMPLED. Its frame
    boundaries are then not boundaries of the file that comes out — 24fps frame 113 is
    4.708333s, which falls a quarter of the way INTO 30fps frame 141.

    Measured: the export places the cut on the next WHOLE output frame (142), where the
    grid's nearest-frame rule would have said 141. So the divergence is **+1 output frame
    at most, and never negative**, and the direction is the safe one: a cut a frame late
    shows one extra frame of the outgoing shot, where a cut a frame early clips the
    incoming action off its own first frame.

    This is a container limit, not a grid failure — a 30fps file cannot carry a 24fps
    boundary. It is recorded here so that changing it is a decision rather than an
    accident, and listed as outstanding in the phase file rather than claimed as zero.
    """
    output_path, cut_seconds = _render_one_cut(tmp_project_dir, project_fps)
    requested = seconds_to_frame(cut_seconds, _OUTPUT_FPS)
    divergence = _first_frame_of_shot_two(output_path, requested) - requested
    assert 0 <= divergence <= 1, (
        f"{project_fps}fps → {_OUTPUT_FPS}fps export diverged by {divergence:+d} frame(s)"
    )
