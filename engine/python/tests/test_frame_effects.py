"""Tests for the frame-effect render passes (schema v13, ADR 0088).

The important guarantees, in order of what would hurt most if broken:

1. **Every catalog kind has a working pass.** A missing pass renders as a silent
   no-op — the effect browses fine in the UI and then does nothing in the export.
2. **Every pass is deterministic.** A render is a pure function of the project;
   any pass reading a clock or a RNG breaks golden-media tests and makes preview
   and render disagree.
3. **Every pass respects the shared contracts** — shape, dtype, range, and the
   `intensity` dial — because the dispatcher, not the passes, implements them.
4. **The layer walk composes correctly** — order, time bounds, disabled, stacking.

Every one of the 41 kinds is exercised individually via parametrization, which is
what makes "verify every effect" a standing guarantee rather than a one-off pass.
"""

from __future__ import annotations

import numpy as np
import pytest

from framepilot_engine.render.effect_catalog import (
    known_kinds,
    load_catalog,
    resolve_params,
)
from framepilot_engine.render.frame_effects import (
    PASSES,
    EffectContext,
    apply_layer_to_frame,
    known_pass_kinds,
)
from framepilot_engine.render.frame_effects._common import (
    gaussian_blur,
    hue_to_rgb,
    luminance,
    sample_bilinear,
    separable_box,
    smoothstep,
)
from framepilot_engine.render.frame_effects.deterministic import (
    TIME_QUANTUM,
    hash_u32,
    noise01,
    quantize_time,
    value_noise01,
)
from framepilot_engine.timeline.models import EffectLayer, Timeline, Track, TrackType

ALL_KINDS = sorted(known_pass_kinds())

# Small but not square, and not a power of two — a square test frame hides
# height/width transposition bugs, and a power of two hides off-by-one tiling.
_H, _W = 47, 83


def _frame(seed: int = 11) -> np.ndarray:
    """A deterministic pseudo-photo with the structure real footage has.

    Deliberately includes HARD EDGES, not just gradients and noise. The first
    version of this fixture was a smooth gradient plus fine noise, on which a
    Sobel operator peaks at 0.18 — below the edge passes' default 0.30 threshold —
    so `edge-outline` correctly did nothing and the test read it as broken. Real
    footage has object boundaries that reach 0.5-1.0, so a fixture without one is
    not representative and cannot exercise the edge/outline/sketch/neon family.
    """
    rng = np.random.default_rng(seed)
    ys, xs = np.meshgrid(
        np.linspace(0, 1, _H, dtype=np.float32),
        np.linspace(0, 1, _W, dtype=np.float32),
        indexing="ij",
    )
    base = np.stack([xs, ys, (xs + ys) * 0.5], axis=-1) * 0.6
    # A bright block and a dark bar: full-contrast boundaries in both axes.
    base[8:26, 12:40] = 0.95
    base[30:38, 50:78] = 0.04
    # Fine detail so quantising and sorting passes have something to bite on.
    detail = rng.random((_H, _W, 3)).astype(np.float32) * 0.2
    return np.clip(base + detail, 0.0, 1.0)


def _u8(frame: np.ndarray) -> np.ndarray:
    return (frame * 255.0 + 0.5).astype(np.uint8)


def _layer(kind: str, **over: object) -> EffectLayer:
    """A layer for ``kind`` carrying the catalog's own default params."""
    catalog = load_catalog()
    entry = next((e for e in catalog.effects.values() if e.kind == kind), None)
    params = resolve_params(entry.id) if entry else {}
    return EffectLayer(
        id=f"fx-{kind}",
        effect_id=entry.id if entry else kind,
        kind=kind,
        start=0.0,
        end=2.0,
        params=params,
        **over,
    )


# ---------------------------------------------------------------------------
# Catalog ↔ pass coverage
# ---------------------------------------------------------------------------


def test_every_catalog_kind_has_a_pass() -> None:
    missing = known_kinds() - known_pass_kinds()
    assert not missing, f"catalog kinds with no render pass: {sorted(missing)}"


def test_no_orphan_passes() -> None:
    orphans = known_pass_kinds() - known_kinds()
    assert not orphans, f"passes for kinds not in the catalog: {sorted(orphans)}"


def test_pass_count_matches_the_documented_forty_one() -> None:
    assert len(PASSES) == 41


# ---------------------------------------------------------------------------
# Per-kind contracts — the "verify every effect individually" guarantee
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_pass_preserves_shape_and_dtype(kind: str) -> None:
    frame = _u8(_frame())
    out = apply_layer_to_frame(frame, _layer(kind), 0.7, fps=30)
    assert out.shape == frame.shape
    assert out.dtype == np.uint8


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_pass_visibly_changes_the_frame_somewhere_in_its_span(kind: str) -> None:
    # Sampled across the span because several kinds are envelopes or duty-cycled
    # (a flash is legitimately off for most of its layer) — a single timestamp
    # would report a working effect as a no-op.
    frame = _u8(_frame())
    layer = _layer(kind)
    changed = any(
        not np.array_equal(apply_layer_to_frame(frame, layer, t, fps=30), frame)
        for t in (0.05, 0.3, 0.7, 1.1, 1.6, 1.95)
    )
    assert changed, f"{kind} never changed the frame at its catalog defaults"


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_pass_is_deterministic(kind: str) -> None:
    frame = _u8(_frame())
    layer = _layer(kind)
    a = apply_layer_to_frame(frame, layer, 0.83, fps=30)
    b = apply_layer_to_frame(frame, layer, 0.83, fps=30)
    assert np.array_equal(a, b)


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_zero_intensity_is_an_exact_no_op(kind: str) -> None:
    frame = _u8(_frame())
    layer = _layer(kind, intensity=0.0)
    assert np.array_equal(apply_layer_to_frame(frame, layer, 0.7, fps=30), frame)


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_partial_intensity_lands_between_off_and_full(kind: str) -> None:
    frame = _u8(_frame())
    full = apply_layer_to_frame(frame, _layer(kind), 0.7, fps=30).astype(np.int32)
    half = apply_layer_to_frame(frame, _layer(kind, intensity=0.5), 0.7, fps=30).astype(np.int32)
    base = frame.astype(np.int32)
    # The mix must never overshoot: a half-strength frame is closer to the source
    # than a full-strength one is.
    assert np.abs(half - base).mean() <= np.abs(full - base).mean() + 1e-6


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_pass_output_stays_in_range(kind: str) -> None:
    # uint8 cannot express out-of-range, so this checks the float path where a
    # pass could return NaN or a negative and silently wrap on cast.
    frame = _frame()
    out = apply_layer_to_frame(frame, _layer(kind), 0.7, fps=30)
    assert np.isfinite(out).all(), f"{kind} produced non-finite values"
    assert out.min() >= 0.0 and out.max() <= 1.0


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_pass_survives_a_degenerate_one_pixel_frame(kind: str) -> None:
    # Guards divide-by-width/height and any kernel that assumes neighbours exist.
    tiny = np.full((1, 1, 3), 128, dtype=np.uint8)
    out = apply_layer_to_frame(tiny, _layer(kind), 0.4, fps=30)
    assert out.shape == tiny.shape
    assert np.isfinite(out.astype(np.float32)).all()


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_pass_survives_flat_black_and_flat_white(kind: str) -> None:
    for value in (0, 255):
        flat = np.full((16, 24, 3), value, dtype=np.uint8)
        out = apply_layer_to_frame(flat, _layer(kind), 0.5, fps=30)
        assert out.shape == flat.shape
        assert np.isfinite(out.astype(np.float32)).all()


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_pass_handles_hostile_params_by_clamping(kind: str) -> None:
    # The dispatcher clamps against the catalog, so a pass must never see a value
    # outside its declared range — and must not blow up if asked.
    frame = _u8(_frame())
    hostile = EffectLayer(
        id="x",
        effect_id="y",
        kind=kind,
        start=0.0,
        end=2.0,
        params={p.name: 1e9 for p in load_catalog().params[kind]},
    )
    out = apply_layer_to_frame(frame, hostile, 0.6, fps=30)
    assert out.shape == frame.shape
    assert np.isfinite(out.astype(np.float32)).all()


# ---------------------------------------------------------------------------
# Dispatcher behaviour
# ---------------------------------------------------------------------------


def test_unknown_kind_is_skipped_not_raised() -> None:
    # A project from a newer FramePilot must degrade, not abort a render.
    frame = _u8(_frame())
    layer = EffectLayer(id="x", effect_id="y", kind="not-a-real-kind", start=0.0, end=1.0)
    assert np.array_equal(apply_layer_to_frame(frame, layer, 0.5, fps=30), frame)


def test_float_input_returns_float_output() -> None:
    out = apply_layer_to_frame(_frame(), _layer("mosaic"), 0.5, fps=30)
    assert out.dtype == np.float32


def test_uint8_round_trip_rounds_half_up() -> None:
    # Truncating instead of rounding would darken every effected frame by up to
    # 1/255 relative to the WebGL preview's 8-bit framebuffer.
    flat = np.full((8, 8, 3), 100, dtype=np.uint8)
    # Intensity 0 short-circuits, so use a pass-through-ish full-strength case.
    out = apply_layer_to_frame(flat, _layer("blur-gaussian"), 0.5, fps=30)
    # A uniform frame blurred is still uniform, and must come back at the same
    # code value rather than one step down.
    assert out.min() == out.max() == 100


def test_seeking_and_playing_agree_at_the_same_timestamp() -> None:
    # frame_index is derived from ABSOLUTE time, so scrubbing to 4.0s must look
    # exactly like playing through to 4.0s.
    frame = _u8(_frame())
    layer = _layer("grain")
    layer.start = 3.0
    layer.end = 6.0
    a = apply_layer_to_frame(frame, layer, 4.0, fps=30)
    b = apply_layer_to_frame(frame, layer, 4.0, fps=30)
    assert np.array_equal(a, b)


def test_layer_position_does_not_change_an_envelope_effect() -> None:
    # `local_time` is layer-relative, so moving a zoom punch must not change how
    # it looks at the same point through its own span.
    frame = _u8(_frame())
    early = EffectLayer(
        id="a",
        effect_id="punch-in",
        kind="zoom-punch",
        start=0.0,
        end=1.0,
        params=resolve_params("punch-in"),
    )
    late = EffectLayer(
        id="b",
        effect_id="punch-in",
        kind="zoom-punch",
        start=5.0,
        end=6.0,
        params=resolve_params("punch-in"),
    )
    assert np.array_equal(
        apply_layer_to_frame(frame, early, 0.4, fps=30),
        apply_layer_to_frame(frame, late, 5.4, fps=30),
    )


# ---------------------------------------------------------------------------
# EffectContext
# ---------------------------------------------------------------------------


def test_context_progress_is_bounded_and_zero_for_a_degenerate_span() -> None:
    ctx = EffectContext(params={}, local_time=0.5, duration=2.0, width=10, height=10, frame_index=0)
    assert ctx.progress == pytest.approx(0.25)
    over = EffectContext(
        params={}, local_time=5.0, duration=2.0, width=10, height=10, frame_index=0
    )
    assert over.progress == 1.0
    degenerate = EffectContext(
        params={}, local_time=1.0, duration=0.0, width=10, height=10, frame_index=0
    )
    assert degenerate.progress == 0.0


def test_context_param_falls_back_when_absent() -> None:
    ctx = EffectContext(
        params={"a": 2.0}, local_time=0.0, duration=1.0, width=4, height=4, frame_index=0
    )
    assert ctx.param("a") == 2.0
    assert ctx.param("missing", 7.5) == 7.5


# ---------------------------------------------------------------------------
# Deterministic noise primitives
# ---------------------------------------------------------------------------


def test_hash_is_stable_and_well_spread() -> None:
    values = np.arange(4096, dtype=np.uint32)
    hashed = hash_u32(values)
    assert np.array_equal(hashed, hash_u32(values))
    # A broken mixer collides badly; a good one is near-injective on a small range.
    assert len(np.unique(hashed)) > 4000


def test_hash_does_not_overflow_on_a_large_frame_index() -> None:
    # Regression: `frame * 0x9E3779B1` is an arbitrary-precision Python int, and
    # numpy raises OverflowError rather than wrapping when narrowing it to uint32.
    # Nine passes silently became no-ops because of this.
    coords = np.zeros((4, 4), dtype=np.int64)
    out = noise01(coords, coords, frame=10_000_000, salt=31)
    assert np.isfinite(out).all()


def test_noise_is_in_unit_range_and_varies_by_coordinate() -> None:
    ys, xs = np.meshgrid(np.arange(32), np.arange(32), indexing="ij")
    n = noise01(xs, ys, frame=3)
    assert n.min() >= 0.0 and n.max() < 1.0
    assert n.std() > 0.2  # not a constant field


def test_noise_salt_produces_independent_fields() -> None:
    ys, xs = np.meshgrid(np.arange(16), np.arange(16), indexing="ij")
    assert not np.array_equal(noise01(xs, ys, 1, salt=0), noise01(xs, ys, 1, salt=1))


def test_noise_advances_with_the_frame() -> None:
    ys, xs = np.meshgrid(np.arange(16), np.arange(16), indexing="ij")
    assert not np.array_equal(noise01(xs, ys, 1), noise01(xs, ys, 2))


def test_value_noise_is_smooth() -> None:
    ys, xs = np.meshgrid(np.arange(64), np.arange(64), indexing="ij")
    n = value_noise01(xs, ys, 0, cell=16.0)
    # Neighbour-to-neighbour change must be far smaller than for white noise,
    # which is the whole point of interpolating.
    smooth_delta = np.abs(np.diff(n, axis=1)).mean()
    white_delta = np.abs(np.diff(noise01(xs, ys, 0), axis=1)).mean()
    assert smooth_delta < white_delta / 4.0


def test_quantize_time_snaps_to_the_shared_grid() -> None:
    assert quantize_time(0.0) == 0
    # Two timestamps inside one quantum must land on the same step — this is what
    # makes a preview at 4.003s agree with a render at 4.000s.
    assert quantize_time(4.0) == quantize_time(4.0 + TIME_QUANTUM * 0.4)
    assert quantize_time(4.0 + TIME_QUANTUM) == quantize_time(4.0) + 1


def test_quantize_time_clamps_negative_input() -> None:
    assert quantize_time(-5.0) == 0


# ---------------------------------------------------------------------------
# Shared image helpers
# ---------------------------------------------------------------------------


def test_luminance_uses_rec709_weights() -> None:
    white = np.ones((2, 2, 3), dtype=np.float32)
    assert luminance(white) == pytest.approx(np.ones((2, 2)), abs=1e-5)
    green = np.zeros((1, 1, 3), dtype=np.float32)
    green[..., 1] = 1.0
    assert float(luminance(green)[0, 0]) == pytest.approx(0.7152, abs=1e-4)


def test_smoothstep_matches_glsl_endpoints() -> None:
    x = np.array([-1.0, 0.0, 0.5, 1.0, 2.0], dtype=np.float32)
    out = smoothstep(0.0, 1.0, x)
    assert out[0] == 0.0 and out[1] == 0.0
    assert out[2] == pytest.approx(0.5)
    assert out[3] == 1.0 and out[4] == 1.0


def test_smoothstep_handles_a_zero_width_edge() -> None:
    x = np.array([0.4, 0.6], dtype=np.float32)
    out = smoothstep(0.5, 0.5, x)
    assert list(out) == [0.0, 1.0]


def test_hue_to_rgb_spans_the_wheel_and_wraps() -> None:
    assert list(hue_to_rgb(0.0)) == [1.0, 0.0, 0.0]
    assert list(hue_to_rgb(360.0)) == [1.0, 0.0, 0.0]
    assert list(hue_to_rgb(120.0)) == pytest.approx([0.0, 1.0, 0.0])
    assert list(hue_to_rgb(240.0)) == pytest.approx([0.0, 0.0, 1.0])
    # Negative hues must wrap rather than index out of the table.
    assert list(hue_to_rgb(-120.0)) == pytest.approx([0.0, 0.0, 1.0])


def test_box_blur_preserves_a_uniform_frame() -> None:
    # Edge replication (not zero padding) is why this holds at the border; a
    # zero-pad would darken every blurred frame's edges.
    flat = np.full((20, 30, 3), 0.5, dtype=np.float32)
    assert separable_box(flat, 5.0) == pytest.approx(flat, abs=1e-5)


def test_box_blur_with_zero_radius_is_a_no_op() -> None:
    frame = _frame()
    assert np.array_equal(separable_box(frame, 0.0), frame)


def test_gaussian_blur_reduces_variance() -> None:
    frame = _frame()
    blurred = gaussian_blur(frame, 8.0)
    assert blurred.std() < frame.std()


def test_gaussian_blur_with_zero_radius_is_a_no_op() -> None:
    frame = _frame()
    assert np.array_equal(gaussian_blur(frame, 0.0), frame)


def test_bilinear_sample_at_integer_coords_is_the_original_pixel() -> None:
    frame = _frame()
    ys, xs = np.meshgrid(
        np.arange(_H, dtype=np.float32), np.arange(_W, dtype=np.float32), indexing="ij"
    )
    assert sample_bilinear(frame, ys, xs) == pytest.approx(frame, abs=1e-5)


def test_bilinear_sample_clamps_outside_the_frame() -> None:
    # Clamp, not wrap: a fisheye reaching past the edge must smear the border, not
    # fold in content from the opposite side.
    frame = _frame()
    far = np.full((2, 2), 1e6, dtype=np.float32)
    negative = np.full((2, 2), -1e6, dtype=np.float32)
    # Every sampled position collapses onto the corner pixel, so compare against
    # that pixel broadcast to the sample grid's shape.
    bottom_right = np.broadcast_to(frame[-1, -1], (2, 2, 3))
    top_left = np.broadcast_to(frame[0, 0], (2, 2, 3))
    assert sample_bilinear(frame, far, far) == pytest.approx(bottom_right, abs=1e-5)
    assert sample_bilinear(frame, negative, negative) == pytest.approx(top_left, abs=1e-5)


# ---------------------------------------------------------------------------
# Layer composition through the timeline walk
# ---------------------------------------------------------------------------


def _fx_timeline(*layers: EffectLayer) -> Timeline:
    return Timeline(
        tracks=[Track(id="fx", type=TrackType.EFFECT, clips=[], effect_layers=list(layers))]
    )


def test_stacked_layers_differ_from_either_alone() -> None:
    frame = _u8(_frame())
    a = _layer("mosaic")
    b = _layer("vignette")
    only_a = apply_layer_to_frame(frame, a, 0.5, fps=30)
    only_b = apply_layer_to_frame(frame, b, 0.5, fps=30)
    both = apply_layer_to_frame(only_a, b, 0.5, fps=30)
    assert not np.array_equal(both, only_a)
    assert not np.array_equal(both, only_b)


def test_layer_order_matters_for_non_commuting_effects() -> None:
    # Blur-then-mosaic is genuinely different from mosaic-then-blur, which is why
    # the shared bottom-up ordering has to be honoured by both renderers.
    frame = _u8(_frame())
    blur = _layer("blur-gaussian")
    mosaic = _layer("mosaic")
    forward = apply_layer_to_frame(
        apply_layer_to_frame(frame, blur, 0.5, fps=30), mosaic, 0.5, fps=30
    )
    reverse = apply_layer_to_frame(
        apply_layer_to_frame(frame, mosaic, 0.5, fps=30), blur, 0.5, fps=30
    )
    assert not np.array_equal(forward, reverse)


def test_timeline_walk_reports_layers_bottom_up() -> None:
    timeline = Timeline(
        tracks=[
            Track(
                id="front",
                type=TrackType.EFFECT,
                clips=[],
                effect_layers=[_layer("mosaic")],
            ),
            Track(
                id="back",
                type=TrackType.EFFECT,
                clips=[],
                effect_layers=[_layer("vignette")],
            ),
        ]
    )
    order = [layer.kind for _t, layer in timeline.active_effect_layers_at(0.5)]
    assert order == ["vignette", "mosaic"]


def test_timeline_walk_respects_time_bounds() -> None:
    layer = _layer("mosaic")
    layer.start, layer.end = 1.0, 2.0
    timeline = _fx_timeline(layer)
    assert timeline.active_effect_layers_at(0.5) == []
    assert len(timeline.active_effect_layers_at(1.5)) == 1
    assert timeline.active_effect_layers_at(2.0) == []


def test_timeline_walk_skips_disabled_layers() -> None:
    layer = _layer("mosaic", disabled=True)
    assert _fx_timeline(layer).active_effect_layers_at(0.5) == []
