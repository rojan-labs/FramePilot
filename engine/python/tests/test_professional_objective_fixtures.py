"""Render-backed objective fixtures for the professional domain controllers.

Each P2 controller (timeline, motion, color, tracking/mask, audio) gets one fixture that runs a
real edit outcome through the deterministic render path and measures the acquired evidence. These
prove the editorial objective — a frame-accurate cut, a smooth trajectory that covers the canvas, a
grade that moves the image the intended way inside legal scopes, a tracked region that stays in
frame, a mix that is safe and continuous — rather than asserting a patch shape.

Media is synthesised with ffmpeg so the objectives are measured from real decoded pixels and audio,
never from a stubbed composition.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from itertools import pairwise
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.timeline.models import Project
from framepilot_engine.validation.temporal_evidence import (
    AudioEvidenceRequest,
    ComparisonEvidenceRequest,
    FrameEvidenceRequest,
    LoudnessEvidenceRequest,
    MotionEvidenceRequest,
    RangeEvidenceRequest,
    ScopeEvidenceRequest,
    ScopeSample,
    TemporalEvidenceRequest,
    acquire_temporal_evidence,
)

FPS = 30
# Match the media size exactly: letterbox bars would be measured as real black pixels.
WIDTH, HEIGHT = 320, 240
REVISION = 3

MediaFactory = Callable[..., Path]

# Rec.709 luma of the saturated lavfi sources, allowing for yuv420p round-tripping.
RED_LUMA = 0.2126
BLUE_LUMA = 0.0722
# ffmpeg follows X11 colour names, where `green` is half-bright (0x008000); `lime` is the
# saturated one, so the fixture uses `lime` and this stays a clean Rec.709 coefficient.
GREEN_LUMA = 0.7152
CHANNEL_TOLERANCE = 0.05


def _request(kind: str, request_id: str) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "requestId": request_id,
        "projectRevision": REVISION,
        "reason": f"professional objective fixture: {kind}",
        "kind": kind,
    }


def _project(assets: list[dict[str, Any]], tracks: list[dict[str, Any]]) -> Project:
    return Project.model_validate(
        {
            "id": "professional_objective",
            "name": "Professional objective fixture",
            "fps": FPS,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": assets,
            "timeline": {"revision": REVISION, "tracks": tracks},
        }
    )


def _clip(
    clip_id: str,
    asset_id: str,
    track_id: str,
    start: float,
    end: float,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "id": clip_id,
        "assetId": asset_id,
        "trackId": track_id,
        "start": start,
        "end": end,
        "sourceStart": 0.0,
        "sourceEnd": end - start,
        **extra,
    }


def _stage(media: Path, project_dir: Path, name: str) -> None:
    (project_dir / name).write_bytes(media.read_bytes())


@pytest.mark.usefixtures("require_ffprobe")
def test_timeline_objective_cut_is_frame_accurate_and_sound_stays_continuous(
    tmp_project_dir: Path, media_factory: MediaFactory
) -> None:
    """Timeline controller objective: the picture cut lands on the intended frame.

    Two saturated shots meet at exactly one second. Frame 29 must still be the outgoing shot and
    frame 30 the incoming one — an off-by-one edit would show up immediately — while the sound bed
    running underneath both shots stays continuous across that boundary.
    """
    _stage(media_factory("red.mp4", seconds=1.0, color="red"), tmp_project_dir, "red.mp4")
    _stage(media_factory("blue.mp4", seconds=1.0, color="blue"), tmp_project_dir, "blue.mp4")
    project = _project(
        assets=[
            {"id": "red", "path": "red.mp4", "kind": "video"},
            {"id": "blue", "path": "blue.mp4", "kind": "video"},
        ],
        tracks=[
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    _clip("outgoing", "red", "v1", 0.0, 1.0),
                    _clip("incoming", "blue", "v1", 1.0, 2.0),
                ],
            }
        ],
    )
    requests: list[TemporalEvidenceRequest] = [
        FrameEvidenceRequest.model_validate(
            {**_request("frame", "last_outgoing"), "atFrame": 29, "metrics": ["luma"]}
        ),
        FrameEvidenceRequest.model_validate(
            {**_request("frame", "first_incoming"), "atFrame": 30, "metrics": ["luma"]}
        ),
        ComparisonEvidenceRequest.model_validate(
            {
                **_request("comparison", "cut"),
                "leftFrame": 29,
                "rightFrame": 30,
                "check": "shot_match",
                "maxDifference": 1,
            }
        ),
        AudioEvidenceRequest.model_validate(
            {
                **_request("audio", "across_cut"),
                "startFrame": 25,
                "endFrame": 35,
                # The cut itself, so the jump is measured across it rather than
                # across whatever falls at the window's midpoint.
                "boundaryFrame": 30,
                "channels": "mix",
            }
        ),
    ]

    results = acquire_temporal_evidence(project, tmp_project_dir, requests).results
    outgoing, incoming, cut, audio = results

    assert outgoing.kind == "frame"
    assert outgoing.sample.luma == pytest.approx(RED_LUMA, abs=CHANNEL_TOLERANCE)
    assert incoming.kind == "frame"
    assert incoming.sample.luma == pytest.approx(BLUE_LUMA, abs=CHANNEL_TOLERANCE)
    assert cut.kind == "comparison"
    # A real cut, not a dissolve or a duplicated frame.
    assert cut.difference > 0.2
    assert audio.kind == "audio"
    assert audio.samples[0].peak_dbfs <= 0
    assert audio.samples[0].boundary_jump_db == pytest.approx(0, abs=1.0)


@pytest.mark.usefixtures("require_ffprobe")
def test_motion_objective_trajectory_is_smooth_and_covers_the_canvas(
    tmp_project_dir: Path, media_factory: MediaFactory
) -> None:
    """Motion controller objective: a scale ramp advances smoothly and never reveals the canvas.

    Scaling up can only ever cover more of the frame, so any black sample in the rendered window
    would mean the transform left the canvas exposed.
    """
    _stage(media_factory("hero.mp4", seconds=1.0, color="red"), tmp_project_dir, "hero.mp4")
    project = _project(
        assets=[{"id": "hero", "path": "hero.mp4", "kind": "video"}],
        tracks=[
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    _clip(
                        "shot",
                        "hero",
                        "v1",
                        0.0,
                        1.0,
                        keyframes=[
                            {"id": "s0", "time": 0.0, "property": "scale", "value": 1.0},
                            {"id": "s1", "time": 1.0, "property": "scale", "value": 1.4},
                        ],
                    )
                ],
            }
        ],
    )
    requests: list[TemporalEvidenceRequest] = [
        MotionEvidenceRequest.model_validate(
            {
                **_request("motion", "scale_ramp"),
                "startFrame": 0,
                "endFrame": 30,
                "targetId": "shot",
                "targetKind": "clip_transform",
                "property": "scale",
                "maxAccelerationPerFrame": 0.01,
            }
        ),
        RangeEvidenceRequest.model_validate(
            {
                **_request("range", "canvas_cover"),
                "startFrame": 0,
                "endFrame": 30,
                "sampleEveryFrames": 5,
                "checks": ["black_frames"],
            }
        ),
    ]

    results = acquire_temporal_evidence(project, tmp_project_dir, requests).results
    motion, canvas = results

    assert motion.kind == "motion"
    assert all(sample.value is not None for sample in motion.samples)
    ramp = [sample.value for sample in motion.samples if sample.value is not None]
    assert ramp[0] == pytest.approx(1.0)
    assert ramp[-1] > ramp[0]
    # Strictly increasing and evenly paced: a linear ramp, not a jump.
    steps = [right - left for left, right in pairwise(ramp)]
    assert all(step > 0 for step in steps)
    assert max(steps) - min(steps) < 1e-6

    assert canvas.kind == "range"
    assert canvas.samples
    assert all(sample.black_ratio < 0.5 for sample in canvas.samples)


@pytest.mark.usefixtures("require_ffprobe")
def test_color_objective_grade_moves_the_image_and_stays_in_legal_scopes(
    tmp_project_dir: Path, media_factory: MediaFactory
) -> None:
    """Color controller objective: the grade is visible in the render and stays broadcast legal.

    The same source is measured ungraded and graded. A correction that no renderer applied would
    show identical statistics, and one that clipped would leave the legal range.
    """
    _stage(media_factory("shot.mp4", seconds=1.0, color="gray"), tmp_project_dir, "shot.mp4")
    assets = [{"id": "shot", "path": "shot.mp4", "kind": "video"}]

    def scope_request(request_id: str) -> ScopeEvidenceRequest:
        return ScopeEvidenceRequest.model_validate(
            {
                **_request("scope", request_id),
                "startFrame": 0,
                "endFrame": 3,
                "channels": ["luma"],
                "legalMin": 0.0,
                "legalMax": 1.0,
            }
        )

    def measure(clip_extra: dict[str, Any], request_id: str) -> float:
        project = _project(
            assets=assets,
            tracks=[
                {
                    "id": "v1",
                    "type": "video",
                    "clips": [_clip("shot", "shot", "v1", 0.0, 1.0, **clip_extra)],
                }
            ],
        )
        result = acquire_temporal_evidence(
            project, tmp_project_dir, [scope_request(request_id)]
        ).results[0]
        assert result.kind == "scope"
        for sample in result.samples:
            # Legal scopes are part of the objective, not a separate concern.
            assert 0.0 <= sample.min <= 1.0
            assert 0.0 <= sample.max <= 1.0
        means = [sample.mean for sample in result.samples if sample.mean is not None]
        assert means
        return sum(means) / len(means)

    ungraded = measure({}, "ungraded")
    graded = measure(
        {
            "effects": [
                {
                    "id": "color__shot__primary",
                    "type": "color_grade",
                    "params": {"exposure": 0.5},
                }
            ]
        },
        "graded",
    )

    # Positive exposure must actually lift the image through the real render path.
    assert graded > ungraded + 0.02


@pytest.mark.usefixtures("require_ffprobe")
def test_tracking_objective_region_stays_inside_frame_without_jitter(
    tmp_project_dir: Path, media_factory: MediaFactory
) -> None:
    """Tracking controller objective: the manual track stays in frame and moves smoothly.

    This is the check a real tracker would be judged on, and the reason automatic tracking stays
    unavailable: the region has to be measurable, bounded, and stable.
    """
    _stage(media_factory("subject.mp4", seconds=1.0, color="green"), tmp_project_dir, "subject.mp4")
    project = _project(
        assets=[{"id": "subject", "path": "subject.mp4", "kind": "video"}],
        tracks=[
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    _clip(
                        "shot",
                        "subject",
                        "v1",
                        0.0,
                        1.0,
                        effects=[
                            {
                                "id": "shot__track",
                                "type": "object_track",
                                "params": {
                                    "target": "object",
                                    "engine": "manual",
                                    "region": {
                                        "x": 0.2,
                                        "y": 0.1,
                                        "width": 0.25,
                                        "height": 0.4,
                                    },
                                },
                                "keyframes": [
                                    {"id": "tx0", "time": 0.0, "property": "x", "value": 0.2},
                                    {"id": "tx1", "time": 1.0, "property": "x", "value": 0.5},
                                    {"id": "ty0", "time": 0.0, "property": "y", "value": 0.1},
                                    {
                                        "id": "tw0",
                                        "time": 0.0,
                                        "property": "width",
                                        "value": 0.25,
                                    },
                                    {
                                        "id": "th0",
                                        "time": 0.0,
                                        "property": "height",
                                        "value": 0.4,
                                    },
                                ],
                            }
                        ],
                    )
                ],
            }
        ],
    )
    requests: list[TemporalEvidenceRequest] = [
        MotionEvidenceRequest.model_validate(
            {
                **_request("motion", "tracked_subject"),
                "startFrame": 0,
                "endFrame": 30,
                "targetId": "shot__track",
                "targetKind": "tracker",
                "property": "x",
                "maxJitterPerFrame": 0.01,
                "requireInsideFrame": True,
            }
        )
    ]

    tracked = acquire_temporal_evidence(project, tmp_project_dir, requests).results[0]

    assert tracked.kind == "motion"
    assert all(sample.bounds is not None for sample in tracked.samples)
    bounds = [sample.bounds for sample in tracked.samples if sample.bounds is not None]
    for bound in bounds:
        assert bound.x >= 0.0
        assert bound.y >= 0.0
        assert bound.x + bound.width <= 1.0
        assert bound.y + bound.height <= 1.0
    xs = [bound.x for bound in bounds]
    steps = [right - left for left, right in pairwise(xs)]
    assert all(step >= 0 for step in steps)
    assert max(steps) - min(steps) < 1e-6


@pytest.mark.usefixtures("require_ffprobe")
def test_audio_objective_mix_is_safe_and_fades_in(
    tmp_project_dir: Path, media_factory: MediaFactory
) -> None:
    """Audio controller objective: the compiled mix is peak-safe and the fade is audible.

    A gain reduction that the renderer ignored would show up as a hot peak, and a fade that was
    only written to the project file would leave the opening window as loud as the body.
    """
    _stage(
        media_factory("bed.wav", seconds=2.0, with_video=False),
        tmp_project_dir,
        "bed.wav",
    )
    # The render path needs picture to composite against; the objective is measured on the mix.
    _stage(
        media_factory("silent.mp4", seconds=2.0, color="black", with_audio=False),
        tmp_project_dir,
        "silent.mp4",
    )
    GAIN_DB = -6.0

    def measure(effects: list[dict[str, Any]], suffix: str) -> tuple[float, float]:
        """Return (head, body) peak dBFS for a mix with the given clip effects."""
        project = _project(
            assets=[
                {"id": "bed", "path": "bed.wav", "kind": "audio"},
                {"id": "picture", "path": "silent.mp4", "kind": "video"},
            ],
            tracks=[
                {
                    "id": "v1",
                    "type": "video",
                    "clips": [_clip("picture", "picture", "v1", 0.0, 2.0)],
                },
                {
                    "id": "a1",
                    "type": "audio",
                    "clips": [_clip("bed", "bed", "a1", 0.0, 2.0, effects=effects)],
                },
            ],
        )
        requests: list[TemporalEvidenceRequest] = [
            AudioEvidenceRequest.model_validate(
                {
                    **_request("audio", f"fade_head_{suffix}"),
                    "startFrame": 0,
                    "endFrame": 6,
                    "channels": "mix",
                    "maxPeakDbfs": -0.1,
                }
            ),
            AudioEvidenceRequest.model_validate(
                {
                    **_request("audio", f"body_{suffix}"),
                    "startFrame": 45,
                    "endFrame": 55,
                    "channels": "mix",
                    "maxPeakDbfs": -0.1,
                }
            ),
        ]
        head, body = acquire_temporal_evidence(project, tmp_project_dir, requests).results
        assert head.kind == "audio"
        assert body.kind == "audio"
        return head.samples[0].peak_dbfs, body.samples[0].peak_dbfs

    _, dry_body = measure([], "dry")
    mixed_head, mixed_body = measure(
        [
            {
                "id": "bed__gain",
                "type": "audio_gain",
                "params": {"gainDb": GAIN_DB, "fadeInSeconds": 1.0},
                "keyframes": [],
            }
        ],
        "mixed",
    )

    # Peak-safe, and the gain reduction actually survived into the render rather than only the
    # project file. Comparing against the dry mix keeps this independent of the source's level.
    assert mixed_body <= -0.1
    assert mixed_body == pytest.approx(dry_body + GAIN_DB, abs=1.0)
    # The fade must make the opening measurably quieter than the body.
    assert mixed_head < mixed_body - 3.0


@pytest.mark.usefixtures("require_ffprobe")
def test_audio_role_isolation_measures_only_the_labelled_track(
    tmp_project_dir: Path, media_factory: MediaFactory
) -> None:
    """Role-isolated evidence (schema v17) measures the role, not the whole mix.

    Two sound tracks play together. Asking for the music must measure the music alone, which is
    what makes "duck the music under the dialogue" checkable — and the isolated peak must be
    below the combined mix, or nothing was isolated at all.
    """
    _stage(media_factory("score.wav", seconds=2.0, with_video=False), tmp_project_dir, "score.wav")
    _stage(media_factory("vo.wav", seconds=2.0, with_video=False), tmp_project_dir, "vo.wav")
    _stage(
        media_factory("picture.mp4", seconds=2.0, color="black", with_audio=False),
        tmp_project_dir,
        "picture.mp4",
    )
    project = _project(
        assets=[
            {"id": "score", "path": "score.wav", "kind": "audio"},
            {"id": "vo", "path": "vo.wav", "kind": "audio"},
            {"id": "picture", "path": "picture.mp4", "kind": "video"},
        ],
        tracks=[
            {
                "id": "v1",
                "type": "video",
                "clips": [_clip("picture", "picture", "v1", 0.0, 2.0)],
            },
            {
                "id": "music",
                "type": "audio",
                "role": "music",
                "clips": [_clip("score", "score", "music", 0.0, 2.0)],
            },
            {
                "id": "dialogue",
                "type": "audio",
                "role": "dialogue",
                "clips": [_clip("vo", "vo", "dialogue", 0.0, 2.0)],
            },
        ],
    )

    def peak(channels: str, request_id: str) -> float:
        request = AudioEvidenceRequest.model_validate(
            {
                **_request("audio", request_id),
                "startFrame": 15,
                "endFrame": 45,
                "channels": channels,
            }
        )
        result = acquire_temporal_evidence(project, tmp_project_dir, [request]).results[0]
        assert result.kind == "audio"
        return result.samples[0].peak_dbfs

    mixed = peak("mix", "mix")
    music_only = peak("music", "music")

    # Isolating one of two simultaneous sources must be quieter than both together.
    assert music_only < mixed
    # And it must still be real audio, not a muted timeline.
    assert music_only > -120.0


@pytest.mark.usefixtures("require_ffprobe")
def test_loudness_objective_measures_the_programme_and_follows_gain(
    tmp_project_dir: Path, media_factory: MediaFactory
) -> None:
    """Audio controller objective: delivery loudness is measured, not assumed.

    Peak evidence says whether a mix is safe; loudness says whether it is as loud as it should be,
    which is the question every delivery spec actually enforces. Lowering the gain must move the
    measured programme loudness by the same amount, or the number is decorative.
    """
    _stage(media_factory("bed.wav", seconds=6.0, with_video=False), tmp_project_dir, "bed.wav")
    _stage(
        media_factory("picture.mp4", seconds=6.0, color="black", with_audio=False),
        tmp_project_dir,
        "picture.mp4",
    )

    def integrated(gain_db: float | None, request_id: str) -> float:
        effects = (
            []
            if gain_db is None
            else [
                {
                    "id": "bed__gain",
                    "type": "audio_gain",
                    "params": {"gainDb": gain_db},
                    "keyframes": [],
                }
            ]
        )
        project = _project(
            assets=[
                {"id": "bed", "path": "bed.wav", "kind": "audio"},
                {"id": "picture", "path": "picture.mp4", "kind": "video"},
            ],
            tracks=[
                {
                    "id": "v1",
                    "type": "video",
                    "clips": [_clip("picture", "picture", "v1", 0.0, 6.0)],
                },
                {
                    "id": "music",
                    "type": "audio",
                    "role": "music",
                    "clips": [_clip("bed", "bed", "music", 0.0, 6.0, effects=effects)],
                },
            ],
        )
        request = LoudnessEvidenceRequest.model_validate(
            {
                **_request("loudness", request_id),
                "startFrame": 0,
                "endFrame": 150,
                "channels": "music",
            }
        )
        result = acquire_temporal_evidence(project, tmp_project_dir, [request]).results[0]
        assert result.kind == "loudness"
        return result.sample.integrated_lufs

    dry = integrated(None, "dry")
    quieter = integrated(-6.0, "quieter")

    # A real R128 reading of real programme material, not the -70 LUFS silence floor.
    assert -70.0 < dry < 0.0
    # Six dB down must read six dB down.
    assert quieter == pytest.approx(dry - 6.0, abs=1.0)


@pytest.mark.usefixtures("require_ffprobe")
def test_long_audio_windows_are_measured_not_silently_dropped(
    tmp_project_dir: Path, media_factory: MediaFactory
) -> None:
    """Regression: a long window used to measure as digital silence.

    MoviePy returns silence rather than samples when handed a very large time array, so windows
    past roughly a second read as -120 dBFS with no error. That is the worst possible failure for
    a reviewer: "the mix is silent" is a confident, wrong answer that no exception announces.
    """
    _stage(media_factory("tone.wav", seconds=6.0, with_video=False), tmp_project_dir, "tone.wav")
    _stage(
        media_factory("pic.mp4", seconds=6.0, color="black", with_audio=False),
        tmp_project_dir,
        "pic.mp4",
    )
    project = _project(
        assets=[
            {"id": "tone", "path": "tone.wav", "kind": "audio"},
            {"id": "pic", "path": "pic.mp4", "kind": "video"},
        ],
        tracks=[
            {"id": "v1", "type": "video", "clips": [_clip("pic", "pic", "v1", 0.0, 6.0)]},
            {"id": "a1", "type": "audio", "clips": [_clip("tone", "tone", "a1", 0.0, 6.0)]},
        ],
    )

    def peak(start_frame: int, end_frame: int, request_id: str) -> float:
        request = AudioEvidenceRequest.model_validate(
            {
                **_request("audio", request_id),
                "startFrame": start_frame,
                "endFrame": end_frame,
                "channels": "mix",
            }
        )
        result = acquire_temporal_evidence(project, tmp_project_dir, [request]).results[0]
        assert result.kind == "audio"
        return result.samples[0].peak_dbfs

    short_window = peak(0, 15, "short")
    # 150 frames is well inside MAX_WINDOW_FRAMES, so this is a window callers can really ask for.
    long_window = peak(0, 150, "long")

    assert short_window > -120.0
    assert long_window == pytest.approx(short_window, abs=0.5)


def _two_shot_camera(
    ffmpeg_bin: str,
    media_factory: MediaFactory,
    work_dir: Path,
    *,
    first: str,
    second: str,
    each_seconds: float,
) -> Path:
    """A single recording whose picture changes colour partway through.

    This is what makes the multicam objective measurable: the camera's own content encodes
    WHEN you are in its recording, so a switch that lands on the wrong source timestamp shows
    a visibly different colour instead of a subtly wrong frame nobody can assert on.
    """
    head = media_factory("_angle_head.mp4", seconds=each_seconds, color=first, with_audio=False)
    tail = media_factory("_angle_tail.mp4", seconds=each_seconds, color=second, with_audio=False)
    listing = work_dir / "_angle_concat.txt"
    listing.write_text(f"file '{head}'\nfile '{tail}'\n", encoding="utf-8")
    out = work_dir / "_angle_camera.mp4"
    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listing),
            "-c",
            "copy",
            str(out),
        ],
        check=True,
        capture_output=True,
    )
    return out


@pytest.mark.usefixtures("require_ffprobe")
def test_multicam_objective_switch_lands_on_the_same_instant_not_the_same_timestamp(
    tmp_project_dir: Path, tmp_path: Path, media_factory: MediaFactory, ffmpeg_bin: str
) -> None:
    """Timeline controller objective (multicam): a camera switch cuts to the same MOMENT.

    Camera A is one continuous red shot. Camera B started rolling 2s earlier in its own
    timebase and turns from green to blue at exactly that 2s mark — so group time zero is
    the instant camera B goes blue.

    The switch happens 1s into the sequence. Landing on the same instant means source 3.0s
    of camera B, which is BLUE. Ignoring the sync offset would use source 1.0s, which is
    GREEN. Both are perfectly valid-looking frames; only the colour tells them apart, which
    is exactly why this is measured from real decoded pixels rather than asserted on a patch.
    """
    _stage(
        media_factory("cam_a.mp4", seconds=2.0, color="red", with_audio=False),
        tmp_project_dir,
        "cam_a.mp4",
    )
    _stage(
        _two_shot_camera(
            ffmpeg_bin, media_factory, tmp_path, first="lime", second="blue", each_seconds=2.0
        ),
        tmp_project_dir,
        "cam_b.mp4",
    )
    assets = [
        {"id": "cam_a", "path": "cam_a.mp4", "kind": "video"},
        {"id": "cam_b", "path": "cam_b.mp4", "kind": "video"},
    ]
    # The authored group the switch compiles against. The engine never reads it — it is
    # recorded here because it is what makes the source numbers below correct rather than
    # arbitrary: group_time = source - offset, so 1.0s of group time is 3.0s of camera B.
    angle_groups = [
        {
            "id": "grp",
            "angles": [
                {"id": "wide", "assetId": "cam_a", "syncOffsetSeconds": 0.0},
                {"id": "tight", "assetId": "cam_b", "syncOffsetSeconds": 2.0},
            ],
        }
    ]

    def switched(source_start: float) -> Project:
        return Project.model_validate(
            {
                "id": "professional_objective",
                "name": "Multicam objective fixture",
                "fps": FPS,
                "resolution": {"width": WIDTH, "height": HEIGHT},
                "assets": assets,
                "angleGroups": angle_groups,
                "timeline": {
                    "revision": REVISION,
                    "tracks": [
                        {
                            "id": "v1",
                            "type": "video",
                            "clips": [
                                _clip("shot", "cam_a", "v1", 0.0, 1.0),
                                {
                                    **_clip("shot__right", "cam_b", "v1", 1.0, 2.0),
                                    "sourceStart": source_start,
                                    "sourceEnd": source_start + 1.0,
                                },
                            ],
                        }
                    ],
                },
            }
        )

    def luma_across_switch(project: Project) -> tuple[float, float]:
        requests: list[TemporalEvidenceRequest] = [
            FrameEvidenceRequest.model_validate(
                {**_request("frame", "last_outgoing"), "atFrame": 29, "metrics": ["luma"]}
            ),
            FrameEvidenceRequest.model_validate(
                {**_request("frame", "first_incoming"), "atFrame": 30, "metrics": ["luma"]}
            ),
        ]
        outgoing, incoming = acquire_temporal_evidence(project, tmp_project_dir, requests).results
        assert outgoing.kind == "frame"
        assert incoming.kind == "frame"
        assert outgoing.sample.luma is not None
        assert incoming.sample.luma is not None
        return outgoing.sample.luma, incoming.sample.luma

    outgoing_luma, incoming_luma = luma_across_switch(switched(3.0))

    # Frame 29 is still camera A; frame 30 is camera B at the matching instant.
    assert outgoing_luma == pytest.approx(RED_LUMA, abs=CHANNEL_TOLERANCE)
    assert incoming_luma == pytest.approx(BLUE_LUMA, abs=CHANNEL_TOLERANCE)

    # The fixture can tell the two apart: dropping the sync offset shows the wrong moment,
    # so a passing switch above is evidence of the mapping and not of a loose tolerance.
    _, unsynced_luma = luma_across_switch(switched(1.0))
    assert unsynced_luma == pytest.approx(GREEN_LUMA, abs=CHANNEL_TOLERANCE)
    assert abs(unsynced_luma - incoming_luma) > 0.4


def _skin_warmth(red: float, blue: float) -> float:
    """A skin tone's red-to-blue ratio — how warm it reads."""
    return red / max(blue, 1e-6)


@pytest.mark.usefixtures("require_ffprobe")
def test_color_objective_skin_preservation_restrains_the_push_that_moves_skin(
    tmp_project_dir: Path, media_factory: MediaFactory
) -> None:
    """Color controller objective: holding skin restrains the move that actually moves it.

    This fixture chose the constraint. The first version measured skin *hue* and
    failed: a large temperature push rotates this renderer's skin hue by about a
    degree, because warming a red-dominant tone mostly changes how far it sits
    from grey rather than which way. What it does move — by more than half — is
    the red:blue ratio, which is exactly what a viewer reads as a sunburnt face.
    So the controller's tolerance is on warmth, and this measures three renders of
    the same skin-coloured shot to prove it guards something real:

    1. ungraded — the reading the tolerance is relative to;
    2. a large temperature push — must break the tolerance, or the clamp guards
       nothing and this test proves nothing;
    3. the largest push the controller's own arithmetic calls admissible — must
       land inside it, in the render rather than on paper.
    """
    _stage(media_factory("skin.mp4", seconds=0.2, color="0xC48E76"), tmp_project_dir, "skin.mp4")
    assets = [{"id": "skin", "path": "skin.mp4", "kind": "video"}]
    white_balance_gain = 0.3  # mirrors render/color.py `_TEMP_GAIN`
    tolerance = 0.08  # mirrors the TS controller's SKIN_WARMTH_TOLERANCE

    def skin_medians(temperature: float, request_id: str) -> tuple[float, float, float]:
        effects = (
            []
            if temperature == 0.0
            else [
                {
                    "id": "color__shot__primary",
                    "type": "color_grade",
                    "params": {"temperature": temperature},
                }
            ]
        )
        project = _project(
            assets=assets,
            tracks=[
                {
                    "id": "v1",
                    "type": "video",
                    "clips": [_clip("shot", "skin", "v1", 0.0, 0.2, effects=effects)],
                }
            ],
        )
        request = ScopeEvidenceRequest.model_validate(
            {
                **_request("scope", request_id),
                "startFrame": 0,
                "endFrame": 2,
                "channels": ["skin_red", "skin_blue"],
                "legalMin": 0.0,
                "legalMax": 1.0,
            }
        )
        result = acquire_temporal_evidence(project, tmp_project_dir, [request]).results[0]
        assert result.kind == "scope"
        by_channel = {
            sample.channel: sample
            for sample in result.samples
            if isinstance(sample, ScopeSample) and sample.frame == 0
        }
        coverage = by_channel["skin_red"].coverage_ratio
        assert coverage is not None
        return (
            by_channel["skin_red"].p50 or 0.0,
            by_channel["skin_blue"].p50 or 0.0,
            coverage,
        )

    red, blue, coverage = skin_medians(0.0, "skin_ungraded")
    # The qualifier must actually find this frame's skin, or every later reading is vacuous.
    assert coverage > 0.9
    base_warmth = _skin_warmth(red, blue)

    pushed_red, pushed_blue, _ = skin_medians(0.8, "skin_pushed")
    pushed_drift = abs(_skin_warmth(pushed_red, pushed_blue) / base_warmth - 1.0)
    assert pushed_drift > tolerance

    # The largest push the controller's arithmetic calls admissible, found the same way.
    admissible = 0.0
    step = 0.005
    while admissible + step <= 1.0:
        candidate = admissible + step
        predicted = (1 + white_balance_gain * candidate) / (1 - white_balance_gain * candidate) - 1
        if abs(predicted) > tolerance:
            break
        admissible = candidate
    assert admissible > 0.0, "the tolerance must permit some correction, or it is a ban"

    held_red, held_blue, _ = skin_medians(admissible, "skin_held")
    rendered_drift = abs(_skin_warmth(held_red, held_blue) / base_warmth - 1.0)
    # 8-bit yuv420p round-tripping moves a median by a code value or two, which is a
    # fraction of a percent here; one point of slack keeps that from reading as failure.
    assert rendered_drift <= tolerance + 0.01
