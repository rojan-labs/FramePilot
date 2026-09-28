"""A title with ``typography`` is drawn in the caption typography (``render/text_overlay.py``).

Titles and captions used to be two typographies: a caption had the whole caption vocabulary
(outline, shadow, chip, case, spacing, see-through letters) while a title had a colour, a family
and a fixed black stroke. A title that carries ``typography`` is now drawn by the caption
rasterizer, so a title set in a caption look draws as that caption does — in the export and in
the desktop monitor, which both call :func:`rasterize_text_overlay`.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.captions import render_caption_raster
from framepilot_engine.render.text_overlay import rasterize_text_overlay, title_caption_style

W, H = 1080, 1920
BASE: dict[str, object] = {
    "fontSizePercent": 8,
    "fontFamily": "Anton",
    "fontWeight": 400,
    "color": "#ffffff",
}


def _raster(params: dict[str, object], text: str = "LAUNCH DAY") -> np.ndarray:
    return rasterize_text_overlay(text, {**BASE, **params}, W, H)


def test_a_title_without_typography_is_drawn_exactly_as_before() -> None:
    assert title_caption_style(BASE, H) is None
    plain = _raster({})
    assert np.array_equal(plain, rasterize_text_overlay("LAUNCH DAY", dict(BASE), W, H))


def test_a_typed_title_is_the_caption_rasterizers_own_image() -> None:
    params = {**BASE, "typography": {"outlineColor": "#000000", "outlineWidth": 2}}
    style = title_caption_style(params, H)
    assert style is not None
    expected = render_caption_raster("LAUNCH DAY", W, H, style=style).image
    assert np.array_equal(rasterize_text_overlay("LAUNCH DAY", params, W, H), expected)


def test_the_title_keeps_its_own_size_family_weight_colour_and_wrap() -> None:
    style = title_caption_style(
        {**BASE, "align": "left", "boxWidthPercent": 60, "typography": {}}, H
    )
    assert style is not None
    assert style.font_family == "Anton"
    assert style.font_weight == 400
    assert style.text_color == "#ffffffff"
    assert style.text_align == "left"
    assert style.max_width_percent == 60
    assert style.display == "phrase"
    # floor(H / 22 * fontScale) lands on the title's own size, floor(H * 8 / 100).
    assert int(H / 22 * (style.font_scale or 0)) == int(H * 8 / 100)


def test_typography_changes_the_pixels() -> None:
    bare = _raster({"typography": {}})
    outlined = _raster({"typography": {"outlineColor": "#000000", "outlineWidth": 3}})
    shadowed = _raster(
        {
            "typography": {
                "shadow": {"color": "#000000", "blur": 0, "offsetX": 0.08, "offsetY": 0.08}
            }
        }
    )
    assert not np.array_equal(bare, outlined)
    assert not np.array_equal(bare, shadowed)


def test_case_and_letter_spacing_reach_the_layout() -> None:
    lower = _raster({"typography": {}}, text="launch day")
    upper = _raster({"typography": {"textTransform": "uppercase"}}, text="launch day")
    assert np.array_equal(upper, _raster({"typography": {}}, text="LAUNCH DAY"))
    assert not np.array_equal(lower, upper)
    # A short word, so the wider tracking cannot wrap it onto a second, narrower line.
    tracked = _raster({"typography": {"letterSpacing": 0.2}}, text="GO")
    assert tracked.shape[1] > _raster({"typography": {}}, text="GO").shape[1]


def test_the_chip_colour_is_the_titles_background_and_its_shape_the_typography() -> None:
    no_chip = title_caption_style({**BASE, "typography": {"background": {"radius": 0.5}}}, H)
    assert no_chip is not None and no_chip.background is None
    chip = title_caption_style(
        {
            **BASE,
            "background": "#ffd60a",
            "typography": {"background": {"radius": 0.5, "paddingX": 0.6, "blur": 0.4}},
        },
        H,
    )
    assert chip is not None and chip.background is not None
    assert chip.background.color == "#ffd60a"
    assert chip.background.radius == 0.5
    assert chip.background.padding_x == 0.6
    # A title has no backdrop pass: the frost is never passed on.
    assert chip.background.blur is None


def test_word_timed_and_positional_caption_fields_never_reach_a_title() -> None:
    style = title_caption_style(
        {
            **BASE,
            "typography": {
                "highlight": {"enabled": True},
                "animation": {"in": {"type": "zoom", "duration": 0.3}},
                "position": "top",
                "xPercent": 10,
                "rotation": 45,
            },
        },
        H,
    )
    assert style is not None
    assert style.highlight is None and style.animation is None
    assert style.position is None and style.x_percent is None and style.rotation is None


def test_an_invalid_typography_draws_the_plain_title_instead_of_failing() -> None:
    params = {**BASE, "typography": {"textOpacity": 7}}
    assert title_caption_style(params, H) is None
    assert np.array_equal(
        rasterize_text_overlay("LAUNCH DAY", params, W, H),
        rasterize_text_overlay("LAUNCH DAY", dict(BASE), W, H),
    )


def test_a_turning_typed_title_is_drawn_in_its_rotation_safe_square() -> None:
    params = {**BASE, "typography": {}}
    turning = rasterize_text_overlay("LAUNCH DAY", params, W, H, rotates=True)
    assert turning.shape[0] == turning.shape[1]
