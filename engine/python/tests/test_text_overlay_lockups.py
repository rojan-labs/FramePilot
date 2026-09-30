"""A LOCKUP draws each line of a text overlay in its own look (``typography.lines``).

Title designers set a text in two or three faces at once: a small tracked kicker over a heavy
headline, a script word laid over caps, a name over a role. A text overlay whose ``typography``
carries ``lines`` draws its ``\\n``-separated paragraphs each through the caption rasterizer in
that line's style, stacked box on box (``text_overlay.py#_stack_lockup``). The preview stacks
the same caption blocks in CSS (``textOverlay.ts#textOverlayLineBlocks``).
"""

from __future__ import annotations

import numpy as np
import pytest

from framepilot_engine.render.captions import render_caption_raster
from framepilot_engine.render.text_overlay import (
    rasterize_text_overlay,
    rasterize_text_overlay_layers,
    text_overlay_caption_style,
    text_overlay_line_layouts,
    title_drawn_size,
)

W, H = 1920, 1080
KICKER = {"fontFamily": "Montserrat", "fontWeight": 600, "scale": 0.3, "letterSpacing": 0.3}
BASE: dict[str, object] = {
    "fontSizePercent": 12,
    "fontFamily": "Anton",
    "fontWeight": 400,
    "color": "#ffffff",
    "align": "center",
    "boxWidthPercent": 80,
    "background": None,
}
TEXT = "CHAPTER ONE\nTHE ROAD NORTH"


def _lockup(**typography: object) -> dict[str, object]:
    return {**BASE, "typography": {"lines": [KICKER, {}], **typography}}


def _ink_rows(image: np.ndarray) -> np.ndarray:
    return np.flatnonzero(image[..., 3].max(axis=1))


def test_each_line_takes_its_own_face_size_and_the_overlays_look_otherwise() -> None:
    lines = text_overlay_line_layouts(TEXT, _lockup(textTransform="uppercase"), H)
    assert lines is not None
    kicker, headline = lines
    assert (kicker.text, headline.text) == ("CHAPTER ONE", "THE ROAD NORTH")
    assert kicker.style.font_family == "Montserrat"
    assert kicker.style.font_weight == 600
    assert kicker.style.letter_spacing == pytest.approx(0.3)
    assert headline.style.font_family == "Anton"
    # Overrides only: case comes from the overlay's own typography on both lines.
    assert kicker.style.text_transform == headline.style.text_transform == "uppercase"
    base = text_overlay_caption_style(_lockup(), H)
    assert base is not None
    assert base.font_scale is not None
    assert kicker.style.font_scale is not None
    # The kicker is 30 % of the overlay's size, the headline all of it.
    assert kicker.style.font_scale < 0.31 * base.font_scale
    assert headline.style.font_scale == pytest.approx(base.font_scale)


def test_the_lines_stack_in_order_and_the_headline_is_the_bigger() -> None:
    image = rasterize_text_overlay(TEXT, _lockup(), W, H)
    lines = text_overlay_line_layouts(TEXT, _lockup(), H)
    assert lines is not None
    kicker = render_caption_raster(lines[0].text, W, H, style=lines[0].style)
    headline = render_caption_raster(lines[1].text, W, H, style=lines[1].style)
    kicker_box_h = kicker.image.shape[0] - 2 * kicker.margin
    headline_box_h = headline.image.shape[0] - 2 * headline.margin
    margin = max(kicker.margin, headline.margin)
    assert image.shape[0] == kicker_box_h + headline_box_h + 2 * margin
    assert headline_box_h > 2 * kicker_box_h
    rows = _ink_rows(image)
    # Ink starts in the kicker's band at the top and runs down through the headline's.
    assert rows[0] < margin + kicker_box_h
    assert rows[-1] > margin + kicker_box_h


def test_space_before_moves_a_line_by_ems_of_the_overlays_size() -> None:
    tight = rasterize_text_overlay(
        TEXT, {**BASE, "typography": {"lines": [KICKER, {"spaceBefore": -0.25}]}}, W, H
    )
    loose = rasterize_text_overlay(
        TEXT, {**BASE, "typography": {"lines": [KICKER, {"spaceBefore": 0.25}]}}, W, H
    )
    font_px = int(H * 12 / 100)
    assert loose.shape[0] - tight.shape[0] == pytest.approx(0.5 * font_px, abs=2)


@pytest.mark.parametrize("align", ["left", "center", "right"])
def test_lines_align_by_the_overlays_alignment(align: str) -> None:
    params = {**_lockup(), "align": align}
    image = rasterize_text_overlay(TEXT, params, W, H)
    lines = text_overlay_line_layouts(TEXT, params, H)
    assert lines is not None
    kicker = render_caption_raster(lines[0].text, W, H, style=lines[0].style)
    margin = max(
        kicker.margin, render_caption_raster(lines[1].text, W, H, style=lines[1].style).margin
    )
    kicker_band = image[margin : margin + kicker.image.shape[0] - 2 * kicker.margin]
    columns = np.flatnonzero(kicker_band[..., 3].max(axis=0))
    left_gap, right_gap = columns[0], image.shape[1] - 1 - columns[-1]
    if align == "left":
        assert left_gap < right_gap
    elif align == "right":
        assert right_gap < left_gap
    else:
        # The kicker's box carries its last letter's tracking (0.3 em), as the preview's does.
        trailing_tracking = 0.3 * 0.3 * H * 12 / 100
        assert abs(left_gap - right_gap) <= trailing_tracking + 2


def test_a_line_chip_is_its_own_and_null_removes_the_overlays_chip() -> None:
    params = {
        **BASE,
        "background": "#101010",
        "typography": {
            "background": {"radius": 0, "paddingX": 0.4, "paddingY": 0.2},
            "lines": [{**KICKER, "background": "#ff0033"}, {"background": None}],
        },
    }
    lines = text_overlay_line_layouts(TEXT, params, H)
    assert lines is not None
    kicker, headline = lines
    assert kicker.style.background is not None
    assert kicker.style.background.color == "#ff0033"
    assert kicker.style.background.padding_x == pytest.approx(0.4)
    assert headline.style.background is None


def test_paragraphs_past_the_styled_lines_keep_the_overlays_look() -> None:
    lines = text_overlay_line_layouts("KICKER\nHEADLINE\nTHIRD", _lockup(), H)
    assert lines is not None
    assert [line.style.font_family for line in lines] == ["Montserrat", "Anton", "Anton"]


def test_an_empty_paragraph_draws_nothing_and_keeps_the_line_slots() -> None:
    lines = text_overlay_line_layouts(
        "KICKER\n\nHEADLINE",
        {**BASE, "typography": {"lines": [KICKER, {"color": "#ff0000"}, {"color": "#00ff00"}]}},
        H,
    )
    assert lines is not None
    assert [line.index for line in lines] == [0, 2]
    assert lines[1].style.text_color == "#00ff00ff"


def test_an_overlay_without_lines_is_drawn_as_one_block_as_before() -> None:
    params = {**BASE, "typography": {"shadow": None}}
    assert text_overlay_line_layouts(TEXT, params, H) is None
    style = text_overlay_caption_style(params, H)
    assert style is not None
    expected = render_caption_raster(TEXT, W, H, style=style).image
    assert np.array_equal(rasterize_text_overlay(TEXT, params, W, H), expected)


@pytest.mark.parametrize(
    "line",
    [
        {"scale": 0},
        {"scale": 9},
        {"spaceBefore": 4},
        {"fontWeight": 650.5},
        {"background": ""},
        {"chip": {"radius": -1}},
        {"lineHeight": 5},
        "kicker",
    ],
)
def test_an_invalid_line_draws_the_plain_overlay_as_the_preview_does(line: object) -> None:
    params = {**BASE, "typography": {"lines": [line]}}
    assert text_overlay_line_layouts(TEXT, params, H) is None
    assert text_overlay_caption_style(params, H) is None


def test_too_many_lines_are_refused() -> None:
    params = {**BASE, "typography": {"lines": [{}] * 7}}
    assert text_overlay_caption_style(params, H) is None


def test_a_turning_lockup_is_drawn_in_its_rotation_safe_square() -> None:
    raster = rasterize_text_overlay_layers(TEXT, _lockup(), W, H, rotates=True)
    assert raster.image.shape[0] == raster.image.shape[1]


def test_a_frosted_line_carries_its_backdrop_through_the_stack() -> None:
    params = {
        **BASE,
        "typography": {
            "lines": [KICKER, {"background": "#ffffff33", "chip": {"blur": 0.4}}],
        },
    }
    raster = rasterize_text_overlay_layers(TEXT, params, W, H)
    assert raster.backdrop is not None
    assert raster.backdrop.shape == raster.image.shape[:2]
    assert raster.backdrop_sigma_px > 0
    # Only the headline is frosted: nothing is blurred in the kicker's band at the top.
    rows = np.flatnonzero(raster.backdrop.max(axis=1))
    assert rows[0] > np.flatnonzero(raster.image[..., 3].max(axis=1))[0]


def test_the_drawn_size_is_the_stacked_boxes() -> None:
    width, height = title_drawn_size(TEXT, _lockup(), W, H)
    lines = text_overlay_line_layouts(TEXT, _lockup(), H)
    assert lines is not None
    rasters = [render_caption_raster(line.text, W, H, style=line.style) for line in lines]
    boxes = [(r.image.shape[1] - 2 * r.margin, r.image.shape[0] - 2 * r.margin) for r in rasters]
    assert width == max(w for w, _ in boxes)
    assert height == sum(h for _, h in boxes)
