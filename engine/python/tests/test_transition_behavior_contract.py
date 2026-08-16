"""Behavioral parity contract for AI-authored transitions.

Schema parity alone cannot catch two runtimes that accept the same fields but disagree
about their meaning. These tests pin the Python operation/validator behavior to the
transition rules generated from the canonical TypeScript catalog: every catalog id is a
valid typed operation, transitions require a clean cut, and the maximum duration is half
of the shorter neighbouring clip.
"""

from __future__ import annotations

from pydantic import TypeAdapter

from framepilot_engine.render.transition_catalog import load_catalog
from framepilot_engine.timeline.models import Clip, Timeline, Track
from framepilot_engine.timeline.operations import AddTransition, Operation
from framepilot_engine.validation.patch_validation import validate_patch

_OPERATION: TypeAdapter[Operation] = TypeAdapter(Operation)


def _clip(clip_id: str, start: float, end: float) -> Clip:
    return Clip.model_validate(
        {
            "id": clip_id,
            "assetId": "asset",
            "trackId": "v",
            "start": start,
            "end": end,
            "sourceStart": 0.0,
            "sourceEnd": end - start,
        }
    )


def _transition(kind: str, duration: float = 0.5) -> AddTransition:
    operation = _OPERATION.validate_python(
        {
            "type": "add_transition",
            "trackId": "v",
            "fromClipId": "a",
            "toClipId": "b",
            "kind": kind,
            "durationSeconds": duration,
        }
    )
    assert isinstance(operation, AddTransition)
    return operation


def test_every_generated_catalog_id_is_representable_by_add_transition() -> None:
    catalog_ids = sorted(load_catalog().transitions)
    assert len(catalog_ids) > 8
    for transition_id in catalog_ids:
        operation = _transition(transition_id)
        assert operation.kind == transition_id


def test_transition_requires_a_clean_cut() -> None:
    timeline = Timeline(
        tracks=[Track(id="v", type="video", clips=[_clip("a", 0, 4), _clip("b", 5, 9)])]
    )
    result = validate_patch(timeline, [_transition("fade")])
    assert result.valid is False
    assert any(
        issue.code == "transition_overlap" and "clean cut" in issue.message
        for issue in result.issues
    )


def test_transition_duration_is_bounded_by_half_the_shorter_clip() -> None:
    timeline = Timeline(
        tracks=[Track(id="v", type="video", clips=[_clip("a", 0, 4), _clip("b", 4, 8)])]
    )

    exact_limit = validate_patch(timeline, [_transition("fade", 2.0)])
    assert exact_limit.valid is True

    too_long = validate_patch(timeline, [_transition("fade", 2.000001)])
    assert too_long.valid is False
    assert any(
        issue.code == "transition_overlap" and "transition capacity" in issue.message
        for issue in too_long.issues
    )
