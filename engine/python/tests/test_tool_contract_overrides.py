"""Regression coverage for the strict Python AI-tool input boundary."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from framepilot_engine.ai_tools import TOOL_REGISTRY
from framepilot_engine.ai_tools.registry import caption_template_count


def validate(name: str, payload: dict[str, object]) -> Any:
    """Return the validated model. `Any` so tests can read the fields they assert on."""
    return TOOL_REGISTRY[name].input_model.model_validate(payload)


def rejects(name: str, payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        validate(name, payload)


@pytest.mark.parametrize("name", ["get_transcript", "get_mapped_transcript", "get_clips"])
def test_read_windows_reject_inverted_ranges(name: str) -> None:
    rejects(name, {"start": 10, "end": 5})


def test_map_time_requires_one_unambiguous_domain() -> None:
    rejects("map_time", {"sourceTime": 1, "sequenceTime": 2})
    rejects("map_time", {"assetId": "asset-a"})
    validate("map_time", {"sourceTime": 1, "assetId": "asset-a"})
    validate("map_time", {"sequenceTime": 1})
    validate("map_time", {})


def test_defaulted_fields_accept_omission_exactly_like_typescript() -> None:
    """A call TS accepts must not be rejected here.

    These three arguments carry a `.default()` in the TS registry, so omitting them is
    a legal call the model is entitled to make. Rejecting them in Python would recreate
    the cross-surface split this hardening exists to remove: accepted by in-app
    orchestration, 4xx at the sidecar. Strictness belongs on values, not on defaults.
    """
    assert validate("add_asset", {"path": "clip.mp4"}).kind == "video"
    added = validate("add_clip", {"trackId": "v", "assetId": "a", "start": 0, "end": 1})
    assert added.source_start == 0.0
    assert validate("add_track", {}).type == "overlay"


def test_required_fields_are_still_required() -> None:
    rejects("add_asset", {})
    rejects("add_clip", {"trackId": "v", "assetId": "a", "start": 0})
    rejects("add_clip", {"trackId": "v", "assetId": "a", "start": 5, "end": 5})


def test_effect_contract_bounds_are_strict() -> None:
    rejects("adjust_effect", {"layerId": "fx", "intensity": 1.1})
    rejects("apply_effect", {"effectId": "blur", "startTime": -1})
    rejects("apply_effect", {"effectId": "blur", "startTime": 3, "endTime": 2})
    rejects("move_effect", {"layerId": "fx", "toStart": -1})
    rejects("resize_effect", {"layerId": "fx", "start": 3, "end": 2})
    rejects("discover_effects", {"limit": 81})
    rejects("discover_transitions", {"limit": 81})
    # The ceiling is the catalog's own size, so the whole catalog is reachable in one
    # call — a lower bound made the template ids past the cut unusable, and
    # set_track_caption_style rejects an id the model was never shown.
    validate("discover_caption_styles", {"limit": caption_template_count()})
    rejects("discover_caption_styles", {"limit": caption_template_count() + 1})


def test_frame_time_cannot_be_negative() -> None:
    rejects("get_frame", {"timeSeconds": -0.01})


def test_clip_keyframes_match_renderer_vocabulary_and_value_domains() -> None:
    rejects(
        "add_keyframes",
        {"clipId": "clip", "keyframes": [{"time": 1, "property": "blur", "value": 2}]},
    )
    rejects(
        "add_keyframes",
        {"clipId": "clip", "keyframes": [{"time": 1, "property": "scale", "value": 0}]},
    )
    rejects(
        "add_keyframes",
        {"clipId": "clip", "keyframes": [{"time": 1, "property": "opacity", "value": 1.1}]},
    )
    validate(
        "add_keyframes",
        {"clipId": "clip", "keyframes": [{"time": 1, "property": "rotation", "value": 15}]},
    )


def test_punch_in_rejects_inverted_explicit_window() -> None:
    rejects("punch_in", {"clipId": "clip", "startTime": 4, "endTime": 2})


def test_color_grade_rejects_unrendered_types_and_bad_params() -> None:
    rejects("apply_color_grade", {"clipId": "clip", "type": "transform"})
    rejects("apply_color_grade", {"clipId": "clip", "params": {"vibrance": 1}})
    rejects("apply_color_grade", {"clipId": "clip", "params": {"exposure": 6}})
    rejects("apply_color_grade", {"clipId": "clip", "type": "lut", "params": {}})
    validate("apply_color_grade", {"clipId": "clip", "params": {"exposure": 1}})
    validate(
        "apply_color_grade",
        {"clipId": "clip", "type": "lut", "params": {"path": "look.cube"}},
    )


def test_audio_gain_is_bounded() -> None:
    rejects("adjust_audio", {"clipId": "clip", "gainDb": 25})
    rejects("adjust_audio", {"clipId": "clip", "gainDb": -121})
    validate("adjust_audio", {"clipId": "clip", "gainDb": -12})


def test_tracker_region_is_normalized_and_contained() -> None:
    rejects(
        "track_object",
        {
            "clipId": "clip",
            "target": "object",
            "region": {"x": 0.8, "y": 0, "width": 0.3, "height": 0.5},
        },
    )
    rejects(
        "track_object",
        {
            "clipId": "clip",
            "target": "object",
            "region": {"x": 0, "y": 0, "width": 0, "height": 0.5},
        },
    )
    validate(
        "track_object",
        {
            "clipId": "clip",
            "target": "object",
            "region": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5},
        },
    )


def test_manage_assets_plan_cannot_be_empty() -> None:
    rejects("manage_assets", {"strategy": "plan"})
    validate("manage_assets", {"strategy": "by-kind"})


def test_crop_tool_uses_a_strict_nested_boundary() -> None:
    rejects(
        "set_clip_crop",
        {"clipId": "clip", "crop": {"x": 0, "y": 0, "width": 1, "height": 1, "extra": 1}},
    )
    rejects(
        "set_clip_crop",
        {"clipId": "clip", "crop": {"x": 0.8, "y": 0, "width": 0.3, "height": 1}},
    )


def test_caption_tool_nested_objects_forbid_unknown_fields_and_enforce_bounds() -> None:
    rejects(
        "set_caption_style",
        {"clipId": "clip", "captionStyle": {"display": "phrase", "madeUp": True}},
    )
    rejects(
        "set_track_caption_style",
        {"trackId": "captions", "captionStyle": {"xPercent": 101}},
    )
    rejects(
        "auto_emphasize_captions",
        {"trackId": "captions", "keywords": ["word"], "style": {"lineHeight": 4}},
    )
