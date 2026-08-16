"""Tests for transition envelopes (PRD §6.9, plan Phase 6)."""

from __future__ import annotations

import pytest

from framepilot_engine.render.transitions import (
    DEFAULT_SOFTNESS,
    WIPE_SOFTNESS,
    Transition,
    affects_blur,
    affects_geometry,
    affects_opacity,
    affects_wipe,
    blur_radius_at,
    eased_progress,
    offset_at,
    opacity_at,
    progress,
    scale_at,
    transition_from_clip,
    wipe_alpha,
    wipe_axis,
    wipe_edge,
    wipe_progress_at,
    wipe_softness,
    zoom_from,
)
from framepilot_engine.timeline.models import Clip, Effect


def _clip(*effects: Effect) -> Clip:
    return Clip(
        id="c",
        asset_id="a",
        track_id="v",
        start=0.0,
        end=2.0,
        source_start=0.0,
        source_end=2.0,
        effects=list(effects),
    )


def test_progress_ramps_then_holds() -> None:
    assert progress(0.0, 1.0) == 0.0
    assert progress(0.5, 1.0) == pytest.approx(0.5)
    assert progress(1.0, 1.0) == 1.0
    assert progress(5.0, 1.0) == 1.0
    assert progress(0.5, 0.0) == 1.0  # zero-duration → instantly done


def test_kind_predicates() -> None:
    assert affects_opacity(Transition("fade", 1.0))
    assert affects_opacity(Transition("cross-dissolve", 1.0))
    assert affects_geometry(Transition("push", 1.0))
    assert affects_geometry(Transition("zoom", 1.0))
    assert affects_geometry(Transition("slide", 1.0))
    assert affects_blur(Transition("blur", 1.0))
    assert affects_wipe(Transition("wipe", 1.0))
    assert not affects_wipe(Transition("fade", 1.0))
    assert not affects_opacity(Transition("cut", 1.0))


def test_fade_opacity_ramps_in() -> None:
    tr = Transition("fade", 1.0)
    assert opacity_at(tr, 0.0) == 0.0
    assert opacity_at(tr, 1.0) == 1.0
    assert opacity_at(Transition("cut", 1.0), 0.0) == 1.0  # cut is instant/opaque


def test_zoom_scale_decays_to_one() -> None:
    tr = Transition("zoom", 1.0)
    assert scale_at(tr, 0.0) > 1.0  # starts zoomed in
    assert scale_at(tr, 1.0) == pytest.approx(1.0)  # settles at native
    assert scale_at(Transition("fade", 1.0), 0.0) == 1.0  # non-zoom → no scale


def test_push_offset_slides_to_zero() -> None:
    tr = Transition("push", 1.0)
    assert offset_at(tr, 0.0, 1000.0, 500.0) == pytest.approx((1000.0, 0.0))  # from the right
    assert offset_at(tr, 1.0, 1000.0, 500.0)[0] == pytest.approx(0.0)  # arrived
    assert offset_at(Transition("zoom", 1.0), 0.0, 1000.0, 500.0) == (0.0, 0.0)


def test_slide_offset_rises_to_zero() -> None:
    tr = Transition("slide", 1.0)
    assert offset_at(tr, 0.0, 1000.0, 500.0) == pytest.approx((0.0, 500.0))  # from below
    assert offset_at(tr, 0.5, 1000.0, 500.0) == pytest.approx((0.0, 250.0))
    assert offset_at(tr, 1.0, 1000.0, 500.0) == pytest.approx((0.0, 0.0))  # arrived


def test_wipe_alpha_reveals_left_to_right() -> None:
    # p == 0: hidden everywhere; p == 1: fully revealed everywhere (even at x=1).
    assert wipe_alpha(0.0, 0.0) == 0.0
    assert wipe_alpha(1.0, 0.0) == 0.0
    assert wipe_alpha(0.0, 1.0) == 1.0
    assert wipe_alpha(1.0, 1.0) == 1.0
    # Mid-progress: opaque well left of the edge, transparent right of it,
    # partial inside the soft band.
    p = 0.5
    edge = wipe_edge(p)
    assert wipe_alpha(edge - WIPE_SOFTNESS, p) == pytest.approx(1.0)
    assert wipe_alpha(edge + 1e-9, p) == 0.0
    assert 0.0 < wipe_alpha(edge - WIPE_SOFTNESS / 2, p) < 1.0


def test_wipe_progress_at_only_for_wipe() -> None:
    tr = Transition("wipe", 1.0)
    assert wipe_progress_at(tr, 0.0) == 0.0
    assert wipe_progress_at(tr, 0.25) == pytest.approx(0.25)
    assert wipe_progress_at(tr, 2.0) == 1.0
    assert wipe_progress_at(Transition("fade", 1.0), 0.0) == 1.0  # non-wipe → shown


def test_blur_radius_decays_to_zero() -> None:
    tr = Transition("blur", 1.0)
    assert blur_radius_at(tr, 0.0, 1000.0) > 0.0
    assert blur_radius_at(tr, 1.0, 1000.0) == pytest.approx(0.0)
    assert blur_radius_at(Transition("fade", 1.0), 0.0, 1000.0) == 0.0


def test_transition_from_clip_parses_effect() -> None:
    effect = Effect(
        id="c__transition",
        type="transition",
        params={"kind": "cross-dissolve", "durationSeconds": 0.75},
    )
    tr = transition_from_clip(_clip(effect))
    assert tr is not None and tr.kind == "cross-dissolve" and tr.duration == 0.75


def test_transition_from_clip_none_without_effect() -> None:
    assert transition_from_clip(_clip()) is None


# ---------------------------------------------------------------------------
# Revamp Phase 9 — parameters (sub-plan §4.3). Additive into the free-form
# ``Effect.params``: no schema change, no migration, and — asserted below — no
# change to what an existing project renders.
# ---------------------------------------------------------------------------


def _transition_clip(**params: object) -> Clip:
    return _clip(Effect(id="c__transition", type="transition", params=dict(params)))


def test_missing_params_parse_as_the_pre_phase_9_render() -> None:
    tr = transition_from_clip(_transition_clip(kind="push", durationSeconds=1.0))
    assert tr is not None
    assert tr.easing == "linear"
    assert tr.intensity == 1.0
    assert tr.softness == pytest.approx(DEFAULT_SOFTNESS)
    assert tr.direction == ""


def test_easing_defaults_to_linear_not_ease_in_out() -> None:
    # The sub-plan's §4.3 table says ease-in-out. Defaulting to a curve would
    # silently re-time every transition in every existing project.
    tr = Transition("fade", 1.0)
    assert eased_progress(tr, 0.25) == pytest.approx(0.25)


def test_default_softness_reproduces_the_old_constant_exactly() -> None:
    assert wipe_softness(Transition("wipe", 1.0)) == pytest.approx(WIPE_SOFTNESS, abs=1e-12)


def test_default_directions_are_what_the_render_already_did() -> None:
    assert Transition("push", 1.0).resolved_direction == "left"  # started right
    assert Transition("slide", 1.0).resolved_direction == "up"  # started below
    assert Transition("wipe", 1.0).resolved_direction == "right"
    assert Transition("zoom", 1.0).resolved_direction == "in"


def test_a_direction_the_kind_does_not_have_falls_back() -> None:
    # A stale param survives a kind swap on purpose, so it must be inert, not wrong.
    assert Transition("push", 1.0, direction="in").resolved_direction == "left"
    assert Transition("zoom", 1.0, direction="left").resolved_direction == "in"


def test_junk_params_are_coerced_rather_than_raising() -> None:
    # ``Effect.params`` is free-form, so a value can arrive as a string from a
    # hand-edited project or an AI patch. A NaN offset is an invisible clip, and an
    # exception here fails the whole export for a cosmetic value.
    tr = transition_from_clip(
        _transition_clip(kind="push", durationSeconds="nonsense", intensity="x", softness=None)
    )
    assert tr is not None
    assert tr.duration == 0.0
    assert tr.intensity == 1.0
    assert tr.softness == pytest.approx(DEFAULT_SOFTNESS)


def test_intensity_and_softness_are_clamped() -> None:
    tr = transition_from_clip(
        _transition_clip(kind="fade", durationSeconds=1.0, intensity=5, softness=-3)
    )
    assert tr is not None
    assert tr.intensity == 1.0
    assert tr.softness == 0.0


def test_easing_shapes_every_envelope_not_just_opacity() -> None:
    # ease-in is t², so at the midpoint every envelope is a quarter of the way.
    assert opacity_at(Transition("fade", 1.0, easing="ease-in"), 0.5) == pytest.approx(0.25)
    assert offset_at(Transition("push", 1.0, easing="ease-in"), 0.5, 1000.0, 500.0)[
        0
    ] == pytest.approx(750.0)
    assert blur_radius_at(Transition("blur", 1.0, easing="ease-in"), 0.5, 1000.0) == pytest.approx(
        30.0
    )


def test_unknown_easing_falls_back_to_linear() -> None:
    assert eased_progress(Transition("fade", 1.0, easing="wobble"), 0.5) == pytest.approx(0.5)


def test_every_curve_still_starts_at_zero_and_ends_at_one() -> None:
    for easing in ("linear", "ease-in", "ease-out", "ease-in-out", "bezier"):
        tr = Transition("fade", 1.0, easing=easing)
        assert opacity_at(tr, 0.0) == pytest.approx(0.0)
        assert opacity_at(tr, 1.0) == pytest.approx(1.0)


def test_intensity_scales_how_far_the_effect_travels() -> None:
    # Half a dissolve never fully loses the picture.
    half = Transition("cross-dissolve", 1.0, intensity=0.5)
    assert opacity_at(half, 0.0) == pytest.approx(0.5)
    assert opacity_at(half, 1.0) == pytest.approx(1.0)
    assert offset_at(Transition("push", 1.0, intensity=0.5), 0.0, 1000.0, 500.0)[
        0
    ] == pytest.approx(500.0)
    assert blur_radius_at(Transition("blur", 1.0, intensity=0.5), 0.0, 1000.0) == pytest.approx(
        20.0
    )


def test_zero_intensity_is_a_no_op_for_every_kind_with_a_magnitude() -> None:
    assert opacity_at(Transition("fade", 1.0, intensity=0.0), 0.0) == pytest.approx(1.0)
    assert offset_at(Transition("push", 1.0, intensity=0.0), 0.0, 1000.0, 500.0) == (0.0, 0.0)
    assert scale_at(Transition("zoom", 1.0, intensity=0.0), 0.0) == pytest.approx(1.0)
    assert blur_radius_at(Transition("blur", 1.0, intensity=0.0), 0.0, 1000.0) == pytest.approx(0.0)


def test_push_travels_each_of_the_four_ways_and_always_settles() -> None:
    # The clip starts one frame OPPOSITE its travel direction.
    assert offset_at(
        Transition("push", 1.0, direction="left"), 0.0, 1000.0, 500.0
    ) == pytest.approx((1000.0, 0.0))
    assert offset_at(
        Transition("push", 1.0, direction="right"), 0.0, 1000.0, 500.0
    ) == pytest.approx((-1000.0, 0.0))
    assert offset_at(Transition("push", 1.0, direction="up"), 0.0, 1000.0, 500.0) == pytest.approx(
        (0.0, 500.0)
    )
    assert offset_at(
        Transition("push", 1.0, direction="down"), 0.0, 1000.0, 500.0
    ) == pytest.approx((0.0, -500.0))
    for direction in ("left", "right", "up", "down"):
        assert offset_at(
            Transition("push", 1.0, direction=direction), 1.0, 1000.0, 500.0
        ) == pytest.approx((0.0, 0.0))


def test_zoom_out_starts_smaller_and_is_the_reciprocal_of_zoom_in() -> None:
    assert zoom_from(Transition("zoom", 1.0, direction="in")) == pytest.approx(1.6)
    assert zoom_from(Transition("zoom", 1.0, direction="out")) == pytest.approx(1.0 / 1.6)
    # Never zero: a zero scale is a clip with no pixels at all.
    assert zoom_from(Transition("zoom", 1.0, direction="out")) > 0.0
    assert scale_at(Transition("zoom", 1.0, direction="out"), 1.0) == pytest.approx(1.0)


def test_wipe_axis_mirrors_the_fraction_rather_than_forking_the_formula() -> None:
    assert wipe_axis(Transition("wipe", 1.0, direction="right")) == ("x", False)
    assert wipe_axis(Transition("wipe", 1.0, direction="left")) == ("x", True)
    assert wipe_axis(Transition("wipe", 1.0, direction="down")) == ("y", False)
    assert wipe_axis(Transition("wipe", 1.0, direction="up")) == ("y", True)


def test_wipe_softness_is_bounded_and_never_zero() -> None:
    # A zero feather divides by zero in the alpha formula, and a truly hard edge
    # shimmers at render fps anyway.
    assert wipe_softness(Transition("wipe", 1.0, softness=0.0)) > 0.0
    assert wipe_softness(Transition("wipe", 1.0, softness=1.0)) == pytest.approx(0.25)


def test_a_wider_feather_widens_the_band_and_still_clears_at_p_one() -> None:
    wide = wipe_softness(Transition("wipe", 1.0, softness=1.0))
    # Probed just BEYOND the narrow feather's reveal (edge 0.525 at p=0.5): the wide
    # feather has already begun revealing there, the narrow one has not. Probing
    # behind the edge instead proves nothing — both are fully revealed there.
    assert wipe_alpha(0.55, 0.5, WIPE_SOFTNESS) == 0.0
    assert 0.0 < wipe_alpha(0.55, 0.5, wide) < 1.0
    for softness in (0.05, 0.15, 0.25):
        assert wipe_alpha(0.0, 1.0, softness) == 1.0
        assert wipe_alpha(1.0, 1.0, softness) == 1.0
        assert wipe_alpha(0.5, 0.0, softness) == 0.0
