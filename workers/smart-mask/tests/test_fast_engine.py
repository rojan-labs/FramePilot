"""Plan 13: the Fast engine — request field, whole-job progress, the pipeline path, its stages.

The native Vision helper is macOS-only, so the pipeline tests script the estimator; what they
hold is everything around it: host-verifiable output, windows, resume, progress, refusal.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")
pytest.importorskip("PIL")

from fakes import truth  # noqa: E402
from pipeline_harness import (  # noqa: E402
    host_verify,
    make_clip,
    request_for,
    run_job,
    square_frames,
)

from framepilot_smart_mask import pipeline, vision  # noqa: E402
from framepilot_smart_mask.foreground import fast_foreground_frame  # noqa: E402
from framepilot_smart_mask.pipeline import ENGINE_VISION, PipelineConfig  # noqa: E402
from framepilot_smart_mask.protocol import (  # noqa: E402
    ProtocolError,
    parse_input_line,
    progress_message,
)
from framepilot_smart_mask.services import config_for  # noqa: E402
from framepilot_smart_mask.stabilise import still_stabilise  # noqa: E402
from framepilot_smart_mask.vision import BackgroundTwins, Estimate, faint_islands  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
BOX = {"x": 10 / 160, "y": 30 / 90, "width": 24 / 160, "height": 24 / 90}
COUNT = 30
FAST = PipelineConfig(engine=ENGINE_VISION, window_frames=16, window_overlap=6)


class RedEstimator:
    """Stands in for the Vision helper: the subject is whatever is red."""

    opened = 0

    def __init__(self, width: int, height: int, helper: Path | None = None) -> None:
        type(self).opened += 1

    def __enter__(self) -> RedEstimator:
        return self

    def __exit__(self, *_exc: Any) -> None:
        pass

    def reset(self) -> None:
        pass

    def estimate(self, rgb: Any, seed: Any = None) -> Estimate:
        red = rgb[..., 0].astype(np.int16) - rgb[..., 1].astype(np.int16)
        alpha = np.where(red > 100, 255, 0).astype(np.uint8)
        return Estimate(alpha, np.zeros(vision.small_mask(alpha).shape, bool), bool(alpha.any()))


@pytest.fixture
def scripted(monkeypatch: pytest.MonkeyPatch) -> type[RedEstimator]:
    RedEstimator.opened = 0
    monkeypatch.setattr(pipeline, "VisionEstimator", RedEstimator)
    return RedEstimator


def staging_dir(tmp_path: Path, name: str = "staging") -> Path:
    directory = tmp_path / name
    directory.mkdir()
    (directory / "inputs").mkdir()
    return directory


# --- protocol ----------------------------------------------------------------------------------


def _request(quality: Any) -> str:
    parameters: dict[str, Any] = {
        "output": {"handleId": "o", "absolutePath": "/tmp/o", "allowedFiles": ["matte.mkv", "frames.json"], "maxBytes": 10**6},
        "prompts": [{"kind": "box", "pts": 0, "box": BOX}],
        "previewHeight": 180,
    }  # fmt: skip
    if quality is not None:
        parameters["quality"] = quality
    return json.dumps({
        "type": "request", "protocolVersion": 1, "requestId": "r", "projectRevision": 1,
        "media": {"handleId": "m", "assetId": "a", "absolutePath": "/tmp/c.mkv", "sourceStartSeconds": 0.0,
                  "sourceEndSeconds": 1.0, "fps": 24.0, "firstFrame": 0, "lastFrameExclusive": 4},
        "capability": "subject.matte", "parameters": parameters,
    })  # fmt: skip


def test_quality_is_optional_and_limited_to_fast_or_best() -> None:
    assert parse_input_line(_request(None)).quality is None  # type: ignore[union-attr]
    assert parse_input_line(_request("fast")).quality == "fast"  # type: ignore[union-attr]
    with pytest.raises(ProtocolError):
        parse_input_line(_request("turbo"))


def test_overall_progress_is_additive_and_bounded() -> None:
    assert "overallTotal" not in progress_message("r", "segment", 1, 2)
    message = progress_message("r", "segment", 1, 2, overall=(900, 300))
    assert (message["overallCompleted"], message["overallTotal"]) == (300, 300)


def test_fast_selects_the_vision_engine_and_anything_else_keeps_the_models() -> None:
    base = PipelineConfig()
    assert config_for(base, None) is base and config_for(base, "best") is base
    fast = config_for(base, "fast")
    assert fast.engine == ENGINE_VISION
    assert (fast.window_frames, fast.window_overlap) == (
        pipeline.FAST_WINDOW_FRAMES,
        pipeline.FAST_WINDOW_OVERLAP,
    )


def test_the_helper_is_never_offered_off_macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vision.sys, "platform", "linux")
    assert vision.helper_path() is None
    with pytest.raises(ProtocolError) as refused:
        vision.VisionEstimator(16, 16)
    # A typed refusal, never a silent fall back to a job that takes hours.
    assert refused.value.code == "hardware_unsupported"


# --- pipeline ----------------------------------------------------------------------------------


@needs_ffmpeg
def test_a_fast_job_is_host_verifiable_and_reports_whole_job_progress(
    tmp_path: Path, scripted: type[RedEstimator]
) -> None:
    clip = tmp_path / "clip.mkv"
    make_clip(clip, square_frames(COUNT))
    staging = staging_dir(tmp_path)
    events: list = []
    request = request_for(
        clip, staging, COUNT, [{"kind": "box", "pts": 0, "box": BOX}], quality="fast"
    )
    outcome = run_job(request, config=FAST, progress=events)
    matte = host_verify(staging, outcome, clip, 0, COUNT)
    expected = truth(COUNT)
    for index in range(COUNT):
        assert np.array_equal(matte[index] >= 128, expected[index])
    assert outcome.summary.self_correction_rounds == 0
    # No model was opened: the Fast engine never touches SAM or the matting model.
    phases = {event[0] for event in events}
    assert "detect" in phases and not phases & {"refine", "consensus", "self_correct", "matte"}
    overall = [event[3] for event in events if len(event) == 4]
    assert len(overall) == len(events)
    assert all(total == COUNT for _done, total in overall)
    done = [completed for completed, _total in overall]
    assert done == sorted(done) and done[-1] == COUNT


@needs_ffmpeg
def test_a_host_that_did_not_ask_gets_no_overall_fields(
    tmp_path: Path, scripted: type[RedEstimator]
) -> None:
    clip = tmp_path / "clip.mkv"
    make_clip(clip, square_frames(8))
    events: list = []
    request = request_for(clip, staging_dir(tmp_path), 8, [{"kind": "box", "pts": 0, "box": BOX}])
    run_job(request, config=FAST, progress=events)
    assert all(len(event) == 3 for event in events)


@needs_ffmpeg
def test_a_resumed_fast_job_skips_finished_windows_and_the_survey(
    tmp_path: Path, scripted: type[RedEstimator]
) -> None:
    clip = tmp_path / "clip.mkv"
    make_clip(clip, square_frames(COUNT))
    staging = staging_dir(tmp_path)
    request = request_for(
        clip, staging, COUNT, [{"kind": "box", "pts": 0, "box": BOX}], quality="fast"
    )
    real_window = pipeline.MatteJob._window_fast
    calls = {"windows": 0}

    def crash_on_second(self: Any, ctx: Any, window: Any) -> None:
        calls["windows"] += 1
        if calls["windows"] == 2:
            raise RuntimeError("power cut")
        real_window(self, ctx, window)

    pipeline.MatteJob._window_fast = crash_on_second  # type: ignore[method-assign]
    try:
        with pytest.raises(RuntimeError):
            run_job(request, config=FAST)
    finally:
        pipeline.MatteJob._window_fast = real_window  # type: ignore[method-assign]
    opened_before = scripted.opened
    events: list = []
    outcome = run_job(request, config=FAST, progress=events)
    host_verify(staging, outcome, clip, 0, COUNT)
    assert ("encode", 1, 1) not in events  # sanity: events carry overall here
    assert any(event[0] == "encode" and event[1] == event[2] for event in events)
    # One estimator per remaining window; the survey was read back, not repeated.
    assert "detect" not in {event[0] for event in events}
    assert scripted.opened - opened_before == 2


@needs_ffmpeg
def test_fast_and_best_never_share_a_checkpoint(tmp_path: Path) -> None:
    from framepilot_smart_mask.media import FfmpegTools, verify_tools

    clip = tmp_path / "clip.mkv"
    make_clip(clip, square_frames(8))
    request = request_for(clip, staging_dir(tmp_path), 8, [{"kind": "box", "pts": 0, "box": BOX}])
    ffmpeg, ffprobe, report = verify_tools({"FRAMEPILOT_SMART_MASK_ALLOW_UNAPPROVED_FFMPEG": "1"})
    info = FfmpegTools(ffmpeg, ffprobe, report).probe(str(clip))
    best = replace(FAST, engine=pipeline.ENGINE_MODELS)
    assert pipeline.fingerprint(request, info, FAST, {}) != pipeline.fingerprint(
        request, info, best, {}
    )


# --- stages ------------------------------------------------------------------------------------


def _lamp_scene(frames: int = 60) -> tuple[list[Any], list[Any]]:
    """A static bright lamp Vision takes in a third of frames; a dark mic sweeping a dark wall."""
    solids, colours = [], []
    for index in range(frames):
        colour = np.full((270, 480, 3), 30, np.uint8)
        colour[200:260, 40:110] = (250, 240, 200)
        solid = np.zeros((270, 480), bool)
        solid[60:270, 200:380] = True  # the presenter, always
        colour[60:270, 200:380] = (200, 180, 160)
        x = 120 + (index * 3) % 60
        solid[120:160, x : x + 50] = True  # the microphone, moving, dark on dark
        colour[120:160, x : x + 50] = (34, 34, 34)
        if index % 3 == 0:
            solid[200:260, 40:110] = True
        solids.append(solid)
        colours.append(colour)
    return solids, colours


def test_a_fused_background_object_is_found_and_a_held_object_is_not() -> None:
    solids, colours = _lamp_scene()
    evidence = BackgroundTwins(270, 480)
    for solid, colour in zip(solids, colours, strict=True):
        evidence.add(solid, colour)
    model = evidence.model()
    assert model.region[205:255, 45:105].all()  # the lamp
    assert not model.region[120:160, 120:230].any()  # where the microphone sweeps
    assert not model.region[60:270, 200:380].any()  # the presenter

    person = np.zeros((270, 480), bool)
    gate = model.gate(solids[0], person, colours[0])
    assert gate is not None and not gate[205:255, 45:105].any() and gate[120:160, 120:170].all()
    # A dark object passing in front of the lamp is a different colour: it stays.
    covered = colours[0].copy()
    covered[210:250, 50:100] = (20, 20, 20)
    gate = model.gate(solids[0], person, covered)
    assert gate is not None and gate[210:250, 50:100].all()
    # A frame Vision got right is left alone.
    assert model.gate(solids[1], person, colours[1]) is None
    # Vision's PERSON matte leaks onto the lamp too: lamp-coloured "person" pixels still go,
    # while a hand (another colour) in front of the lamp is kept.
    leaked = np.zeros((270, 480), bool)
    leaked[200:260, 40:110] = True
    hand = colours[0].copy()
    hand[225:245, 60:90] = (190, 140, 110)
    gate = model.gate(solids[0], leaked, hand)
    assert gate is not None and not gate[205:220, 45:105].any() and gate[225:245, 60:90].all()


def test_too_little_evidence_gates_nothing() -> None:
    solids, colours = _lamp_scene(vision.TWIN_MIN_FRAMES - 1)
    evidence = BackgroundTwins(270, 480)
    for solid, colour in zip(solids, colours, strict=True):
        evidence.add(solid, colour)
    assert evidence.model().empty


def test_a_faint_island_goes_and_the_subjects_soft_edge_stays() -> None:
    alpha = np.zeros((270, 480), np.uint8)
    alpha[60:200, 200:320] = 255
    alpha[58:60, 200:320] = 60  # the subject's own soft edge touches its solid core
    alpha[220:250, 30:90] = 40  # the outline a removed lamp leaves behind
    faint = faint_islands(alpha)
    assert faint[220:250, 30:90].all() and not faint[58:200, 200:320].any()


def test_still_edges_are_smoothed_and_changed_pixels_are_left_alone() -> None:
    frames = [np.full((40, 40, 3), 120, np.uint8) for _ in range(5)]
    alphas = [np.full((40, 40), 200, np.uint8) for _ in range(5)]
    alphas[2][10:20, 10:20] = 100  # shimmer on a still picture
    frames[2][25:35, 25:35] = 250  # the picture changed here ...
    alphas[2][25:35, 25:35] = 100  # ... so this difference is real
    band = [np.ones((40, 40), bool)] * 5
    fixed = [np.zeros((40, 40), bool)] * 5
    smoothed, changed = still_stabilise(alphas, band, fixed, lambda index: frames[index])
    assert smoothed[2][15, 15] > 150 and changed[2] > 0
    assert smoothed[2][30, 30] == 100
    only = still_stabilise(alphas, band, fixed, lambda index: frames[index], indices=range(2, 3))
    assert len(only[0]) == 1 and np.array_equal(only[0][0], smoothed[2])


def test_fast_foreground_removes_background_spill_from_the_soft_edge() -> None:
    frame = np.zeros((120, 200, 3), np.uint8)
    frame[:, :100] = (200, 40, 40)  # subject
    frame[:, 100:] = (20, 200, 20)  # background
    alpha = np.zeros((120, 200), np.uint8)
    alpha[:, :96] = 255
    for offset in range(8):  # a soft edge that straddles the colour boundary
        alpha[:, 96 + offset] = 255 - 30 * (offset + 1)
        frame[:, 96 + offset] = (110, 120, 30)
    out = fast_foreground_frame(frame, alpha)
    assert out[:, :96].max() == 0 and out[:, 110:].max() == 0  # only fractional pixels
    edge = out[60, 100].astype(int)
    assert edge[0] > edge[1]  # pulled toward the subject's red, away from the green spill
