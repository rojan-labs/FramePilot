"""The pure half of ``tests/color_response_measure.py`` (#107): chains, predictions, the fit.

The rendering half needs real media and minutes of export time, so it is a script. What it
concludes rests entirely on this arithmetic, which is checked here against numbers that do
not come from the module itself: ffmpeg's own pure-red codes, and the constant
``color-solver.ts`` ships.
"""

from __future__ import annotations

import pytest

from tests.color_response_measure import (
    BT601_LIMITED,
    BT709_FULL,
    BT709_LIMITED,
    CHAINS,
    GRID,
    Chain,
    Planes,
    fit_clip,
    identify_encode_chain,
    neutral_patch_warmth_per_temperature,
    planes_from_rgb,
    predicted_planes,
    reexpress,
    rgb_from_planes,
)

_ANY = Planes(y=0, u=128, v=128, sat=0.1, y_low=40, y_high=200)


@pytest.mark.parametrize(
    ("chain", "codes"),
    [
        # What `ffmpeg -pix_fmt rgb24 ... -pix_fmt yuv420p` + signalstats reads for (255, 0, 0):
        # untagged output gets BT.601 limited (81, 90, 240); `-colorspace bt709` gets 709.
        (BT601_LIMITED, (81, 90, 240)),
        (BT709_LIMITED, (63, 102, 240)),
    ],
)
def test_pure_red_lands_on_ffmpegs_own_codes(chain: Chain, codes: tuple[int, int, int]) -> None:
    assert chain in CHAINS
    planes = planes_from_rgb((1.0, 0.0, 0.0), chain, _ANY)
    assert (round(planes.y), round(planes.u), round(planes.v)) == codes


def test_reexpress_round_trips_mean_rgb() -> None:
    source = Planes(y=110.0, u=121.0, v=137.0, sat=0.1, y_low=40, y_high=200)
    there = reexpress(source, BT709_LIMITED, BT601_LIMITED)
    back = reexpress(there, BT601_LIMITED, BT709_LIMITED)
    assert (back.y, back.u, back.v) == pytest.approx((source.y, source.u, source.v))
    assert rgb_from_planes(there, BT601_LIMITED) == pytest.approx(
        rgb_from_planes(source, BT709_LIMITED)
    )


def test_neutral_patch_reproduces_the_solvers_derivation_and_its_range_factor() -> None:
    # color-solver.ts derives 0.6936 on full-range BT.709; limited range is 224/255 of it.
    assert neutral_patch_warmth_per_temperature(BT709_FULL) == pytest.approx(0.6936, abs=1e-4)
    assert neutral_patch_warmth_per_temperature(BT709_LIMITED) == pytest.approx(
        0.6936 * 224 / 255, abs=1e-4
    )


@pytest.mark.parametrize("chain", CHAINS, ids=lambda chain: chain.name)
def test_the_red_probe_names_the_chain_that_wrote_it(chain: Chain) -> None:
    probe = planes_from_rgb((1.0, 0.0, 0.0), chain, _ANY)
    named, errors = identify_encode_chain(probe)
    assert named is chain
    # Separated by whole codes, not by noise: the reason the probe is a saturated patch.
    assert min(e for name, e in errors.items() if name != chain.name) > 5.0


def test_the_probe_reads_ffmpegs_untagged_encode_as_bt601_limited() -> None:
    measured = Planes(y=81.13, u=91.0, v=240.0, sat=0.0, y_low=81, y_high=81)
    assert identify_encode_chain(measured)[0] is BT601_LIMITED


def _synthetic_cells(ungraded: Planes) -> dict[str, list[tuple[float, Planes]]]:
    """A renderer that is exactly the derivation (no clipping), written through BT.601."""
    cells: dict[str, list[tuple[float, Planes]]] = {}
    for parameter, steps in GRID.items():
        cells[parameter] = []
        for value in steps:
            if parameter in ("temperature", "tint"):
                temperature = value if parameter == "temperature" else 0.0
                tint = value if parameter == "tint" else 0.0
                planes = predicted_planes(ungraded, BT601_LIMITED, temperature, tint)
            elif parameter == "exposure":
                # Exposure multiplies LIGHT; the limited-range floor stays where it is.
                light = (ungraded.y - 16) * 2**value
                planes = Planes(y=16 + light, u=128, v=128, sat=ungraded.sat, y_low=0, y_high=0)
            else:
                scale = 1 + value
                planes = Planes(
                    y=ungraded.y,
                    u=ungraded.u,
                    v=ungraded.v,
                    sat=ungraded.sat * scale,
                    y_low=ungraded.y - (ungraded.y - ungraded.y_low) * scale,
                    y_high=ungraded.y + (ungraded.y_high - ungraded.y) * scale,
                )
            cells[parameter].append((value, planes))
    return cells


def test_an_ideal_renderer_fits_at_efficiency_one_and_the_prediction_in_the_source_chain() -> None:
    source = Planes(y=104.0, u=133.0, v=126.0, sat=0.05, y_low=30, y_high=190)
    ungraded = reexpress(source, BT709_LIMITED, BT601_LIMITED)
    result = fit_clip("ideal", source, ungraded, _synthetic_cells(ungraded), BT601_LIMITED)
    assert result.encode_chain == BT601_LIMITED.name
    assert result.temperature_curve_efficiency == pytest.approx(1.0, abs=1e-9)
    assert result.tint_curve_efficiency == pytest.approx(1.0, abs=1e-9)
    # Linear in t with no clamp, so the fit IS the prediction.
    assert result.warmth_per_temperature_source_chain == pytest.approx(
        result.predicted_warmth_per_temperature_source_chain, rel=1e-3
    )
    assert result.exposure_response_light == pytest.approx(1.0, abs=1e-3)
    # Y/255 carries the +16 floor, so the ratio the solver reads understates a stop.
    assert result.exposure_response < 0.95
    assert result.contrast_response == pytest.approx(1.0, abs=1e-9)
    assert result.saturation_response == pytest.approx(1.0, abs=1e-9)
