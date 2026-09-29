"""The engine's title fit (``service._fit_title_size``) lands where the AI layer's fit does.

``measure_subject`` answers with a title size from the engine's fit; the title tools write
sizes from ``overlay-fit.ts`` ``largestFittingSizePercent``. The two must agree, or a size one
fitted is not the size the other renders. Two ways they did not:

- a title with typography is drawn on the caption rasterizer's canvas, whose transparent margin
  (motion room, and the shadow's reach) the engine measured as if it were the title: a shadowed
  "MOTION" fitted at 7.8 % where the TS fit says 10.5 %;
- the engine probed the whole text on one 100 % line and judged it against the 92 % safe width,
  so a line the written 92 % box would have broken counted as too wide: "WEEKEND TRIP" asked
  for at 30 % came back at 9.1 % instead of 13.2 %.

The TS side is reproduced here with the ``title_metrics`` table and the typed-title arithmetic
twin in ``test_title_metrics.py`` (itself pinned to ``typedTitleWidthsPx``).
"""

from __future__ import annotations

import math
from typing import Any

import pytest

from framepilot_engine.render import title_metrics as tm
from framepilot_engine.render.captions import render_caption_raster
from framepilot_engine.render.text_overlay import (
    rasterize_text_overlay,
    text_overlay_caption_style,
    title_drawn_size,
)
from framepilot_engine.service import TITLE_SAFE_WIDTH_FRACTION, _fit_title_size
from tests.test_title_metrics import _typed_predict

W, H = tm.REFERENCE_FRAME
SHADOW = {"color": "#000000aa", "blur": 0.2, "offsetX": 0.0, "offsetY": 0.06}


@pytest.fixture(scope="module")
def metrics() -> dict[str, object]:
    return tm.build_title_metrics()


def _typed(
    family: str, weight: int, typography: dict[str, Any], size: float = 20.0
) -> dict[str, Any]:
    return {
        "fontFamily": family,
        "fontWeight": weight,
        "fontSizePercent": size,
        "background": None,
        "typography": typography,
    }


def _ts_typed_fit(metrics: dict[str, object], text: str, params: dict[str, Any]) -> float:
    """``largestTypedSizePercent`` in Python: the largest tenth at which every word's drawn
    width, ``ceil(max(wrap, ink))``, is inside ``floor(width * 0.92)``."""
    limit = math.floor(W * TITLE_SAFE_WIDTH_FRACTION)
    requested = round(float(params["fontSizePercent"]) * 10)
    for tenths in range(requested, 0, -1):
        probe = {**params, "fontSizePercent": tenths / 10}
        widths = [_typed_predict(metrics, probe, word) for word in text.split()]
        if all(math.ceil(max(wrap, ink)) <= limit for wrap, ink in widths):
            return tenths / 10
    return 0.0


def test_a_typed_title_is_measured_by_what_it_draws_not_its_canvas() -> None:
    params = _typed("Inter", 900, {"shadow": SHADOW}, size=10.0)
    styled = text_overlay_caption_style(params, H)
    assert styled is not None
    raster = render_caption_raster("MOTION", W, H, style=styled)
    drawn_w, drawn_h = title_drawn_size("MOTION", params, W, H)
    # The canvas keeps transparent room each side (more with a shadow); none of it is the title.
    assert raster.margin > 0
    assert raster.image.shape[1] >= drawn_w + 2 * raster.margin - 1
    assert raster.image.shape[0] > drawn_h
    # The shadow is not what the fit keeps in frame (overlay-fit.ts leaves it out too).
    unshadowed = _typed("Inter", 900, {}, size=10.0)
    assert title_drawn_size("MOTION", unshadowed, W, H) == (drawn_w, drawn_h)


def test_a_plain_title_is_measured_by_its_own_tight_raster() -> None:
    params = {"fontFamily": "Anton", "fontWeight": 400, "fontSizePercent": 12}
    raster = rasterize_text_overlay("MOTION", params, W, H)
    assert title_drawn_size("MOTION", params, W, H) == (raster.shape[1], raster.shape[0])


@pytest.mark.parametrize(
    "case",
    tm.TYPED_REFERENCE_CASES,
    ids=[f"{c[0]}-{c[2]}-{c[3]}" for c in tm.TYPED_REFERENCE_CASES],
)
def test_the_drawn_width_is_what_title_metrics_records(
    case: tuple[str, int, str, float, float, str, float, str | None, float | None],
) -> None:
    # title_metrics records a typed title's wrap box and its drawn ink (the TS fit's reference);
    # the engine's fit keeps the wider of the two inside the frame, as typedTitleDrawnWidthPx does.
    (reference,) = [
        ref
        for ref in tm.typed_reference_widths()
        if (ref["family"], ref["word"], ref["size"]) == (case[0], case[2], case[3])
    ]
    drawn_w, _ = title_drawn_size(case[2], tm._typed_params(case), W, H)
    assert drawn_w == max(reference["wrapPx"], reference["drawnPx"])


@pytest.mark.parametrize(
    ("text", "family", "weight", "typography"),
    [
        ("MOTION", "Anton", 400, {}),
        ("MOTION", "Inter", 900, {"letterSpacing": -0.01, "shadow": SHADOW}),
        ("WEEKEND TRIP", "Montserrat", 700, {"letterSpacing": 0.24}),
        ("SUMMER IN LISBON", "Anton", 400, {"outlineColor": "#000000", "outlineWidth": 2}),
        ("Wow!", "Playfair Display", 700, {"fontStyle": "italic", "shadow": SHADOW}),
    ],
)
def test_the_engine_fit_lands_on_the_ai_layers_size(
    metrics: dict[str, object],
    text: str,
    family: str,
    weight: int,
    typography: dict[str, Any],
) -> None:
    # Weights on a bucket edge (400/700/900), so the TS table reads each face exactly.
    params = _typed(family, weight, typography, size=30.0)
    size, shrunk_from = _fit_title_size(text, params, W, H)
    assert shrunk_from == 30.0
    assert abs(size - _ts_typed_fit(metrics, text, params)) <= 0.1, (size, text)


def test_a_multi_word_title_is_fitted_word_by_word() -> None:
    plain = {"fontFamily": "Anton", "fontWeight": 400, "fontSizePercent": 30}
    # Was 9.1: the whole text probed on one 100 % line and judged against the 92 % width.
    assert _fit_title_size("WEEKEND TRIP", plain, W, H) == (13.2, 30.0)
    # The widest word decides, whatever else the title says.
    assert _fit_title_size("WEEKEND", plain, W, H) == _fit_title_size("WEEKEND TRIP", plain, W, H)
    # A title that fits keeps its size.
    assert _fit_title_size("WEEKEND TRIP", {**plain, "fontSizePercent": 8}, W, H) == (8.0, None)
