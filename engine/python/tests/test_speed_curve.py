"""Speed curves (schema v15, ADR 0090) — the Python half of a parity pair.

Two obligations, and they are different in kind:

1. **The maths is right** — the integral generalises ADR 0046's division, the
   inversion is its actual inverse, and a freeze is not judged by a rule that
   cannot apply to it.
2. **The two languages agree on the NUMBERS.** ``test_schema_parity.py`` proves the
   two schemas have the same shape; it cannot prove two numerical integrators
   produce the same duration, and a duration that drifts desynchronises everything
   after the clip. ``packages/editor-core/fixtures/speed-curve-parity.json`` is
   asserted here and in ``speed-curve.test.ts``, to 1e-9.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.effects.speed_curve import (
    clip_timeline_duration,
    has_speed_ramp,
    integrate_rate,
    normalize_ramp,
    rate_at,
    source_span_for_duration,
    source_time_at,
)
from framepilot_engine.timeline.models import Clip, SpeedPoint

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "editor-core"
    / "fixtures"
    / "speed-curve-parity.json"
)


def _point(id_: str, source_time: float, rate: float, easing: str = "linear") -> SpeedPoint:
    return SpeedPoint(id=id_, source_time=source_time, rate=rate, easing=easing)


def _clip(**overrides: object) -> Clip:
    fields: dict[str, object] = {
        "id": "c",
        "assetId": "a",
        "trackId": "v",
        "start": 0.0,
        "end": 4.0,
        "sourceStart": 0.0,
        "sourceEnd": 4.0,
    }
    fields.update(overrides)
    return Clip(**fields)


# ---------------------------------------------------------------------------
# The integral generalises ADR 0046
# ---------------------------------------------------------------------------


def test_reduces_to_source_span_over_speed_for_a_constant_rate() -> None:
    # The whole design rests on the constant case falling out of the integral, so
    # this is asserted, not assumed.
    for rate in (0.25, 0.5, 1.0, 2.0, 4.0):
        ramp = [_point("a", 0.0, rate), _point("b", 10.0, rate)]
        assert integrate_rate(ramp, 0.0, 10.0) == pytest.approx(10.0 / rate, abs=1e-9)


def test_zero_for_an_empty_or_reversed_range() -> None:
    ramp = [_point("a", 0.0, 2.0)]
    assert integrate_rate(ramp, 3.0, 3.0) == 0.0
    assert integrate_rate(ramp, 5.0, 1.0) == 0.0


def test_no_ramp_is_one_x() -> None:
    assert integrate_rate([], 0.0, 7.0) == 7.0
    assert rate_at([], 3.0) == 1.0


def test_additive_across_a_split_point_within_the_enforced_tolerance() -> None:
    # If it were not, splitting a ramped clip would change the total duration. The
    # assertion is against the tolerance the validator enforces (1e-6), not an exact
    # equality: no fixed quadrature is exactly additive, because splitting changes
    # the sampling grid.
    ramp = [_point("a", 0.0, 1.0), _point("b", 4.0, 3.0, "ease-in-out")]
    whole = integrate_rate(ramp, 0.0, 4.0)
    halves = integrate_rate(ramp, 0.0, 1.7) + integrate_rate(ramp, 1.7, 4.0)
    assert abs(halves - whole) < 1e-7


# ---------------------------------------------------------------------------
# rate_at / normalize_ramp
# ---------------------------------------------------------------------------


def test_rate_is_held_outside_the_curve_not_extrapolated() -> None:
    # Extrapolating a curve whose last two points accelerate would keep
    # accelerating past the end of the footage and could cross zero, which the
    # schema forbids for good reason. A held rate cannot.
    ramp = [_point("a", 2.0, 0.5), _point("b", 4.0, 4.0)]
    assert rate_at(ramp, 0.0) == 0.5
    assert rate_at(ramp, 100.0) == 4.0


def test_rate_interpolates_on_the_points_own_easing() -> None:
    linear = [_point("a", 0.0, 1.0), _point("b", 2.0, 3.0)]
    assert rate_at(linear, 1.0) == pytest.approx(2.0)
    # ease-in is t², so the midpoint is a quarter of the way up.
    ease_in = [_point("a", 0.0, 1.0, "ease-in"), _point("b", 2.0, 3.0)]
    assert rate_at(ease_in, 1.0) == pytest.approx(1.5)


def test_normalize_sorts_collapses_duplicates_and_drops_bad_rates() -> None:
    ramp = normalize_ramp([_point("c", 4.0, 1.0), _point("a", 0.0, 2.0), _point("b", 2.0, 3.0)])
    assert [p.id for p in ramp] == ["a", "b", "c"]
    # A curve cannot have two rates at one instant, and keeping both would make the
    # integral depend on list order.
    assert [p.id for p in normalize_ramp([_point("a", 2.0, 1.0), _point("dup", 2.0, 99.0)])] == [
        "a"
    ]
    # A non-positive rate makes the integral divergent.
    assert [p.id for p in normalize_ramp([_point("a", 0.0, 0.0), _point("b", 1.0, 2.0)])] == ["b"]


# ---------------------------------------------------------------------------
# Inversion
# ---------------------------------------------------------------------------


def test_source_time_at_round_trips_the_integral() -> None:
    ramp = [_point("a", 0.0, 1.0), _point("b", 3.0, 0.25, "ease-in-out"), _point("c", 6.0, 2.0)]
    for s in (0.4, 1.5, 3.0, 4.2, 5.9):
        timeline = integrate_rate(ramp, 0.0, s)
        assert source_time_at(ramp, 0.0, timeline, 6.0) == pytest.approx(s, abs=1e-6)


def test_source_time_at_clamps_at_the_end_of_the_footage() -> None:
    assert source_time_at([_point("a", 0.0, 1.0)], 0.0, 1e6, 6.0) == 6.0


def test_source_time_at_returns_the_start_for_a_non_positive_offset() -> None:
    assert source_time_at([_point("a", 0.0, 2.0)], 1.5, 0.0, 6.0) == 1.5
    assert source_time_at([_point("a", 0.0, 2.0)], 1.5, -3.0, 6.0) == 1.5


# ---------------------------------------------------------------------------
# Clip-level duration
# ---------------------------------------------------------------------------


def test_duration_divides_by_the_magnitude_so_reverse_takes_positive_time() -> None:
    assert clip_timeline_duration(_clip(sourceEnd=8.0, speed=2.0)) == 4.0
    assert clip_timeline_duration(_clip(sourceEnd=8.0, speed=-2.0)) == 4.0


def test_duration_is_none_for_a_freeze_because_none_is_derivable() -> None:
    # A held frame's length is SET, not derived. Inventing an expectation would make
    # every freeze frame fail the validator.
    assert clip_timeline_duration(_clip(speed=0.0)) is None


def test_a_ramp_wins_over_a_stale_constant_speed() -> None:
    ramped = _clip(
        sourceEnd=4.0,
        speed=8.0,
        speedRamp=[_point("a", 0.0, 2.0), _point("b", 4.0, 2.0)],
    )
    assert has_speed_ramp(ramped)
    assert clip_timeline_duration(ramped) == pytest.approx(2.0, abs=1e-9)


def test_source_span_for_duration_inverts_clip_timeline_duration() -> None:
    for speed in (0.5, 1.0, 2.0, -2.0):
        clip = _clip(sourceEnd=8.0, speed=speed)
        duration = clip_timeline_duration(clip)
        assert duration is not None
        assert source_span_for_duration(clip, 0.0, duration) == pytest.approx(8.0, abs=1e-6)


def test_a_freeze_consumes_no_footage_however_long_it_is_held() -> None:
    # Which is exactly what makes trimming a freeze frame safe.
    assert source_span_for_duration(_clip(speed=0.0), 0.0, 30.0) == 0.0


# ---------------------------------------------------------------------------
# Cross-language numeric parity
# ---------------------------------------------------------------------------


def _fixture() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(_FIXTURE.read_text())
    return loaded


def test_parity_fixture_is_not_vacuous() -> None:
    # A fixture that silently lost its cases would pass in both suites.
    data = _fixture()
    assert len(data["cases"]) > 200
    assert {case["fn"] for case in data["cases"]} == {"rateAt", "integrateRate", "sourceTimeAt"}


def test_matches_the_typescript_implementation_numerically() -> None:
    data = _fixture()
    curves = {
        name: [SpeedPoint(**point) for point in points] for name, points in data["curves"].items()
    }
    for case in data["cases"]:
        points = curves[case["curve"]]
        args = case["args"]
        if case["fn"] == "rateAt":
            actual = rate_at(points, args[0])
        elif case["fn"] == "integrateRate":
            actual = integrate_rate(points, args[0], args[1])
        else:
            actual = source_time_at(points, args[0], args[1], args[2])
        assert actual == pytest.approx(case["expected"], abs=1e-9), (
            f"{case['fn']} on {case['curve']} with {args}"
        )
