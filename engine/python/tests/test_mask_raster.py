"""The exact mask rasteriser (MK2.1): coverage, flattening, distance feather, modes, quantise.

Byte-level agreement with the shipped vectors is ``test_mask_raster_vectors.py``; this file
pins the algorithm's behaviour and its exactness against independent references.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from framepilot_engine.render import mask_raster as mr


def _clipped_area(polygon: list[tuple[float, float]], x0: float, y0: float) -> float:
    """Area of ``polygon`` inside the unit pixel at ``(x0, y0)`` (Sutherland-Hodgman)."""
    points = list(polygon)
    for axis, bound, keep in ((0, x0, 1.0), (0, x0 + 1, -1.0), (1, y0, 1.0), (1, y0 + 1, -1.0)):
        if not points:
            return 0.0
        clipped: list[tuple[float, float]] = []
        for index, b in enumerate(points):
            a = points[index - 1]
            a_in = (a[axis] - bound) * keep >= 0
            b_in = (b[axis] - bound) * keep >= 0
            if a_in != b_in:
                t = (bound - a[axis]) / (b[axis] - a[axis])
                clipped.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
            if b_in:
                clipped.append(b)
        points = clipped
    twice = 0.0
    for index, b in enumerate(points):
        a = points[index - 1]
        twice += a[0] * b[1] - b[0] * a[1]
    return abs(twice) / 2.0


def _polyline(points: list[tuple[float, float]]) -> mr.Polyline:
    xs = [p[0] for p in points] + [points[0][0]]
    ys = [p[1] for p in points] + [points[0][1]]
    return mr.Polyline(np.asarray(xs), np.asarray(ys))


@pytest.mark.parametrize("seed", range(4))
def test_coverage_equals_the_exact_clipped_area(seed: int) -> None:
    rng = np.random.default_rng(seed)
    raw = rng.uniform(-4.0, 28.0, size=(6, 2))
    centre = raw.mean(axis=0)
    order = np.argsort(np.arctan2(raw[:, 1] - centre[1], raw[:, 0] - centre[0]))
    polygon = [(float(x), float(y)) for x, y in raw[order]]
    alpha = mr.coverage_alpha(_polyline(polygon), 24, 24)
    worst = max(
        abs(alpha[r, c] - _clipped_area(polygon, c, r)) for r in range(24) for c in range(24)
    )
    assert worst <= 4.0 / mr.Q16_ONE  # Q16.16 rounding only


def test_coverage_is_winding_independent_and_clamped() -> None:
    square = [(2.0, 2.0), (10.0, 2.0), (10.0, 10.0), (2.0, 10.0)]
    forward = mr.coverage_alpha(_polyline(square), 12, 12)
    backward = mr.coverage_alpha(_polyline(square[::-1]), 12, 12)
    assert forward.tobytes() == backward.tobytes()
    assert forward[5, 5] == 1.0 and forward[0, 0] == 0.0 and forward.max() == 1.0


def test_a_self_crossing_path_covers_both_lobes_exactly() -> None:
    """Nonzero rule: at a bowtie's crossing the two opposite-winding lobes both count."""
    bowtie = _polyline([(2.0, 2.0), (20.0, 14.5), (20.0, 2.0), (2.0, 14.5)])
    alpha = mr.coverage_alpha(bowtie, 24, 18)
    left = [(2.0, 2.0), (11.0, 8.25), (2.0, 14.5)]
    right = [(20.0, 2.0), (20.0, 14.5), (11.0, 8.25)]
    worst = max(
        abs(alpha[r, c] - (_clipped_area(left, c, r) + _clipped_area(right, c, r)))
        for r in range(18)
        for c in range(24)
    )
    assert worst <= 4.0 / mr.Q16_ONE


def test_a_path_overlapping_itself_counts_the_overlap_once() -> None:
    square = [(3.3, 2.6), (15.8, 2.6), (15.8, 11.4), (3.3, 11.4)]
    twice = _polyline(square + square)
    once = mr.coverage_alpha(_polyline(square), 20, 14)
    assert float(np.abs(mr.coverage_alpha(twice, 20, 14) - once).max()) <= 4.0 / mr.Q16_ONE


def test_exact_cell_coverage_matches_clipping_for_a_simple_cell() -> None:
    poly = _polyline([(0.2, 0.1), (0.9, 0.35), (0.6, 0.95)])
    x0, y0, x1, y1 = poly.xs[:-1], poly.ys[:-1], poly.xs[1:], poly.ys[1:]
    expected = _clipped_area([(0.2, 0.1), (0.9, 0.35), (0.6, 0.95)], 0, 0)
    assert mr.exact_cell_coverage(x0, y0, x1, y1, 0, 0) == pytest.approx(expected, abs=1e-15)


def test_shapes_extending_past_the_frame_fill_to_the_edges() -> None:
    alpha = mr.coverage_alpha(
        _polyline([(-5.0, -5.0), (50.0, -5.0), (50.0, 50.0), (-5.0, 50.0)]), 8, 6
    )
    assert np.array_equal(alpha, np.ones((6, 8)))


def test_flattening_stays_within_tolerance_of_the_curve() -> None:
    path = mr.ellipse_path(100.0, 80.0, 60.0, 40.0, 30.0)
    poly = mr.flatten_path(path)
    assert poly.xs[0] == poly.xs[-1] and poly.ys[0] == poly.ys[-1]
    # Every chord midpoint lies within the tolerance of the (Bezier) ellipse: check against
    # densely sampled curve points.
    samples = []
    for i, a in enumerate(path.vertices):
        b = path.vertices[(i + 1) % len(path.vertices)]
        for t in np.linspace(0.0, 1.0, 400):
            u = 1.0 - t
            x = (
                u**3 * a.x
                + 3 * u * u * t * (a.x + a.out_x)
                + 3 * u * t * t * (b.x + b.in_x)
                + t**3 * b.x
            )
            y = (
                u**3 * a.y
                + 3 * u * u * t * (a.y + a.out_y)
                + 3 * u * t * t * (b.y + b.in_y)
                + t**3 * b.y
            )
            samples.append((x, y))
    curve = np.asarray(samples)
    ax, ay = poly.xs[:-1], poly.ys[:-1]
    dx, dy = poly.xs[1:] - ax, poly.ys[1:] - ay
    worst = 0.0
    for px, py in curve:
        t = np.clip(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0.0, 1.0)
        nearest = np.sqrt((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2).min()
        worst = max(worst, float(nearest))
    assert worst <= mr.FLATTEN_TOLERANCE


def test_rotation_by_quarter_turns_is_exact() -> None:
    a = mr.rectangle_path(10.0, 20.0, 8.0, 4.0, 90.0)
    assert [(v.x, v.y) for v in a.vertices] == [
        (12.0, 16.0),
        (12.0, 24.0),
        (8.0, 24.0),
        (8.0, 16.0),
    ]


def test_roundness_one_is_a_stadium_whose_area_matches() -> None:
    poly = mr.flatten_path(mr.rectangle_path(20.0, 20.0, 30.0, 10.0, 0.0, 1.0))
    alpha = mr.coverage_alpha(poly, 40, 40)
    expected = 20.0 * 10.0 + math.pi * 25.0  # 30x10 stadium
    total = 0.0
    for row in alpha:  # ordered accumulation, as the determinism rules require
        for value in row:
            total += float(value)
    # Inscribed chords lose at most the tolerance along the curved perimeter (a 10 px circle).
    assert total == pytest.approx(expected, abs=math.pi * 10.0 * mr.FLATTEN_TOLERANCE)


def _brute_distance_alpha(
    poly: mr.Polyline, width: int, height: int, expansion: float, inner: float, outer: float
) -> np.ndarray:
    """Every pixel against every segment, no band: the reference for the banded version."""
    inside = mr.centre_inside(poly, width, height)
    out = np.zeros((height, width))
    for r in range(height):
        for c in range(width):
            px, py = c + 0.5, r + 0.5
            best = -math.inf
            for i in range(poly.xs.shape[0] - 1):
                ax, ay, bx, by = poly.xs[i], poly.ys[i], poly.xs[i + 1], poly.ys[i + 1]
                dx, dy = bx - ax, by - ay
                l2 = dx * dx + dy * dy
                t = 0.0 if l2 == 0 else min(max(((px - ax) * dx + (py - ay) * dy) / l2, 0.0), 1.0)
                d = math.hypot(px - ax - t * dx, py - ay - t * dy)
                s = (-d if inside[r, c] else d) - expansion
                w = (
                    outer
                    if poly.feathers is None
                    else float(poly.feathers[i] + (poly.feathers[i + 1] - poly.feathers[i]) * t)
                )
                x = 0.5 - s if inner + w == 0 else (w - s) / (inner + w)
                x = min(max(x, 0.0), 1.0)
                value = x if inner + w == 0 else x * x * (3 - 2 * x)
                best = max(best, -value if inside[r, c] else value)
            out[r, c] = -best if inside[r, c] else best
    return out


@pytest.mark.parametrize(
    ("expansion", "inner", "outer"),
    [(0.0, 0.0, 3.0), (2.5, 1.5, 0.0), (-1.5, 2.0, 4.0), (1.0, 0.0, 0.0)],
)
def test_banded_distance_feather_equals_the_unbanded_reference(
    expansion: float, inner: float, outer: float
) -> None:
    poly = mr.flatten_path(mr.ellipse_path(14.0, 12.0, 8.0, 6.0, 20.0))
    banded = mr.distance_alpha(
        poly,
        28,
        24,
        expansion=expansion,
        feather_inner=inner,
        feather_outer=outer,
        falloff="smooth",
    )
    reference = _brute_distance_alpha(poly, 28, 24, expansion, inner, outer)
    assert float(np.abs(banded - reference).max()) <= 1e-12


def test_per_vertex_feather_matches_the_unbanded_reference() -> None:
    path = mr.path_from_points(
        [4, 4, 0, 0, 0, 0, 20, 5, 0, 0, 0, 0, 18, 18, 0, 0, 0, 0, 5, 16, 0, 0, 0, 0],
        feathers=[0.0, 5.0, 2.0, 3.5],
    )
    poly = mr.flatten_path(path)
    banded = mr.distance_alpha(
        poly, 26, 24, expansion=0.0, feather_inner=1.0, feather_outer=0.0, falloff="smooth"
    )
    reference = _brute_distance_alpha(poly, 26, 24, 0.0, 1.0, 0.0)
    assert float(np.abs(banded - reference).max()) <= 1e-12


def test_modes_combine_as_documented() -> None:
    a = np.array([[0.0, 0.25, 0.75, 1.0]])
    m = np.array([[0.5, 0.5, 0.5, 0.5]])
    assert mr.combine(a, m, "add").tolist() == [[0.5, 0.75, 1.0, 1.0]]
    assert mr.combine(a, m, "subtract").tolist() == [[0.0, 0.0, 0.25, 0.5]]
    assert mr.combine(a, m, "intersect").tolist() == [[0.0, 0.125, 0.375, 0.5]]
    assert mr.combine(a, m, "difference").tolist() == [[0.5, 0.25, 0.25, 0.5]]
    assert mr.combine(a, m, "lighten").tolist() == [[0.5, 0.5, 0.75, 1.0]]
    assert mr.combine(a, m, "darken").tolist() == [[0.0, 0.25, 0.5, 0.5]]
    with pytest.raises(mr.MaskRasterError):
        mr.combine(a, m, "screen")


def test_invert_then_opacity_and_round_half_even_quantisation() -> None:
    alpha = np.array([[0.0, 1.0]])
    assert mr.layer_alpha(alpha, invert=True, opacity=0.5).tolist() == [[0.5, 0.0]]
    halves = np.array([[0.5 / 255, 1.5 / 255, 2.5 / 255, -1.0, 2.0]])
    assert mr.quantize_alpha(halves).tolist() == [[0, 2, 2, 0, 255]]


def test_the_shipped_gaussian_table_is_the_generated_one() -> None:
    """The shipped table still describes the documented curve.

    The renderer only ever READS the shipped data (``mask_falloff_gaussian.json``); it never
    calls ``exp`` per pixel. Regenerating uses the platform's libm, whose ``exp`` may differ in
    the last bit (measured on Windows), so this check allows 1e-15 and is not the byte gate:
    the byte-exact vectors in ``test_mask_raster_vectors.py`` are.
    """
    shipped = mr.gaussian_falloff_table()
    generated = np.asarray(mr.generate_gaussian_falloff_table())
    assert shipped.shape == generated.shape
    assert float(np.abs(shipped - generated).max()) <= 1e-15
    document = json.loads(mr._FALLOFF_TABLE_PATH.read_text(encoding="utf-8"))
    assert document["size"] == mr.FALLOFF_TABLE_SIZE
    assert document["k"] == mr.GAUSSIAN_FALLOFF_K
    assert document["encoding"] == "float64-le-base64"


def test_falloffs_are_monotone_and_pinned_at_the_ends() -> None:
    x = np.linspace(0.0, 1.0, 1001)
    for falloff in ("linear", "smooth", "gaussian"):
        y = mr.apply_falloff(x, falloff)
        assert y[0] == 0.0 and y[-1] == 1.0
        assert bool(np.all(np.diff(y) >= 0.0)), falloff


def test_hard_shapes_use_coverage_and_soft_shapes_use_distance() -> None:
    poly = mr.flatten_path(mr.rectangle_path(8.0, 8.0, 7.5, 7.5))
    hard = mr.shape_alpha(mr.ShapeRaster(poly), 16, 16)
    assert hard.tobytes() == mr.coverage_alpha(poly, 16, 16).tobytes()
    soft = mr.shape_alpha(mr.ShapeRaster(poly, feather_outer=2.0), 16, 16)
    assert soft[8, 8] == 1.0 and 0.0 < soft[8, 12] < 1.0


def test_malformed_paths_are_refused_with_a_remedy() -> None:
    with pytest.raises(mr.MaskRasterError, match="Redraw the path"):
        mr.path_from_points([0, 0, 0, 0, 0, 0])
    with pytest.raises(mr.MaskRasterError, match="Redraw the path"):
        mr.path_from_points([0.0] * 18, feathers=[1.0])
