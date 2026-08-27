"""The Python frame grid agrees with the TypeScript one, frame for frame (ADR 0146).

The TypeScript side owns the grid — it is what snaps an edit point when a patch is
committed. This suite exists so the render engine's copy can be trusted to *assert* that
grid rather than quietly re-implement it a rounding rule apart, which is exactly how a
preview and an export come to disagree about which frame a cut is on.

The fixture is generated from the TypeScript implementation
(``packages/editor-core/scripts/generate-frame-grid-parity.mjs``, run on every
editor-core build), so a change made on one side and forgotten on the other fails here
instead of shipping.
"""

from __future__ import annotations

import json
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.render.frame_grid import (
    frame_to_seconds,
    is_on_frame_grid,
    rational_frame_rate,
    seconds_to_frame,
    snap_seconds_to_frame,
)

FIXTURE = Path(__file__).parent / "fixtures" / "frame_grid_parity.json"


def _fixture() -> dict[str, Any]:
    if not FIXTURE.exists():  # pragma: no cover - build artefact must exist in CI
        pytest.fail(
            "frame_grid_parity.json is missing. Run `pnpm --filter @framepilot/editor-core build`."
        )
    loaded: dict[str, Any] = json.loads(FIXTURE.read_text())
    return loaded


def test_rational_rates_match_typescript() -> None:
    """23.976 is 24000/1001, not a float — and both runtimes must say so."""
    for rate in _fixture()["rates"]:
        expected = Fraction(rate["numerator"], rate["denominator"])
        assert rational_frame_rate(rate["fps"]) == expected, rate["fps"]


def test_every_sample_lands_on_the_same_frame() -> None:
    """The whole contract, sample by sample: same frame number, same snapped second."""
    for rate in _fixture()["rates"]:
        fps = rate["fps"]
        for sample in rate["samples"]:
            assert seconds_to_frame(sample["seconds"], fps) == sample["frame"], (
                f"{fps}fps {sample['seconds']}s"
            )
            assert snap_seconds_to_frame(sample["seconds"], fps) == pytest.approx(
                sample["snapped"], abs=1e-12
            ), f"{fps}fps {sample['seconds']}s"


def test_frame_to_seconds_matches_typescript() -> None:
    for rate in _fixture()["rates"]:
        for entry in rate["frameRoundTrip"]:
            assert frame_to_seconds(entry["frame"], rate["fps"]) == pytest.approx(
                entry["seconds"], abs=1e-12
            )


def test_ties_go_away_from_zero_not_to_even() -> None:
    """Python's built-in ``round`` is banker's rounding and would disagree with JS.

    At 2fps a frame is half a second, so 0.5s, 1.5s and 2.5s are all exact ties. Banker's
    rounding sends 1.5 to 2 and 2.5 to 2; the grid must send them to 2 and 3.
    """
    assert seconds_to_frame(0.25, 2) == 1
    assert seconds_to_frame(0.75, 2) == 2
    assert seconds_to_frame(1.25, 2) == 3
    assert round(2.5) == 2  # the trap this test exists to stay out of


def test_is_on_frame_grid_reports_legacy_times_honestly() -> None:
    """A pre-ADR-0146 project keeps off-grid times until an edit touches them."""
    assert is_on_frame_grid(1.0, 30)
    assert is_on_frame_grid(snap_seconds_to_frame(12.3874, 30), 30)
    assert not is_on_frame_grid(12.3874, 30)
