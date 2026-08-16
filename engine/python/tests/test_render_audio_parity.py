"""Rendered audio proof: an audio edit must change the exported samples.

The mixing DSP is unit tested in ``test_audio_mixing.py``, but a correct envelope
function proves nothing about the file a user actually gets. These tests export
through the real pipeline, decode the result, and measure it — so "the fade was
applied" means the exported audio genuinely gets quieter.

Each positive case carries a negative control, because a test that only shows
some difference cannot tell a fade from a mistake.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest

from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.render.pipeline import RenderOptions, RenderState, render
from framepilot_engine.timeline.models import Project

SECONDS = 4.0


def _project(*, fade_out: float | None) -> Project:
    clip: dict[str, object] = {
        "id": "tone",
        "assetId": "music",
        "trackId": "a1",
        "start": 0.0,
        "end": SECONDS,
        "sourceStart": 0.0,
        "sourceEnd": SECONDS,
    }
    if fade_out is not None:
        # Fades live on an `audio_gain` effect's params (compiler reads
        # `fadeOutSeconds`), not as a clip field — a plausible-looking `fadeOut`
        # on the clip is simply ignored, which reads as "the fade did nothing".
        clip["effects"] = [
            {
                "id": "fader",
                "type": "audio_gain",
                "params": {"fadeOutSeconds": fade_out},
            }
        ]
    return Project.model_validate(
        {
            "id": "p_audio_parity",
            "name": "Audio parity",
            "fps": 30,
            "resolution": {"width": 160, "height": 120},
            "assets": [
                {"id": "bed", "path": "bed.mp4", "kind": "video"},
                {"id": "music", "path": "music.wav", "kind": "audio"},
            ],
            "timeline": {
                "tracks": [
                    {
                        "id": "v1",
                        "type": "video",
                        "clips": [
                            {
                                "id": "picture",
                                "assetId": "bed",
                                "trackId": "v1",
                                "start": 0.0,
                                "end": SECONDS,
                                "sourceStart": 0.0,
                                "sourceEnd": SECONDS,
                            }
                        ],
                    },
                    {"id": "a1", "type": "audio", "clips": [clip]},
                ]
            },
        }
    )


@pytest.fixture
def media(media_factory: Callable[..., Path], tmp_project_dir: Path) -> Path:
    picture = media_factory("bed.mp4", seconds=SECONDS, with_audio=False, color="gray")
    (tmp_project_dir / "bed.mp4").write_bytes(picture.read_bytes())
    tone = media_factory("music.wav", seconds=SECONDS, with_video=False)
    (tmp_project_dir / "music.wav").write_bytes(tone.read_bytes())
    return tmp_project_dir


def _rms_window(rendered: Path, start: float, duration: float) -> float:
    """RMS of the exported audio over one window, decoded to raw samples."""
    result = subprocess.run(
        [
            find_ffmpeg(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            str(start),
            "-t",
            str(duration),
            "-i",
            str(rendered),
            "-vn",
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            "48000",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    samples = np.frombuffer(result.stdout, dtype=np.int16).astype(np.float64)
    assert samples.size > 0, "the export carried no audio at all"
    return float(np.sqrt(np.mean(np.square(samples))))


def _export(project: Project, base: Path, name: str) -> Path:
    job = render(project, RenderOptions(output_path=f"out/{name}.mp4"), base_dir=base)
    assert job.state == RenderState.COMPLETED, job.error
    assert job.output_path is not None
    return Path(job.output_path)


@pytest.mark.usefixtures("require_ffprobe")
def test_a_fade_out_actually_quietens_the_exported_audio(media: Path) -> None:
    faded = _export(_project(fade_out=2.0), media, "faded")

    head = _rms_window(faded, 0.2, 0.5)
    tail = _rms_window(faded, SECONDS - 0.4, 0.3)

    assert head > 0
    assert tail < head * 0.5, "the fade never reached the exported samples"


@pytest.mark.usefixtures("require_ffprobe")
def test_without_a_fade_the_level_holds(media: Path) -> None:
    """Negative control: the same measurement must not report a fade that is absent."""
    flat = _export(_project(fade_out=None), media, "flat")

    head = _rms_window(flat, 0.2, 0.5)
    tail = _rms_window(flat, SECONDS - 0.4, 0.3)

    assert tail > head * 0.7, "a clip with no fade must not read as fading"


def _project_with_gain(params: dict[str, object]) -> Project:
    project = _project(fade_out=None)
    audio_clip = project.timeline.tracks[1].clips[0]
    effect_cls = type(audio_clip).model_fields["effects"].annotation.__args__[0]  # type: ignore[union-attr]
    audio_clip.effects = [
        effect_cls.model_validate({"id": "fader", "type": "audio_gain", "params": params})
    ]
    return project


@pytest.mark.usefixtures("require_ffprobe")
def test_a_gain_change_reaches_the_exported_samples(media: Path) -> None:
    quiet = _export(_project_with_gain({"gainDb": -12.0}), media, "quiet")
    loud = _export(_project_with_gain({"gainDb": 0.0}), media, "loud")

    quiet_level = _rms_window(quiet, 0.5, 1.0)
    loud_level = _rms_window(loud, 0.5, 1.0)

    # -12 dB is a quarter of the amplitude; allow codec slack but require the
    # measurement to see a real, directional change rather than any change.
    assert quiet_level < loud_level * 0.5


@pytest.mark.usefixtures("require_ffprobe")
def test_a_gain_cut_does_not_read_as_a_boost(media: Path) -> None:
    """Negative control: direction matters, not just difference."""
    cut = _export(_project_with_gain({"gainDb": -12.0}), media, "cut")
    flat = _export(_project_with_gain({"gainDb": 0.0}), media, "flat_gain")

    assert _rms_window(cut, 0.5, 1.0) < _rms_window(flat, 0.5, 1.0)


@pytest.mark.usefixtures("require_ffprobe")
def test_normalization_lifts_a_quiet_source(media: Path) -> None:
    """Normalization is a claim about reaching a target level, so level is read."""
    quiet = _export(_project_with_gain({"gainDb": -18.0}), media, "pre_norm")
    normalized = _export(
        _project_with_gain({"gainDb": -18.0, "normalize": True}), media, "normalized"
    )

    assert _rms_window(normalized, 0.5, 1.0) > _rms_window(quiet, 0.5, 1.0) * 1.5


@pytest.mark.usefixtures("require_ffprobe")
def test_normalization_off_leaves_the_quiet_source_quiet(media: Path) -> None:
    """Control: the lift must come from normalization, not from re-exporting."""
    once = _export(_project_with_gain({"gainDb": -18.0}), media, "quiet_a")
    twice = _export(_project_with_gain({"gainDb": -18.0}), media, "quiet_b")

    assert _rms_window(once, 0.5, 1.0) == pytest.approx(_rms_window(twice, 0.5, 1.0), rel=0.05)
