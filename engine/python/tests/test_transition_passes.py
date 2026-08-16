"""Transition passes — coverage, contract and the properties every kind must hold.

These are the checks that a per-kind eyeball cannot make across 29 passes. The
per-kind *look* is not asserted here (that belongs to golden media); what is
asserted is everything that, if wrong, makes a transition silently misbehave: an
alpha that never reaches 1, a kind with no pass, a NaN from a degenerate param.
"""

from __future__ import annotations

import numpy as np
import pytest

from framepilot_engine.render import transition_passes as passes
from framepilot_engine.render import transitions
from framepilot_engine.render.transition_catalog import known_kinds, load_catalog


@pytest.fixture
def frame() -> np.ndarray:
    """A synthetic frame with structure on both axes and a full tonal range.

    Structure matters: a flat frame would make a slide, a wipe and a dissolve all
    look identical, so every "this pass actually did something" assertion would
    pass for free.
    """
    ys, xs = np.meshgrid(np.linspace(0, 1, 48), np.linspace(0, 1, 64), indexing="ij")
    return np.stack([xs, ys, (xs + ys) * 0.5], axis=-1).astype(np.float32)


def _resolve(kind: str, **overrides: object) -> transitions.Transition:
    resolved = transitions.resolve_transition({"kind": kind, "durationSeconds": 0.5, **overrides})
    assert resolved is not None
    return resolved


ALL_IDS = sorted(load_catalog().transitions)


def test_every_render_kind_has_a_pass() -> None:
    # A kind with no pass renders as a hard cut while the preview animates it —
    # the worst failure mode here, because it only shows up after an export.
    assert set(known_kinds()) - passes.known_pass_kinds() == set()


def test_no_pass_for_a_kind_outside_the_catalog() -> None:
    assert passes.known_pass_kinds() - set(known_kinds()) == set()


@pytest.mark.parametrize("transition_id", ALL_IDS)
def test_pass_returns_a_well_formed_frame_and_alpha(transition_id: str, frame: np.ndarray) -> None:
    transition = _resolve(transition_id)
    for progress in (0.0, 0.25, 0.5, 0.75, 1.0):
        rgb, alpha = passes.apply_transition_to_frame(frame, transition, progress)
        assert rgb.shape == frame.shape
        assert alpha.shape == frame.shape[:2]
        assert rgb.dtype == np.float32
        assert np.isfinite(rgb).all(), f"{transition_id} produced a non-finite pixel"
        assert np.isfinite(alpha).all(), f"{transition_id} produced a non-finite alpha"
        assert float(rgb.min()) >= 0.0 and float(rgb.max()) <= 1.0
        assert float(alpha.min()) >= 0.0 and float(alpha.max()) <= 1.0


@pytest.mark.parametrize("transition_id", ALL_IDS)
def test_every_transition_completes(transition_id: str, frame: np.ndarray) -> None:
    """At progress 1 the incoming shot must be whole and untouched.

    This is the property that makes a transition a transition rather than a look:
    whatever it does in the middle, it has to end with the next shot on screen,
    fully opaque, with none of the treatment left. A pass that ends at alpha 0.999
    leaves a permanently ghosted first frame nobody can explain.
    """
    transition = _resolve(transition_id)
    rgb, alpha = passes.apply_transition_to_frame(frame, transition, 1.0)
    assert float(alpha.min()) == pytest.approx(1.0, abs=1e-4), transition_id
    assert np.allclose(rgb, frame, atol=2e-3), transition_id


@pytest.mark.parametrize("transition_id", ALL_IDS)
def test_every_transition_does_something_in_the_middle(
    transition_id: str, frame: np.ndarray
) -> None:
    """Half way through, a transition must differ from the finished shot.

    A pass that is a no-op at 0.5 is a transition that renders as a cut — exactly
    what this catalog exists to stop happening quietly.
    """
    entry = load_catalog().transitions[transition_id]
    if entry.is_cut:
        pytest.skip("the hard cut is the one entry that is meant to do nothing")
    transition = _resolve(transition_id)
    rgb, alpha = passes.apply_transition_to_frame(frame, transition, 0.5)
    changed = not np.allclose(rgb, frame, atol=1e-3) or float(alpha.min()) < 0.999
    assert changed, f"{transition_id} is a no-op halfway through"


def test_unknown_render_kind_degrades_to_a_cut(frame: np.ndarray) -> None:
    # A project from a newer build must render, not abort.
    unknown = transitions.Transition(kind="future", duration=1.0, render_kind="teleport")
    rgb, alpha = passes.apply_transition_to_frame(frame, unknown, 0.5)
    assert np.array_equal(rgb, frame)
    assert float(alpha.min()) == 1.0


def test_a_pass_that_raises_degrades_to_a_cut(frame: np.ndarray) -> None:
    def explode(
        _frame: np.ndarray, _ctx: passes.TransitionContext
    ) -> tuple[np.ndarray, np.ndarray]:
        raise RuntimeError("boom")

    passes.PASSES["__test_explode__"] = explode
    try:
        broken = transitions.Transition(kind="x", duration=1.0, render_kind="__test_explode__")
        rgb, alpha = passes.apply_transition_to_frame(frame, broken, 0.5)
        assert np.array_equal(rgb, frame)
        assert float(alpha.min()) == 1.0
    finally:
        del passes.PASSES["__test_explode__"]


def test_direction_reverses_a_slide(frame: np.ndarray) -> None:
    """The two directions must not produce the same picture.

    The bug this catches is a direction vector that is dropped on the way to the
    pass — everything still renders, and every "Push Right" in the library is
    silently a Push Left.
    """
    left = passes.apply_transition_to_frame(frame, _resolve("push"), 0.3)[0]
    right = passes.apply_transition_to_frame(frame, _resolve("push-right"), 0.3)[0]
    assert not np.allclose(left, right, atol=1e-2)


def test_up_and_down_differ_on_the_vertical_axis(frame: np.ndarray) -> None:
    up = passes.apply_transition_to_frame(frame, _resolve("push-up"), 0.3)[0]
    down = passes.apply_transition_to_frame(frame, _resolve("push-down"), 0.3)[0]
    assert not np.allclose(up, down, atol=1e-2)


def test_intensity_scales_how_far_a_transition_travels(frame: np.ndarray) -> None:
    full = passes.apply_transition_to_frame(frame, _resolve("push", intensity=1.0), 0.2)[0]
    half = passes.apply_transition_to_frame(frame, _resolve("push", intensity=0.2), 0.2)[0]
    # A gentler push is closer to the settled frame than a full one.
    assert np.abs(half - frame).mean() < np.abs(full - frame).mean()


def test_a_wipe_reveals_from_its_own_side(frame: np.ndarray) -> None:
    _, alpha = passes.apply_transition_to_frame(frame, _resolve("wipe"), 0.3)
    # `wipe` sweeps left → right, so the left edge is revealed and the right is not.
    assert float(alpha[:, 0].mean()) > 0.9
    assert float(alpha[:, -1].mean()) < 0.1
    _, mirrored = passes.apply_transition_to_frame(frame, _resolve("wipe-left"), 0.3)
    assert float(mirrored[:, -1].mean()) > 0.9
    assert float(mirrored[:, 0].mean()) < 0.1


def test_a_wipe_up_reveals_the_bottom_first(frame: np.ndarray) -> None:
    # The y-flip between screen space and the passes' UV space is the single
    # easiest thing to get backwards, and nothing else would catch it.
    _, alpha = passes.apply_transition_to_frame(frame, _resolve("wipe-up"), 0.3)
    assert float(alpha[-1, :].mean()) > 0.9, "the bottom row should arrive first"
    assert float(alpha[0, :].mean()) < 0.1


def test_softness_widens_the_wipe_edge(frame: np.ndarray) -> None:
    hard = passes.apply_transition_to_frame(frame, _resolve("wipe", softness=0.05), 0.5)[1]
    soft = passes.apply_transition_to_frame(frame, _resolve("soft-wipe"), 0.5)[1]
    # A wider feather means more pixels sit strictly between transparent and opaque.
    def between(a: np.ndarray) -> int:
        return int(((a > 0.02) & (a < 0.98)).sum())

    assert between(soft) > between(hard)


def test_pixel_dissolve_holds_its_arrangement_still(frame: np.ndarray) -> None:
    """Blocks that have arrived must not leave again.

    Deriving the order from a clock rather than from a stable hash makes the
    dissolve re-roll every frame and read as static; this asserts monotonicity,
    which a re-rolling field cannot satisfy.
    """
    transition = _resolve("pixel-dissolve")
    early = passes.apply_transition_to_frame(frame, transition, 0.3)[1]
    later = passes.apply_transition_to_frame(frame, transition, 0.6)[1]
    assert bool((later >= early).all())


def test_seed_changes_the_arrangement_but_not_the_coverage(frame: np.ndarray) -> None:
    # Small blocks, so the two fields have enough cells for their coverage to be
    # comparable — at the catalog's 24px default a 64x48 frame holds six.
    a = passes.apply_transition_to_frame(frame, _resolve("pixel-dissolve", seed=1, blockPx=3), 0.5)[
        1
    ]
    b = passes.apply_transition_to_frame(frame, _resolve("pixel-dissolve", seed=9, blockPx=3), 0.5)[
        1
    ]
    assert not np.array_equal(a, b)
    assert float(a.mean()) == pytest.approx(float(b.mean()), abs=0.12)


def test_flash_adds_light_where_a_dip_removes_it(frame: np.ndarray) -> None:
    flash = passes.apply_transition_to_frame(frame, _resolve("flash"), 0.0)[0]
    dip = passes.apply_transition_to_frame(frame, _resolve("dip-to-black"), 0.0)[0]
    assert float(flash.mean()) > float(frame.mean())
    assert float(dip.mean()) < float(frame.mean())


def test_easing_reshapes_progress_without_moving_the_ends() -> None:
    transition = _resolve("cross-dissolve", easing="ease-in-out")
    assert transitions.ease(transition, 0.0) == pytest.approx(0.0)
    assert transitions.ease(transition, 1.0) == pytest.approx(1.0)
    assert transitions.ease(transition, 0.25) < 0.25
    # Out-of-range progress is clamped rather than extrapolated.
    assert transitions.ease(transition, 4.0) == pytest.approx(1.0)
