"""Tests for deterministic color grading + .cube LUT (PRD §6.7, plan Phase 6)."""

from __future__ import annotations

import numpy as np
import pytest

from framepilot_engine.render.color import (
    ColorGrade,
    CubeLut,
    apply_color_grade,
    apply_lut,
    color_grade_from_params,
    parse_cube_lut,
)

W, H = 8, 8


def _solid(r: int, g: int, b: int) -> np.ndarray:
    frame = np.zeros((H, W, 3), dtype=np.uint8)
    frame[..., 0] = r
    frame[..., 1] = g
    frame[..., 2] = b
    return frame


# --- ColorGrade construction -------------------------------------------------


def test_identity_grade_is_a_noop() -> None:
    grade = ColorGrade()
    assert grade.is_identity
    frame = _solid(100, 120, 140)
    out = apply_color_grade(frame, grade)
    assert out is frame  # untouched fast-path


def test_from_params_reads_signed_offsets_and_defaults() -> None:
    grade = color_grade_from_params({"temperature": 0.2, "saturation": 0.1})
    assert grade.temperature == pytest.approx(0.2)
    assert grade.saturation == pytest.approx(0.1)
    assert grade.exposure == 0.0 and grade.contrast == 0.0  # unspecified → identity


def test_from_params_ignores_non_numeric() -> None:
    grade = color_grade_from_params({"exposure": None, "contrast": "nope"})
    assert grade.is_identity


# --- parametric grade behavior ----------------------------------------------


def test_bw_grade_desaturates_to_equal_channels() -> None:
    out = apply_color_grade(_solid(200, 100, 50), ColorGrade(saturation=-1.0))
    r, g, b = (int(out[0, 0, c]) for c in range(3))
    assert r == g == b  # fully desaturated → gray


def test_warm_temperature_raises_red_lowers_blue() -> None:
    base = _solid(120, 120, 120)
    out = apply_color_grade(base, ColorGrade(temperature=0.3))
    assert int(out[0, 0, 0]) > 120  # red up
    assert int(out[0, 0, 2]) < 120  # blue down


def test_tint_pushes_green() -> None:
    out = apply_color_grade(_solid(120, 120, 120), ColorGrade(tint=0.3))
    assert int(out[0, 0, 1]) > 120


def test_exposure_brightens() -> None:
    out = apply_color_grade(_solid(80, 80, 80), ColorGrade(exposure=0.5))
    assert int(out[0, 0, 0]) > 80


def test_contrast_pushes_away_from_mid_gray() -> None:
    dark = apply_color_grade(_solid(60, 60, 60), ColorGrade(contrast=0.5))
    bright = apply_color_grade(_solid(200, 200, 200), ColorGrade(contrast=0.5))
    assert int(dark[0, 0, 0]) < 60  # below mid → darker
    assert int(bright[0, 0, 0]) > 200  # above mid → brighter


def test_shadows_lift_darks_more_than_brights() -> None:
    grade = ColorGrade(shadows=0.5)
    dark = apply_color_grade(_solid(20, 20, 20), grade)
    bright = apply_color_grade(_solid(230, 230, 230), grade)
    assert int(dark[0, 0, 0]) - 20 > int(bright[0, 0, 0]) - 230


def test_highlights_lift_brights_more_than_darks() -> None:
    grade = ColorGrade(highlights=0.3)
    dark = apply_color_grade(_solid(20, 20, 20), grade)
    bright = apply_color_grade(_solid(200, 200, 200), grade)
    assert int(bright[0, 0, 0]) - 200 > int(dark[0, 0, 0]) - 20


def test_output_is_clamped_uint8() -> None:
    out = apply_color_grade(_solid(250, 250, 250), ColorGrade(exposure=2.0))
    assert out.dtype == np.uint8
    assert int(out.max()) == 255  # clamped, no overflow


# --- .cube LUT ---------------------------------------------------------------


def _identity_cube(size: int = 2) -> str:
    lines = [f"LUT_3D_SIZE {size}"]
    denom = size - 1
    # Red fastest, then green, then blue (per spec).
    for b in range(size):
        for g in range(size):
            for r in range(size):
                lines.append(f"{r / denom} {g / denom} {b / denom}")
    return "\n".join(lines)


def test_parse_identity_cube_round_trips_colors() -> None:
    lut = parse_cube_lut(_identity_cube(2))
    assert lut.size == 2
    frame = _solid(10, 200, 130)
    out = apply_lut(frame, lut)
    # An identity LUT returns the input (within rounding for a 2-point grid that
    # is exact for the linear ramp).
    assert np.allclose(out, frame, atol=1)


def test_parse_cube_handles_comments_title_and_domain() -> None:
    text = "# a comment\nTITLE \"x\"\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n" + _identity_cube(2)
    lut = parse_cube_lut(text)
    assert isinstance(lut, CubeLut) and lut.size == 2


def test_invert_lut_maps_black_to_white() -> None:
    # A 2-point LUT that inverts: store 1-r, 1-g, 1-b at each node.
    lines = ["LUT_3D_SIZE 2"]
    for b in (0, 1):
        for g in (0, 1):
            for r in (0, 1):
                lines.append(f"{1 - r} {1 - g} {1 - b}")
    lut = parse_cube_lut("\n".join(lines))
    out = apply_lut(_solid(0, 0, 0), lut)
    assert int(out.min()) == 255  # black → white


def test_parse_cube_rejects_1d() -> None:
    with pytest.raises(ValueError, match="1D"):
        parse_cube_lut("LUT_1D_SIZE 16\n0 0 0\n1 1 1")


def test_parse_cube_requires_size() -> None:
    with pytest.raises(ValueError, match="LUT_3D_SIZE"):
        parse_cube_lut("0 0 0\n1 1 1")


def test_parse_cube_rejects_wrong_entry_count() -> None:
    with pytest.raises(ValueError, match="expected"):
        parse_cube_lut("LUT_3D_SIZE 2\n0 0 0\n1 1 1")
