"""A text overlay with ``typography`` is drawn in the caption typography (``text_overlay.py``).

Text overlays and captions used to be two typographies: a caption had the whole caption
vocabulary (outline, shadow, chip, case, spacing, see-through letters) while a text overlay had a
colour, a family and a fixed black stroke. A text overlay that carries ``typography`` is now drawn
by the caption rasterizer, so it draws as a caption in the same look does, in the export and in
the desktop monitor, which both call :func:`rasterize_text_overlay`.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.captions import MIN_LETTER_SPACING_EM, render_caption_raster
from framepilot_engine.render.text_overlay import rasterize_text_overlay, text_overlay_caption_style

W, H = 1080, 1920
BASE: dict[str, object] = {
    "fontSizePercent": 8,
    "fontFamily": "Anton",
    "fontWeight": 400,
    "color": "#ffffff",
}


def _raster(params: dict[str, object], text: str = "LAUNCH DAY") -> np.ndarray:
    return rasterize_text_overlay(text, {**BASE, **params}, W, H)


def test_a_text_overlay_without_typography_is_drawn_exactly_as_before() -> None:
    assert text_overlay_caption_style(BASE, H) is None
    plain = _raster({})
    assert np.array_equal(plain, rasterize_text_overlay("LAUNCH DAY", dict(BASE), W, H))


def test_a_typed_text_overlay_is_the_caption_rasterizers_own_image() -> None:
    params = {**BASE, "typography": {"outlineColor": "#000000", "outlineWidth": 2}}
    style = text_overlay_caption_style(params, H)
    assert style is not None
    expected = render_caption_raster("LAUNCH DAY", W, H, style=style).image
    assert np.array_equal(rasterize_text_overlay("LAUNCH DAY", params, W, H), expected)


def test_the_text_overlay_keeps_its_own_size_family_weight_colour_and_wrap() -> None:
    style = text_overlay_caption_style(
        {**BASE, "align": "left", "boxWidthPercent": 60, "typography": {}}, H
    )
    assert style is not None
    assert style.font_family == "Anton"
    assert style.font_weight == 400
    assert style.text_color == "#ffffffff"
    assert style.text_align == "left"
    assert style.max_width_percent == 60
    assert style.display == "phrase"
    # floor(H / 22 * fontScale) lands on the text overlay's own size, floor(H * 8 / 100).
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


def _ink_columns(image: np.ndarray) -> int:
    columns = image[..., 3].max(axis=0).nonzero()[0]
    return int(columns[-1] - columns[0] + 1)


def test_negative_tracking_is_drawn_as_the_preview_draws_it() -> None:
    # The "heading" and "statement" styles tighten by 0.01 / 0.02 em; the preview draws that
    # (CSS letter-spacing) and the export used to draw it as 0.
    word = "STATEMENT"
    size = int(H * 8 / 100)
    untracked = _ink_columns(_raster({"typography": {}}, text=word))
    tight = _ink_columns(_raster({"typography": {"letterSpacing": -0.02}}, text=word))
    # Eight gaps of -0.02 em each, to a pixel of the per-glyph rounding either way.
    assert abs((untracked - tight) - 8 * 0.02 * size) <= 2, (untracked, tight)
    # Past the clamp the letters would run into each other: -0.5 draws as -0.2, in both
    # renderers (captionPreview.ts clamps the CSS value at the same number).
    clamped = _raster({"typography": {"letterSpacing": MIN_LETTER_SPACING_EM}}, text=word)
    assert np.array_equal(_raster({"typography": {"letterSpacing": -0.5}}, text=word), clamped)
    # One letter has no gap to tighten.
    assert np.array_equal(
        _raster({"typography": {"letterSpacing": -0.1}}, text="I"),
        _raster({"typography": {}}, text="I"),
    )


def test_the_chip_colour_is_the_overlays_background_and_its_shape_the_typography() -> None:
    no_chip = text_overlay_caption_style({**BASE, "typography": {"background": {"radius": 0.5}}}, H)
    assert no_chip is not None and no_chip.background is None
    chip = text_overlay_caption_style(
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
    # Frosted glass is part of the chip's shape (test_text_overlay_frost.py draws it).
    assert chip.background.blur == 0.4


def test_word_timed_and_positional_caption_fields_never_reach_a_text_overlay() -> None:
    style = text_overlay_caption_style(
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


def test_an_invalid_typography_draws_the_plain_text_overlay_instead_of_failing() -> None:
    params = {**BASE, "typography": {"textOpacity": 7}}
    assert text_overlay_caption_style(params, H) is None
    assert np.array_equal(
        rasterize_text_overlay("LAUNCH DAY", params, W, H),
        rasterize_text_overlay("LAUNCH DAY", dict(BASE), W, H),
    )


def test_a_turning_typed_text_overlay_is_drawn_in_its_rotation_safe_square() -> None:
    params = {**BASE, "typography": {}}
    turning = rasterize_text_overlay("LAUNCH DAY", params, W, H, rotates=True)
    assert turning.shape[0] == turning.shape[1]


def test_the_export_refuses_exactly_what_the_preview_refuses() -> None:
    # The preview parses typography with TextOverlayTypographySchema and draws the plain text
    # overlay when it does not parse; the export must agree about every one of these, or the two
    # show different looks for the same text overlay.
    for bad in (
        {"lineHeight": 4},
        {"lineHeight": 0.5},
        {"outlineWidth": -1},
        {"textTransform": "shout"},
        {"fontStyle": "oblique"},
        {"shadow": {"color": "#000000", "blur": 0.2}},
        {"shadow": {"color": "#000000", "blur": -1, "offsetX": 0, "offsetY": 0}},
        {"background": {"radius": -0.2}},
        {"letterSpacing": "wide"},
    ):
        assert text_overlay_caption_style({**BASE, "typography": bad}, H) is None, bad
    assert text_overlay_caption_style({**BASE, "typography": {"lineHeight": 3}}, H) is not None


def test_a_typed_text_overlay_with_no_family_or_size_takes_the_editors_defaults() -> None:
    # The agent's add_text_layer stores neither; the preview draws Inter at 8% of the height.
    style = text_overlay_caption_style({"typography": {}}, H)
    assert style is not None
    assert style.font_family == "Inter"
    assert int(H / 22 * (style.font_scale or 0)) == int(H * 8 / 100)
    # A text overlay that stores a size in pixels keeps it.
    sized = text_overlay_caption_style({"fontSize": 120, "typography": {}}, H)
    assert sized is not None
    assert int(H / 22 * (sized.font_scale or 0)) == 120
