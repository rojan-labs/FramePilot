"""Contract and acquisition tests for revision-bound temporal evidence."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

import numpy as np
import pytest
from pydantic import TypeAdapter, ValidationError

from framepilot_engine.timeline.models import Project
from framepilot_engine.validation import temporal_evidence as evidence_module
from framepilot_engine.validation.temporal_evidence import (
    AudioEvidenceRequest,
    ComparisonEvidenceRequest,
    FrameEvidenceRequest,
    FrameEvidenceResult,
    FrameSample,
    MotionEvidenceRequest,
    RangeEvidenceRequest,
    ScopeEvidenceRequest,
    ScopeSample,
    TemporalEvidenceBatch,
    TemporalEvidenceError,
    TemporalEvidenceRequest,
    TemporalRenderSettings,
    acquire_temporal_evidence,
)


def _project(*, revision: int = 4) -> Project:
    return Project.model_validate(
        {
            "id": "project",
            "name": "Evidence fixture",
            "fps": 30,
            "resolution": {"width": 4, "height": 4},
            "timeline": {
                "revision": revision,
                "tracks": [
                    {
                        "id": "video",
                        "type": "video",
                        "clips": [
                            {
                                "id": "clip",
                                "assetId": "asset",
                                "trackId": "video",
                                "start": 0,
                                "end": 2,
                                "sourceStart": 0,
                                "sourceEnd": 2,
                                "keyframes": [
                                    {
                                        "id": "scale-0",
                                        "time": 0,
                                        "property": "scale",
                                        "value": 1,
                                    },
                                    {
                                        "id": "scale-1",
                                        "time": 1,
                                        "property": "scale",
                                        "value": 2,
                                    },
                                ],
                                "effects": [
                                    {
                                        "id": "mask",
                                        "type": "mask",
                                        "keyframes": [
                                            {
                                                "id": f"{prop}-0",
                                                "time": 0,
                                                "property": prop,
                                                "value": value,
                                            }
                                            for prop, value in {
                                                "x": 0.1,
                                                "y": 0.2,
                                                "width": 0.3,
                                                "height": 0.4,
                                            }.items()
                                        ],
                                    }
                                ],
                            }
                        ],
                    }
                ],
            },
        }
    )


def _base(kind: str, request_id: str) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "requestId": request_id,
        "projectRevision": 4,
        "reason": f"test {kind}",
        "kind": kind,
    }


class _AudioLike(Protocol):
    def get_frame(self, times: np.ndarray[Any, np.dtype[np.float64]]) -> object: ...


class _FakeAudio:
    def get_frame(self, times: np.ndarray[Any, np.dtype[np.float64]]) -> object:
        # Equal energy either side of the boundary, safely below full scale.
        return np.full((len(times), 2), 0.25, dtype=np.float64)


class _FakeComposition:
    def __init__(self) -> None:
        self.audio: _AudioLike = _FakeAudio()
        self.closed = False
        self.frame_calls: list[float] = []

    def get_frame(self, time: float) -> object:
        self.frame_calls.append(time)
        frame = round(time * 30)
        value = 0 if frame == 0 else 255 if frame == 2 else 64
        return np.full((4, 4, 3), value, dtype=np.uint8)

    def close(self) -> None:
        self.closed = True


def test_acquires_pixels_scopes_comparison_and_audio_from_one_compilation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    compositions: list[_FakeComposition] = []
    compile_calls = 0

    def fake_compile(*_args: object, **_kwargs: object) -> _FakeComposition:
        nonlocal compile_calls
        compile_calls += 1
        # A separate composition per compile, exactly like the real compiler: the
        # ordinary (review-res, captions-on) and scope (full-res, captions-off)
        # composition keys differ, so each gets its own cache entry and readers.
        composition = _FakeComposition()
        compositions.append(composition)
        return composition

    monkeypatch.setattr(evidence_module, "compile_timeline", fake_compile)
    monkeypatch.setattr(evidence_module, "index_assets", lambda *_args, **_kwargs: {})
    requests: list[TemporalEvidenceRequest] = [
        FrameEvidenceRequest.model_validate(
            {**_base("frame", "frame"), "atFrame": 0, "metrics": ["luma"]}
        ),
        RangeEvidenceRequest.model_validate(
            {
                **_base("range", "range"),
                "startFrame": 0,
                "endFrame": 3,
                "sampleEveryFrames": 1,
                "checks": ["black_frames", "flash_frames"],
            }
        ),
        ComparisonEvidenceRequest.model_validate(
            {
                **_base("comparison", "comparison"),
                "leftFrame": 1,
                "rightFrame": 2,
                "check": "shot_match",
                "maxDifference": 1,
            }
        ),
        ScopeEvidenceRequest.model_validate(
            {
                **_base("scope", "scope"),
                "startFrame": 0,
                "endFrame": 3,
                "channels": ["luma", "red", "saturation"],
                "legalMin": 0,
                "legalMax": 1,
            }
        ),
        AudioEvidenceRequest.model_validate(
            {
                **_base("audio", "audio"),
                "startFrame": 0,
                "endFrame": 3,
                "boundaryFrame": 1,
                "channels": "mix",
            }
        ),
    ]

    batch = acquire_temporal_evidence(_project(), tmp_path, requests)
    results = batch.results

    # Two compiles, not one: scope evidence needs true, unscaled pixels to measure
    # legal range/color accurately, so it compiles at full project resolution with
    # captions off, separately from the review-resolution, captions-on composition
    # the frame/range/comparison checks share.
    assert compile_calls == 2
    assert batch.render_settings.identity == "temporal-evidence:4x4@30:captions=true"
    # Both programme compositions are borrowed from the cache, so they are
    # deliberately still open here — closing them would tear down readers the
    # cache owns and another borrower may be waiting on. The leak contract it
    # used to assert (commit d0c3603) is unchanged in substance, just moved:
    # the cache closes on eviction, and holds at most MAX_CACHED_COMPOSITIONS
    # at a time.
    assert all(composition.closed is False for composition in compositions)
    evidence_module.COMPOSITION_CACHE.clear()
    assert all(composition.closed is True for composition in compositions)
    # Frame cache de-duplicates overlap among frame/range/comparison requests, on
    # the ordinary (first-compiled) composition they share.
    ordinary = compositions[0]
    assert sorted(round(time * 30) for time in ordinary.frame_calls) == [0, 1, 2]
    frame = results[0]
    assert frame.kind == "frame"
    assert frame.sample.black_ratio == 1
    comparison = results[2]
    assert comparison.kind == "comparison"
    assert comparison.difference == pytest.approx(191 / 255)
    scope = results[3]
    assert scope.kind == "scope"
    assert len(scope.samples) == 9
    luma = next(
        sample for sample in scope.samples if sample.channel == "luma" and sample.frame == 1
    )
    assert luma.mean == pytest.approx(64 / 255)
    assert luma.p10 == pytest.approx(64 / 255)
    assert luma.p50 == pytest.approx(64 / 255)
    assert luma.p90 == pytest.approx(64 / 255)
    assert luma.near_black_ratio == 0
    assert luma.near_white_ratio == 0
    audio = results[4]
    assert audio.kind == "audio"
    assert audio.samples[0].peak_dbfs == pytest.approx(-12.0412, rel=1e-3)
    assert audio.samples[0].boundary_jump_db == pytest.approx(0)


def test_motion_evidence_reads_stored_keyframes_without_compiling(tmp_path: Path) -> None:
    requests: list[TemporalEvidenceRequest] = [
        MotionEvidenceRequest.model_validate(
            {
                **_base("motion", "scale"),
                "startFrame": 0,
                "endFrame": 3,
                "targetId": "clip",
                "targetKind": "clip_transform",
                "property": "scale",
                "maxAccelerationPerFrame": 1,
            }
        ),
        MotionEvidenceRequest.model_validate(
            {
                **_base("motion", "mask"),
                "startFrame": 0,
                "endFrame": 3,
                "targetId": "mask",
                "targetKind": "mask",
                "property": "x",
                "maxJitterPerFrame": 1,
                "requireInsideFrame": True,
            }
        ),
    ]

    results = acquire_temporal_evidence(_project(), tmp_path, requests).results

    scale = results[0]
    assert scale.kind == "motion"
    assert [sample.value for sample in scale.samples] == pytest.approx([1, 1 + 1 / 30, 1 + 2 / 30])
    mask = results[1]
    assert mask.kind == "motion"
    assert mask.samples[0].point is not None
    assert mask.samples[0].bounds is not None


def test_rejects_stale_unbounded_and_out_of_timeline_requests(tmp_path: Path) -> None:
    stale = FrameEvidenceRequest.model_validate(
        {**_base("frame", "stale"), "projectRevision": 3, "atFrame": 0, "metrics": ["luma"]}
    )
    with pytest.raises(TemporalEvidenceError, match="does not match"):
        acquire_temporal_evidence(_project(), tmp_path, [stale])

    with pytest.raises(ValidationError, match="at most 300 frames"):
        RangeEvidenceRequest.model_validate(
            {
                **_base("range", "wide"),
                "startFrame": 0,
                "endFrame": 301,
                "sampleEveryFrames": 1,
                "checks": ["black_frames"],
            }
        )

    beyond = FrameEvidenceRequest.model_validate(
        {**_base("frame", "beyond"), "atFrame": 60, "metrics": ["luma"]}
    )
    with pytest.raises(TemporalEvidenceError, match="timeline ends"):
        acquire_temporal_evidence(_project(), tmp_path, [beyond])


def test_measures_the_jump_at_the_requested_splice_and_nowhere_else(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A jump is the level difference across a cut, so the cut has to be named.

    Splitting the window down the middle regardless measured whatever the programme
    happened to be doing there — a music bed's own attack at frame 0, a gain ride
    moving on purpose — and reported it as a discontinuity.
    """

    class _RisingAudio:
        """Silent for the first third of the window, loud afterwards."""

        def get_frame(
            self, times: np.ndarray[Any, np.dtype[np.float64]]
        ) -> np.ndarray[Any, np.dtype[np.float64]]:
            loud = times >= times[0] + (times[-1] - times[0]) / 3
            return np.where(loud, 0.5, 0.001)[:, np.newaxis].astype(np.float64)

    composition = _FakeComposition()
    composition.audio = _RisingAudio()
    monkeypatch.setattr(evidence_module, "compile_timeline", lambda *_args, **_kwargs: composition)
    monkeypatch.setattr(evidence_module, "index_assets", lambda *_args, **_kwargs: {})

    window = {**_base("audio", "audio"), "startFrame": 0, "endFrame": 3, "channels": "mix"}
    unclaimed = acquire_temporal_evidence(
        _project(), tmp_path, [AudioEvidenceRequest.model_validate(window)]
    ).results[0]
    assert unclaimed.kind == "audio"
    # No splice named, so nothing is claimed about continuity — and the TS reviewer
    # has nothing to fail the run on.
    assert unclaimed.samples[0].boundary_jump_db is None

    claimed = acquire_temporal_evidence(
        _project(),
        tmp_path,
        [AudioEvidenceRequest.model_validate({**window, "boundaryFrame": 1})],
    ).results[0]
    assert claimed.kind == "audio"
    jump = claimed.samples[0].boundary_jump_db
    assert jump is not None and jump > 20


def test_samples_frames_in_ascending_order(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Frames are sampled forwards, which is the batch's dominant cost.

    Seeking backwards restarts the reader; streaming forwards does not. On the
    reference sequence the same 60 frames cost 18.8s in order and 38.8s
    shuffled, so the sampling order decides whether a batch fits its timeout.

    Frames 5 and 33 are chosen because they are the case the old code got wrong:
    it iterated the request set directly, and ``list({5, 33})`` is ``[33, 5]`` —
    CPython's small-int hash order is ascending only while the values stay under
    the set's table size.
    """
    composition = _FakeComposition()
    monkeypatch.setattr(evidence_module, "compile_timeline", lambda *_args, **_kwargs: composition)
    monkeypatch.setattr(evidence_module, "index_assets", lambda *_args, **_kwargs: {})

    acquire_temporal_evidence(
        _project(),
        tmp_path,
        [
            ComparisonEvidenceRequest.model_validate(
                {
                    **_base("comparison", "compare"),
                    "leftFrame": 33,
                    "rightFrame": 5,
                    "check": "shot_match",
                    "maxDifference": 0.5,
                }
            )
        ],
    )
    sampled = [round(time * 30) for time in composition.frame_calls]
    assert sampled == sorted(sampled)


def test_refuses_a_boundary_outside_its_window() -> None:
    for boundary in (0, 3, 9):
        with pytest.raises(ValidationError, match="boundaryFrame"):
            AudioEvidenceRequest.model_validate(
                {
                    **_base("audio", "audio"),
                    "startFrame": 0,
                    "endFrame": 3,
                    "boundaryFrame": boundary,
                    "channels": "mix",
                }
            )


def test_refuses_to_measure_a_role_no_track_is_labelled_with(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """An unlabelled project cannot answer "how loud is the dialogue".

    Returning silence would read as "the dialogue is fine", and guessing which lane holds it is
    exactly what schema v17 exists to avoid. The only honest answer is to say it is unlabelled.
    """
    composition = _FakeComposition()
    monkeypatch.setattr(evidence_module, "compile_timeline", lambda *_args, **_kwargs: composition)
    monkeypatch.setattr(evidence_module, "index_assets", lambda *_args, **_kwargs: {})
    request = AudioEvidenceRequest.model_validate(
        {
            **_base("audio", "dialogue"),
            "startFrame": 0,
            "endFrame": 3,
            "channels": "dialogue",
        }
    )

    with pytest.raises(TemporalEvidenceError, match="No track is labelled"):
        acquire_temporal_evidence(_project(), tmp_path, [request])
    # Borrowed, so the failure path releases the borrow rather than closing it;
    # the cache still owns the teardown. What must NOT happen is the borrow
    # outliving the call — a stuck borrow would deadlock the next request for
    # this revision, so clearing (which waits on the entry lock) must complete.
    evidence_module.COMPOSITION_CACHE.clear()
    assert composition.closed is True


def test_union_contract_refuses_unknown_fields() -> None:
    adapter: TypeAdapter[TemporalEvidenceRequest] = TypeAdapter(TemporalEvidenceRequest)
    with pytest.raises(ValidationError, match="extra_forbidden"):
        adapter.validate_python(
            {
                **_base("frame", "strict"),
                "atFrame": 0,
                "metrics": ["luma"],
                "invented": True,
            }
        )

    with pytest.raises(ValidationError, match="identity must be"):
        TemporalRenderSettings(
            identity="temporal-evidence:640x360@30:captions=true",
            preset_id="temporal-evidence",
            width=1920,
            height=1080,
            fps=30,
            burn_captions=True,
        )


def test_service_route_preserves_camel_case_contract(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from fastapi.testclient import TestClient

    from framepilot_engine import service as service_module
    from framepilot_engine.config import Settings
    from framepilot_engine.service import create_app

    seen: list[TemporalEvidenceRequest] = []

    def fake_acquire(
        _project_value: Project,
        _base_dir: Path,
        requests: list[TemporalEvidenceRequest],
        _cancelled: object = None,
    ) -> TemporalEvidenceBatch:
        seen.extend(requests)
        return TemporalEvidenceBatch(
            render_settings=TemporalRenderSettings(
                identity="temporal-evidence:4x4@30:captions=true",
                preset_id="temporal-evidence",
                width=4,
                height=4,
                fps=30,
                burn_captions=True,
            ),
            results=[
                FrameEvidenceResult(
                    request_id="frame",
                    project_revision=4,
                    sample=FrameSample(
                        frame=0,
                        luma=0.5,
                        black_ratio=0,
                        perceptual_hash="42",
                    ),
                ),
            ],
        )

    monkeypatch.setattr(service_module, "acquire_temporal_evidence", fake_acquire)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    response = client.post(
        "/review/temporal-evidence",
        json={
            "project": _project().model_dump(by_alias=True, mode="json"),
            "requests": [
                {
                    **_base("frame", "frame"),
                    "atFrame": 0,
                    "metrics": ["luma", "black_ratio", "perceptual_hash"],
                }
            ],
        },
    )

    assert response.status_code == 200, response.text
    assert seen[0].request_id == "frame"
    assert response.json() == {
        "renderSettings": {
            "identity": "temporal-evidence:4x4@30:captions=true",
            "presetId": "temporal-evidence",
            "width": 4,
            "height": 4,
            "fps": 30.0,
            "burnCaptions": True,
        },
        "results": [
            {
                "schemaVersion": 1,
                "requestId": "frame",
                "projectRevision": 4,
                "kind": "frame",
                "sample": {
                    "frame": 0,
                    "luma": 0.5,
                    "blackRatio": 0,
                    "perceptualHash": "42",
                },
                "renderSettings": None,
            }
        ],
    }


class _SkinComposition:
    """Half skin-coloured, half mid-grey — a known coverage the qualifier must find."""

    def __init__(self) -> None:
        self.audio = _FakeAudio()
        self.closed = False

    def get_frame(self, _time: float) -> object:
        frame = np.zeros((4, 4, 3), dtype=np.uint8)
        frame[:2, :, :] = (196, 142, 118)  # a plausible skin tone
        frame[2:, :, :] = (128, 128, 128)  # grey: fails the red-over-green rule
        return frame

    def close(self) -> None:
        self.closed = True


def test_scope_evidence_measures_skin_coloured_pixels_separately(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Skin channels read the qualified pixels only, and say how much they covered.

    The grey half is deliberately included: a whole-frame red median would land
    between the two, so a skin median that equals the skin half's own value is
    what proves the qualifier actually restricted the measurement.
    """
    monkeypatch.setattr(evidence_module, "compile_timeline", lambda *_a, **_k: _SkinComposition())
    monkeypatch.setattr(evidence_module, "index_assets", lambda *_args, **_kwargs: {})
    request = ScopeEvidenceRequest.model_validate(
        {
            **_base("scope", "scope"),
            "startFrame": 0,
            "endFrame": 2,
            "channels": ["red", "skin_red", "skin_green", "skin_blue"],
            "legalMin": 0,
            "legalMax": 1,
        }
    )

    result = acquire_temporal_evidence(_project(), tmp_path, [request]).results[0]
    assert result.kind == "scope"
    samples = result.samples
    by_channel = {
        sample.channel: sample
        for sample in samples
        if isinstance(sample, ScopeSample) and sample.frame == 0
    }
    assert by_channel["skin_red"].coverage_ratio == pytest.approx(0.5)
    assert by_channel["skin_red"].p50 == pytest.approx(196 / 255)
    assert by_channel["skin_green"].p50 == pytest.approx(142 / 255)
    assert by_channel["skin_blue"].p50 == pytest.approx(118 / 255)
    # The unqualified channel still measures the whole frame, greys included.
    assert by_channel["red"].p50 == pytest.approx(162 / 255, abs=0.01)
    assert by_channel["red"].coverage_ratio is None


class _GreyComposition:
    def __init__(self) -> None:
        self.audio = _FakeAudio()
        self.closed = False

    def get_frame(self, _time: float) -> object:
        return np.full((4, 4, 3), 128, dtype=np.uint8)

    def close(self) -> None:
        self.closed = True


def test_a_frame_with_no_skin_reports_zero_coverage_not_a_black_reading(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Nothing qualified is "no reading", which a consumer must not mistake for a dark one."""
    monkeypatch.setattr(evidence_module, "compile_timeline", lambda *_a, **_k: _GreyComposition())
    monkeypatch.setattr(evidence_module, "index_assets", lambda *_args, **_kwargs: {})
    request = ScopeEvidenceRequest.model_validate(
        {
            **_base("scope", "scope"),
            "startFrame": 0,
            "endFrame": 2,
            "channels": ["skin_red"],
            "legalMin": 0,
            "legalMax": 1,
        }
    )

    result = acquire_temporal_evidence(_project(), tmp_path, [request]).results[0]
    assert result.kind == "scope"
    sample = result.samples[0]
    assert sample.coverage_ratio == 0.0
    assert sample.p50 is None


def test_a_pure_scope_batch_measures_without_burning_captions(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Colour measurement must read the shot, not a caption sitting over it.

    Review finding: burning captions into the measurement render made every
    measurement of a project with a caption track read as occluded, so shot
    matching could never succeed on an ordinary project. Review batches still burn
    them — a black-frame check has to see what ships.
    """
    monkeypatch.setattr(evidence_module, "compile_timeline", lambda *_a, **_k: _FakeComposition())
    monkeypatch.setattr(evidence_module, "index_assets", lambda *_args, **_kwargs: {})
    scope = ScopeEvidenceRequest.model_validate(
        {
            **_base("scope", "scope"),
            "startFrame": 0,
            "endFrame": 2,
            "channels": ["luma"],
            "legalMin": 0,
            "legalMax": 1,
        }
    )
    measurement = acquire_temporal_evidence(_project(), tmp_path, [scope])
    assert measurement.render_settings.burn_captions is False
    assert "captions=false" in measurement.render_settings.identity

    mixed = acquire_temporal_evidence(
        _project(),
        tmp_path,
        [
            scope,
            FrameEvidenceRequest.model_validate(
                {**_base("frame", "frame"), "atFrame": 0, "metrics": ["luma"]}
            ),
        ],
    )
    assert mixed.render_settings.burn_captions is True


def test_only_comparison_frames_are_planned_for_retention() -> None:
    """Pixels are held only where two frames must exist at once.

    This is the batch's memory contract. Every other request reduces a frame to a
    few scalars, so the loop can compute and drop it; a comparison subtracts one
    frame from another and cannot. Holding *everything* it sampled — at project
    resolution, as float64 — is what let one review batch reach tens of GB, so a
    regression here is a machine-killer rather than a slowdown.
    """
    plan = evidence_module._plan_visual_frames(
        [
            FrameEvidenceRequest.model_validate(
                {**_base("frame", "frame"), "atFrame": 0, "metrics": ["luma"]}
            ),
            RangeEvidenceRequest.model_validate(
                {
                    **_base("range", "range"),
                    "startFrame": 0,
                    "endFrame": 6,
                    "sampleEveryFrames": 2,
                    "checks": ["black_frames"],
                }
            ),
            ScopeEvidenceRequest.model_validate(
                {
                    **_base("scope", "scope"),
                    "startFrame": 0,
                    "endFrame": 4,
                    "channels": ["luma"],
                    "legalMin": 0,
                    "legalMax": 1,
                }
            ),
        ]
    )
    assert plan.comparison_frames == frozenset()
    assert plan.sample_frames == frozenset({0, 2, 4})
    scope_plan = evidence_module._scope_plan(
        [
            ScopeEvidenceRequest.model_validate(
                {
                    **_base("scope", "scope"),
                    "startFrame": 0,
                    "endFrame": 4,
                    "channels": ["luma"],
                    "legalMin": 0,
                    "legalMax": 1,
                }
            ),
        ]
    )
    assert scope_plan == {
        0: {("luma",)},
        1: {("luma",)},
        3: {("luma",)},
    }

    compared = evidence_module._plan_visual_frames(
        [
            ComparisonEvidenceRequest.model_validate(
                {
                    **_base("comparison", "compare"),
                    "leftFrame": 5,
                    "rightFrame": 33,
                    "check": "shot_match",
                    "maxDifference": 0.5,
                }
            )
        ]
    )
    assert compared.comparison_frames == frozenset({5, 33})


def test_decoder_output_is_never_promoted_to_float64(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The cache stores what the decoder gave us, not an 8x-wider copy of it.

    Every consumer divides by 255.0 into float64 anyway, so the promotion bought
    nothing and cost 8x — 199 MB per UHD frame instead of 25 MB.
    """
    composition = _FakeComposition()
    monkeypatch.setattr(evidence_module, "compile_timeline", lambda *_a, **_k: composition)
    monkeypatch.setattr(evidence_module, "index_assets", lambda *_args, **_kwargs: {})

    seen: list[np.dtype[Any]] = []
    original = evidence_module._frame_sample

    def spy(frame_index: int, pixels: Any) -> FrameSample:
        seen.append(pixels.dtype)
        return original(frame_index, pixels)

    monkeypatch.setattr(evidence_module, "_frame_sample", spy)
    acquire_temporal_evidence(
        _project(),
        tmp_path,
        [
            FrameEvidenceRequest.model_validate(
                {**_base("frame", "frame"), "atFrame": 2, "metrics": ["luma"]}
            )
        ],
    )
    assert seen == [np.dtype(np.uint8)]


def _comparison_batch(count: int) -> list[TemporalEvidenceRequest]:
    return [
        ComparisonEvidenceRequest.model_validate(
            {
                **_base("comparison", f"compare-{index}"),
                "leftFrame": index * 2,
                "rightFrame": index * 2 + 1,
                "check": "shot_match",
                "maxDifference": 0.5,
            }
        )
        for index in range(count)
    ]


def test_the_largest_legal_batch_fits_the_resident_budget() -> None:
    """The two ceilings are one budget, so the arithmetic is the test.

    Comparison frames are the only pixels a batch holds open, and the worst case
    is every request being a comparison: `MAX_REQUESTS` x 2 distinct frames, each
    at the largest frame review can measure. If that product ever exceeds
    `MAX_RESIDENT_FRAME_BYTES`, some legal batch can exhaust the machine — which
    is the whole failure this budget exists to prevent, and it must be caught
    here rather than on a user's UHD project.

    Raising `REVIEW_MAX_DIMENSION` or `MAX_REQUESTS` without re-checking the
    budget fails this test, which is the point of writing it as arithmetic.
    """
    largest_frame_bytes = (
        evidence_module.REVIEW_MAX_DIMENSION
        * evidence_module.REVIEW_MAX_DIMENSION
        * evidence_module._FRAME_CHANNELS
    )
    worst_case = evidence_module.MAX_REQUESTS * 2 * largest_frame_bytes
    assert worst_case <= evidence_module.MAX_RESIDENT_FRAME_BYTES


def test_refuses_a_comparison_batch_that_would_not_fit_in_memory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A byte budget, because a frame COUNT means nothing across resolutions.

    400 frames is 2.5 GB at 540p and was 80 GB at UHD; the count cap let the
    second one through. The review downscale now keeps every *legal* batch well
    inside the budget (the test above pins that), so the refusal path is reached
    here by shrinking the budget rather than by inflating the project — the
    guard is defence in depth against a future ceiling change, and it has to
    keep working.
    """
    monkeypatch.setattr(evidence_module, "MAX_RESIDENT_FRAME_BYTES", 1024)
    fixture = _project().model_dump(mode="json")
    fixture["resolution"] = {"width": 3840, "height": 2160}
    project = Project.model_validate(fixture)
    with pytest.raises(TemporalEvidenceError, match="comparison frames"):
        acquire_temporal_evidence(project, tmp_path, _comparison_batch(15))


class TestReviewResolution:
    """Review measures statistics, and a statistic cannot tell UHD from a quarter of it.

    Decoding 2160x3840 to compute a mean, a ratio, a set of percentiles and an
    8x9 hash was the largest single cost in this module — and it is upstream of
    every byte budget here, because decode buffers exist before any frame this
    module holds.
    """

    def test_caps_the_longest_edge(self) -> None:
        assert evidence_module._review_frame_size(3840, 2160) == (960, 540)
        assert evidence_module._review_frame_size(2160, 3840) == (540, 960)

    def test_never_upscales_a_small_project(self) -> None:
        """A 720p project is measured at 720p, not stretched to the cap and
        measured over interpolated pixels no source ever produced."""
        assert evidence_module._review_frame_size(854, 480) == (854, 480)
        assert evidence_module._review_frame_size(4, 4) == (4, 4)

    def test_keeps_both_axes_even(self) -> None:
        """yuv420p subsamples chroma 2x2; ffmpeg refuses odd dimensions for it."""
        width, height = evidence_module._review_frame_size(1000, 999)
        assert width % 2 == 0 and height % 2 == 0

    def test_the_identity_records_what_was_measured(self, tmp_path: Path) -> None:
        """Motion has no rendered lineage, so its own result says so plainly.

        Motion is derived from authored keyframes/tracking state, never from a
        decoded frame, so per-result `render_settings` is `None` (not a claimed
        size that nothing was actually decoded at) — that per-result field, not
        the batch-level default, is what a caller must trust for lineage.
        """
        fixture = _project().model_dump(mode="json")
        fixture["resolution"] = {"width": 3840, "height": 2160}
        project = Project.model_validate(fixture)
        batch = acquire_temporal_evidence(
            project,
            tmp_path,
            [
                MotionEvidenceRequest.model_validate(
                    {
                        **_base("motion", "motion"),
                        "startFrame": 0,
                        "endFrame": 2,
                        "targetId": "clip",
                        "targetKind": "clip_transform",
                        "property": "x",
                    }
                )
            ],
        )
        assert batch.results[0].kind == "motion"
        assert batch.results[0].render_settings is None

    def test_sources_are_decoded_at_the_review_size(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The budget reaches the compiler, which is the only place it can save anything."""
        seen: list[int | None] = []

        def _spy(*_args: Any, **kwargs: Any) -> _FakeComposition:
            seen.append(kwargs.get("max_decode_dimension"))
            return _FakeComposition()

        monkeypatch.setattr(evidence_module, "compile_timeline", _spy)
        monkeypatch.setattr(evidence_module, "index_assets", lambda *_a, **_k: {})
        acquire_temporal_evidence(
            _project(),
            tmp_path,
            [
                FrameEvidenceRequest.model_validate(
                    {**_base("frame", "frame"), "atFrame": 1, "metrics": ["luma"]}
                )
            ],
        )
        assert seen == [evidence_module.REVIEW_MAX_DIMENSION]
