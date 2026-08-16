"""Golden-media tests: perceptual frame hashing (plan 2.3).

The render test renders a deterministic ``testsrc2`` source through the real
pipeline and asserts each sampled frame's perceptual aHash is within a small
Hamming distance of the committed golden in
``tests/fixtures/golden/reels_testsrc2.json``.

To regenerate the golden after an intentional framing change, render the fixture
source (its `lavfi` string) with ``export_video`` to the `preset_id`, recompute
``average_hash`` at each ``sample_timestamps`` entry, and update ``ahash``.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from framepilot_engine.render.pipeline import export_video
from framepilot_engine.timeline.models import Project
from framepilot_engine.validation.golden import average_hash, hamming_distance

_GOLDEN = Path(__file__).parent / "fixtures" / "golden" / "reels_testsrc2.json"


def _lower_region_diff(path_a: str, path_b: str, t: float) -> float:
    """Mean absolute pixel difference of the bottom quarter of two renders at ``t``."""
    from moviepy import VideoFileClip

    with VideoFileClip(path_a) as a, VideoFileClip(path_b) as b:
        fa = np.asarray(a.get_frame(t), dtype=np.float64)
        fb = np.asarray(b.get_frame(t), dtype=np.float64)
    lower = slice(int(fa.shape[0] * 0.75), None)
    return float(np.abs(fa[lower] - fb[lower]).mean())


# --- pure hash functions -----------------------------------------------------


def test_average_hash_is_stable_and_int() -> None:
    frame = np.zeros((20, 20, 3), dtype=np.uint8)
    frame[:, 10:] = 255  # left black, right white
    h1 = average_hash(frame)
    h2 = average_hash(frame.copy())
    assert isinstance(h1, int)
    assert h1 == h2  # deterministic


def test_average_hash_distinguishes_different_images() -> None:
    black = np.zeros((16, 16, 3), dtype=np.uint8)
    split = np.zeros((16, 16, 3), dtype=np.uint8)
    split[:, 8:] = 255
    assert hamming_distance(average_hash(black), average_hash(split)) > 0


def test_hamming_distance_basics() -> None:
    assert hamming_distance(0b1010, 0b1010) == 0
    assert hamming_distance(0b1111, 0b0000) == 4


# --- golden render -----------------------------------------------------------


@pytest.mark.usefixtures("require_ffprobe")
def test_render_matches_golden_hashes(tmp_project_dir: Path) -> None:
    golden = json.loads(_GOLDEN.read_text())

    # Deterministic source — the exact lavfi graph the golden was recorded from.
    from framepilot_engine.media.ffmpeg import find_ffmpeg

    source = tmp_project_dir / "src.mp4"
    subprocess.run(
        [find_ffmpeg(), "-y", "-f", "lavfi", "-i", golden["source"]["lavfi"],
         "-pix_fmt", "yuv420p", str(source)],
        check=True,
        capture_output=True,
    )

    duration = golden["source"]["duration_seconds"]
    project = Project.model_validate(
        {
            "id": "golden",
            "name": "Golden",
            "fps": 30,
            "assets": [{"id": "a1", "path": "src.mp4", "kind": "video"}],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "c1",
                                "assetId": "a1",
                                "trackId": "v",
                                "start": 0.0,
                                "end": duration,
                                "sourceStart": 0.0,
                                "sourceEnd": duration,
                            }
                        ],
                    }
                ]
            },
        }
    )

    job = export_video(project, base_dir=tmp_project_dir, preset_id=golden["preset_id"])
    assert job.state == "completed", job.error
    assert job.output_path is not None

    from moviepy import VideoFileClip

    tolerance = golden["hamming_tolerance"]
    with VideoFileClip(job.output_path) as clip:
        for ts, expected in zip(golden["sample_timestamps"], golden["ahash"], strict=True):
            got = average_hash(clip.get_frame(ts))
            distance = hamming_distance(expected, got)
            assert distance <= tolerance, f"t={ts}: hamming {distance} > {tolerance}"


# --- caption-timing golden (plan 3.3 burn-in render-wiring) -------------------


def _caption_project(duration: float, caption_style: dict[str, object] | None = None) -> Project:
    """A 1-video-track project with one caption clip over the first 0.7s."""
    return Project.model_validate(
        {
            "id": "cap",
            "name": "Captioned",
            "fps": 30,
            "assets": [{"id": "a1", "path": "src.mp4", "kind": "video"}],
            "transcript": [
                {"word": "hello", "start": 0.0, "end": 0.35},
                {"word": "world", "start": 0.35, "end": 0.7},
            ],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "c1",
                                "assetId": "a1",
                                "trackId": "v",
                                "start": 0.0,
                                "end": duration,
                                "sourceStart": 0.0,
                                "sourceEnd": duration,
                            }
                        ],
                    },
                    {
                        "id": "cap",
                        "type": "caption",
                        "clips": [
                            {
                                "id": "cap1",
                                "assetId": "__caption__",
                                "trackId": "cap",
                                "start": 0.0,
                                "end": 0.7,
                                "sourceStart": 0.0,
                                "sourceEnd": 0.7,
                                **(
                                    {"captionStyle": caption_style}
                                    if caption_style is not None
                                    else {}
                                ),
                            }
                        ],
                    },
                ]
            },
        }
    )


@pytest.mark.usefixtures("require_ffprobe")
def test_burned_captions_appear_only_during_their_range(tmp_project_dir: Path) -> None:
    """Burning captions changes the lower frame region only while a caption is on.

    This is the caption-timing golden: rendered with vs without burn-in, the
    bottom of the frame differs sharply at a timestamp inside the caption range
    and is essentially unchanged at a timestamp after it — proving the overlay is
    both drawn and correctly time-bounded.
    """
    from framepilot_engine.media.ffmpeg import find_ffmpeg

    duration = 1.5
    source = tmp_project_dir / "src.mp4"
    # A mid-gray source (not black) so render validation's black-frame check
    # passes; the translucent caption box still darkens the lower region clearly.
    subprocess.run(
        [find_ffmpeg(), "-y", "-f", "lavfi", "-i",
         f"color=c=gray:s=216x384:r=30:d={duration}", "-pix_fmt", "yuv420p", str(source)],
        check=True,
        capture_output=True,
    )

    project = _caption_project(duration)
    soft = export_video(
        project, base_dir=tmp_project_dir, preset_id="reels", output_path="soft.mp4"
    )
    burned = export_video(
        project,
        base_dir=tmp_project_dir,
        preset_id="reels",
        output_path="burned.mp4",
        burn_captions=True,
    )
    assert soft.state == "completed", soft.error
    assert burned.state == "completed", burned.error
    assert soft.output_path is not None and burned.output_path is not None

    during = _lower_region_diff(soft.output_path, burned.output_path, t=0.35)
    after = _lower_region_diff(soft.output_path, burned.output_path, t=1.2)

    # A caption is on screen during its range: the lower region differs clearly.
    assert during > 5.0, f"expected a visible caption at t=0.35 (diff={during})"
    # After the caption ends, the renders should match in that region.
    assert after < during, f"caption leaked past its range (during={during}, after={after})"
    assert after < 2.0, f"unexpected lower-region change after caption (diff={after})"


@pytest.mark.usefixtures("require_ffprobe")
def test_free_positioned_caption_renders_in_authored_region(tmp_project_dir: Path) -> None:
    """Schema-v16 geometry golden: a rotated caption moves out of the legacy lower band."""
    from moviepy import VideoFileClip

    from framepilot_engine.media.ffmpeg import find_ffmpeg

    duration = 0.8
    source = tmp_project_dir / "src.mp4"
    subprocess.run(
        [
            find_ffmpeg(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=gray:s=216x384:r=30:d={duration}",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    project = _caption_project(
        duration,
        {
            "templateId": "semantic-anchor",
            "xPercent": 24,
            "yPercent": 20,
            "maxWidthPercent": 42,
            "rotation": -8,
            "safeArea": False,
        },
    )
    soft = export_video(
        project, base_dir=tmp_project_dir, preset_id="reels", output_path="soft-position.mp4"
    )
    burned = export_video(
        project,
        base_dir=tmp_project_dir,
        preset_id="reels",
        output_path="burned-position.mp4",
        burn_captions=True,
    )
    assert soft.output_path is not None and burned.output_path is not None
    with VideoFileClip(soft.output_path) as a, VideoFileClip(burned.output_path) as b:
        fa = np.asarray(a.get_frame(0.35), dtype=np.float64)
        fb = np.asarray(b.get_frame(0.35), dtype=np.float64)
    delta = np.abs(fa - fb).mean(axis=2)
    upper_left = delta[: int(delta.shape[0] * 0.4), : int(delta.shape[1] * 0.5)].mean()
    lower = delta[int(delta.shape[0] * 0.7) :].mean()
    assert upper_left > 1.0
    assert upper_left > lower * 2
