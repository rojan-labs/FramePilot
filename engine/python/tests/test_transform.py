"""Tests for per-clip transform evaluation from keyframes (plan Phase 5)."""

from __future__ import annotations

import pytest

from framepilot_engine.effects.transform import (
    ClipTransform,
    animated_properties,
    deferred_transform_properties,
    evaluate_clip_transform,
    has_rendered_transform,
)
from framepilot_engine.timeline.models import Clip, Keyframe


def _clip(*keyframes: Keyframe) -> Clip:
    return Clip(
        id="c1",
        asset_id="a1",
        track_id="v",
        start=0.0,
        end=4.0,
        source_start=0.0,
        source_end=4.0,
        keyframes=list(keyframes),
    )


def _kf(prop: str, time: float, value: float, easing: str = "linear") -> Keyframe:
    return Keyframe(id=f"{prop}_{time}", time=time, property=prop, value=value, easing=easing)


def test_identity_transform_when_no_keyframes() -> None:
    transform = evaluate_clip_transform(_clip(), 1.0)
    assert transform == ClipTransform()
    assert transform.scale == 1.0 and transform.opacity == 1.0


def test_scale_ramp_is_evaluated() -> None:
    clip = _clip(_kf("scale", 0.0, 1.0), _kf("scale", 2.0, 2.0))
    assert evaluate_clip_transform(clip, 1.0).scale == pytest.approx(1.5)
    # Untouched properties keep their identity values.
    assert evaluate_clip_transform(clip, 1.0).x == 0.0


def test_independent_properties_animate_separately() -> None:
    clip = _clip(
        _kf("scale", 0.0, 1.0),
        _kf("scale", 2.0, 1.5),
        _kf("x", 0.0, 0.0),
        _kf("x", 2.0, 100.0),
    )
    transform = evaluate_clip_transform(clip, 1.0)
    assert transform.scale == pytest.approx(1.25)
    assert transform.x == pytest.approx(50.0)
    assert transform.y == 0.0


def test_opacity_is_clamped_to_unit_range() -> None:
    over = _clip(_kf("opacity", 0.0, 5.0), _kf("opacity", 2.0, 5.0))
    under = _clip(_kf("opacity", 0.0, -1.0), _kf("opacity", 2.0, -1.0))
    assert evaluate_clip_transform(over, 1.0).opacity == 1.0
    assert evaluate_clip_transform(under, 1.0).opacity == 0.0


def test_has_rendered_transform_detects_geometry_only() -> None:
    assert has_rendered_transform(_clip(_kf("scale", 0.0, 1.0))) is True
    assert has_rendered_transform(_clip(_kf("rotation", 0.0, 0.0))) is True
    # opacity renders via the clip mask, not the geometry (resize/position) path.
    assert has_rendered_transform(_clip(_kf("opacity", 0.0, 1.0))) is False
    assert has_rendered_transform(_clip()) is False


def test_animated_properties_set() -> None:
    clip = _clip(_kf("scale", 0.0, 1.0), _kf("x", 0.0, 0.0), _kf("opacity", 0.0, 1.0))
    assert animated_properties(clip) == {"scale", "x", "opacity"}


def test_deferred_properties_empty_now_opacity_renders() -> None:
    # As of Phase 6 opacity renders (via the clip mask), so nothing is deferred.
    clip = _clip(_kf("scale", 0.0, 1.0), _kf("opacity", 0.0, 1.0))
    assert deferred_transform_properties(clip) == []
    assert deferred_transform_properties(_clip(_kf("scale", 0.0, 1.0))) == []
