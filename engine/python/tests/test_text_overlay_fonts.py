"""Titles draw in the family and weight they were given (``render/text_overlay.py``).

The browser preview always did (``overlay-painter.ts`` sets ``ctx.font``); the export and the
desktop monitor drew Pillow's default face regardless, so a title looked plainer everywhere
the editor could not see it being chosen.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.text_overlay import rasterize_text_overlay, text_overlay_layout

W, H = 1080, 1920


def _raster(params: dict[str, object]) -> np.ndarray:
    return rasterize_text_overlay("MOTION", {"fontSizePercent": 11, **params}, W, H)


def test_a_condensed_family_renders_narrower_than_the_default_face() -> None:
    default = _raster({})
    anton = _raster({"fontFamily": "Anton"})
    assert anton.shape[1] < default.shape[1]
    assert not np.array_equal(anton.shape, default.shape)


def test_weight_changes_a_variable_family() -> None:
    light = _raster({"fontFamily": "Montserrat", "fontWeight": 300})
    black = _raster({"fontFamily": "Montserrat", "fontWeight": 900})
    assert black.shape[1] > light.shape[1]


def test_no_family_keeps_the_default_face_exactly() -> None:
    # Projects that never chose a family must render byte-identically.
    assert np.array_equal(
        _raster({}), rasterize_text_overlay("MOTION", {"fontSizePercent": 11}, W, H)
    )
    layout = text_overlay_layout({"fontSizePercent": 11}, W, H)
    assert layout.font_family is None


def test_an_unknown_family_falls_back_instead_of_failing_the_render() -> None:
    fallback = _raster({"fontFamily": "Definitely Not A Font"})
    assert fallback.shape[0] > 0 and fallback.shape[1] > 0


def test_weight_is_clamped_and_defaults_to_the_editors_bold() -> None:
    assert text_overlay_layout({"fontFamily": "Inter"}, W, H).font_weight == 700
    assert text_overlay_layout({"fontFamily": "Inter", "fontWeight": 5000}, W, H).font_weight == 900
