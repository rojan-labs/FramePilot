"""The title metrics the AI layer fits titles with (``render/title_metrics.py``).

Two things must hold for the agent's title fit to describe the export: the committed table is
what the bundled fonts measure today, and the width formula it feeds predicts what the
rasterizer draws. The first is a byte-for-byte comparison; the second is checked across every
bundled family, weights inside each bucket, and words chosen for their overhangs.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

import pytest
from PIL import features

from framepilot_engine.render import title_metrics as tm
from framepilot_engine.render.captions import MIN_LETTER_SPACING_EM
from framepilot_engine.render.text_overlay import rasterize_text_overlay

REPO_ROOT = Path(__file__).resolve().parents[3]
#: The formula may read at most this much narrower than the drawn raster. On basic layout (the
#: desktop's macOS build) that is rounding: glyph metrics to 1/1000 em, ink edges to whole
#: pixels. Shaped layout (libraqm, the Linux wheels) also kerns, and one pair in the catalog
#: draws 3.2 % wider than its advances (CI, 2026-09-24). The fit keeps a 4 % margin each side
#: of the 92 % safe width, so neither can put a title off the frame.
#: Both bounds allow :data:`PIXEL_SLACK` on top: at the smallest size a three-letter word is
#: ~120 px, so one pixel of edge rounding alone is ~1 % (Bricolage Grotesque's "jig" at 4 %
#: read 116 px against 119 drawn when the catalog grew to 92 families).
PIXEL_SLACK = 2
MAX_UNDER_READ = 0.025 if not features.check("raqm") else 0.04
#: The most the formula may read WIDER than the raster: rounding on basic layout; kerning on
#: shaped layout, where a short word can draw a quarter narrower. Ligatures are off in the
#: title rasterizer on every layout, and so is kerning (``captions.basic_layout_features``):
#: Press Start 2P's "fl" joined into one monospaced cell and drew "fly" at two-thirds of the
#: formula on CI, and Shrikhand kerned "fly" 4.5 % wide.
OVER_READ = 1.03 if not features.check("raqm") else 1.3


@pytest.fixture(scope="module")
def metrics() -> dict[str, object]:
    return tm.build_title_metrics()


#: How far a committed glyph metric may sit from a fresh measurement, in 1/1000 em: FreeType
#: builds can round a glyph edge differently, and 0.2 % of an em never changes a fitted size.
TABLE_TOLERANCE = 2


def _committed_rows(text: str) -> dict[tuple[str, int], list[list[int]]]:
    """``(family, bucket) -> glyph row`` parsed from the committed TypeScript module."""
    tables_block = text.split("export const TITLE_GLYPH_TABLES")[1].split("\n];")[0]
    tables = [
        json.loads(line.strip().rstrip(","))
        for line in tables_block.splitlines()
        if line.strip().startswith("[[")
    ]
    faces_block = text.split("export const TITLE_FACES")[1].split("\n};")[0]
    rows: dict[tuple[str, int], list[list[int]]] = {}
    for family, *indices in re.findall(
        r'^\s*("[^"]*"): \[(\d+), (\d+), (\d+)\]', faces_block, re.M
    ):
        for bucket, index in enumerate(indices):
            rows[(json.loads(family), bucket)] = tables[int(index)]
    return rows


def test_the_committed_table_is_what_the_fonts_measure(metrics: dict[str, object]) -> None:
    # Row by row, within rounding: dedup indices may differ between builds, and the reference
    # widths below the marker are the generating machine's (see the module's PLATFORM note).
    committed = _committed_rows((REPO_ROOT / tm.OUTPUT).read_text())
    tables = metrics["tables"]
    faces = metrics["faces"]
    assert isinstance(tables, list) and isinstance(faces, dict)
    stale = "run `uv run python -m framepilot_engine.render.title_metrics` from engine/python"
    assert set(committed) == {(f, b) for f in faces for b in range(len(tm.WEIGHT_BUCKETS))}, stale
    for (family, bucket), row in committed.items():
        fresh = tables[faces[family][bucket]]
        worst = max(
            abs(a - b)
            for got, want in zip(row, fresh, strict=True)
            for a, b in zip(got, want, strict=True)
        )
        assert worst <= TABLE_TOLERANCE, (family, bucket, worst, stale)


def _predict(
    metrics: dict[str, object], family: str, weight: int, word: str, size_pct: float
) -> float:
    tables = metrics["tables"]
    faces = metrics["faces"]
    glyphs = metrics["glyphs"]
    assert isinstance(tables, list) and isinstance(faces, dict) and isinstance(glyphs, str)
    bucket = next(i for i, top in enumerate(tm.WEIGHT_BUCKETS) if weight <= top)
    row = tables[faces[family][bucket]]
    size = int(tm.REFERENCE_FRAME[1] * size_pct / 100)
    cells = [row[glyphs.index(ch)] for ch in word]
    ink = float(sum(cell[0] for cell in cells[:-1]) + cells[-1][2] - cells[0][1])
    return ink / 1000 * size + 6 * max(1, size // 12)


@pytest.mark.parametrize("weight", [400, 700, 900])
def test_the_formula_predicts_the_drawn_width(metrics: dict[str, object], weight: int) -> None:
    faces = metrics["faces"]
    assert isinstance(faces, dict)
    words = ("MOTION", "WAIT", "jig", "fly", "Behind", "SUBSCRIBE", "Wow!", "100%")
    worst = 0.0
    worst_case: tuple[object, ...] = ()
    for family in faces:
        for word in words:
            for size in (4.0, 9.0, 15.0, 22.0):
                style: dict[str, object] = {
                    "fontSizePercent": size,
                    "boxWidthPercent": 100,
                    "fontWeight": weight,
                }
                if family:
                    style["fontFamily"] = family
                drawn = rasterize_text_overlay(word, style, *tm.REFERENCE_FRAME).shape[1]
                predicted = _predict(metrics, family, weight, word, size)
                under = (predicted + PIXEL_SLACK - drawn) / drawn
                if under < worst:
                    worst = under
                    worst_case = (family, weight, word, size, round(predicted, 1), drawn)
                # Within rounding in BOTH directions on basic layout: a gross over-read would
                # shrink titles for nothing, the other bug this replaced. Shaped layout (libraqm,
                # the Linux wheels) kerns and ligates narrower than the summed advances.
                assert predicted <= drawn * OVER_READ + PIXEL_SLACK, (
                    family,
                    weight,
                    word,
                    size,
                    drawn,
                )
    assert worst >= -MAX_UNDER_READ, worst_case


def test_every_bundled_family_has_a_row_for_every_weight(metrics: dict[str, object]) -> None:
    faces = metrics["faces"]
    assert isinstance(faces, dict)
    assert tm.DEFAULT_FACE in faces
    assert len(faces) > 90
    assert all(len(rows) == len(tm.WEIGHT_BUCKETS) for rows in faces.values())


def _committed_italic_rows(text: str) -> dict[tuple[str, int], list[list[int]]]:
    """``(family, bucket) -> italic glyph row`` parsed from the committed TypeScript module."""
    tables_block = text.split("export const TITLE_GLYPH_TABLES")[1].split("\n];")[0]
    tables = [
        json.loads(line.strip().rstrip(","))
        for line in tables_block.splitlines()
        if line.strip().startswith("[[")
    ]
    faces_block = text.split("export const TITLE_ITALIC_FACES")[1].split("\n};")[0]
    rows: dict[tuple[str, int], list[list[int]]] = {}
    for family, *indices in re.findall(
        r'^\s*("[^"]*"): \[(\d+), (\d+), (\d+)\]', faces_block, re.M
    ):
        for bucket, index in enumerate(indices):
            rows[(json.loads(family), bucket)] = tables[int(index)]
    return rows


def test_the_committed_italic_rows_are_what_the_italic_files_measure(
    metrics: dict[str, object],
) -> None:
    committed = _committed_italic_rows((REPO_ROOT / tm.OUTPUT).read_text())
    tables = metrics["tables"]
    italic_faces = metrics["italicFaces"]
    assert isinstance(tables, list) and isinstance(italic_faces, dict)
    assert set(italic_faces) == set(tm.italic_families())
    assert set(committed) == {(f, b) for f in italic_faces for b in range(len(tm.WEIGHT_BUCKETS))}
    for (family, bucket), row in committed.items():
        fresh = tables[italic_faces[family][bucket]]
        worst = max(
            abs(a - b)
            for got, want in zip(row, fresh, strict=True)
            for a, b in zip(got, want, strict=True)
        )
        assert worst <= TABLE_TOLERANCE, (family, bucket, worst)


def _typed_predict(
    metrics: dict[str, object],
    params: dict[str, object],
    word: str,
) -> tuple[int, float]:
    """``(wrapPx, inkPx)`` for a typed title, by the arithmetic ``overlay-fit.ts`` does.

    Kept a line-for-line twin of ``typedTitleWidthsPx`` so this test is the cross-check of the
    TS fit against the caption rasterizer: tracking is ``letterSpacing * size`` after every glyph
    in the wrap box, the last one and a space included (the preview's CSS box), and between them
    in the ink (negative tightens, clamped at ``MIN_LETTER_SPACING_EM``), an italic
    draws from the italic rows, the wrap width adds ``paddingX`` each side (0.35 em unless a chip
    names its own), and the stroke is ``outlineWidth`` sixteenths of the size, at least a pixel.
    """
    tables = metrics["tables"]
    faces = metrics["faces"]
    italic_faces = metrics["italicFaces"]
    glyphs = metrics["glyphs"]
    assert isinstance(tables, list) and isinstance(faces, dict)
    assert isinstance(italic_faces, dict) and isinstance(glyphs, str)
    typography = params["typography"]
    assert isinstance(typography, dict)
    family = str(params["fontFamily"])
    weight = params["fontWeight"]
    assert isinstance(weight, int)
    size_percent = params["fontSizePercent"]
    assert isinstance(size_percent, int | float)
    size = max(16, int(tm.REFERENCE_FRAME[1] * float(size_percent) / 100))
    italic = typography.get("fontStyle") == "italic"
    bucket = next(i for i, top in enumerate(tm.WEIGHT_BUCKETS) if weight <= top)
    source = italic_faces if italic and family in italic_faces else faces
    row = tables[source[family][bucket]]
    cells = [row[glyphs.index(ch)] for ch in word]
    spacing = max(MIN_LETTER_SPACING_EM, float(typography.get("letterSpacing", 0.0))) * size
    tracked = spacing * len(word)
    gaps = spacing * (len(word) - 1)
    advance = sum(cell[0] for cell in cells) / 1000 * size + tracked
    chip = typography.get("background")
    pad_em = (
        float(chip.get("paddingX", 0.35))
        if params.get("background") and isinstance(chip, dict)
        else 0.35
    )
    wrap = int(advance) + 2 * int(size * pad_em)
    outline = float(typography.get("outlineWidth", 0.0))
    stroke = 0 if outline <= 0 else max(1, round(outline * size / 16))
    ink_right = (
        sum(cell[0] for cell in cells[:-1]) / 1000 * size + gaps + cells[-1][2] / 1000 * size
    )
    ink = ink_right - cells[0][1] / 1000 * size + 2 * stroke
    return wrap, ink


@pytest.mark.parametrize(
    "case",
    tm.TYPED_REFERENCE_CASES,
    ids=[f"{c[0]}-{c[2]}-{c[3]}" for c in tm.TYPED_REFERENCE_CASES],
)
def test_the_typed_formula_predicts_the_caption_rasterizer(
    metrics: dict[str, object],
    case: tuple[str, int, str, float, float, str, float, str | None, float | None],
) -> None:
    # The harness's "WEEKEND TRIP" in `tracked-caps` (0.24 em) is the first pair: before #135 the
    # fit measured it untracked, 22 % narrower than it draws, and accepted boxes it overflows.
    from framepilot_engine.render.captions import measure_caption_layout, render_caption_raster
    from framepilot_engine.render.text_overlay import text_overlay_caption_style

    word = case[2]
    params = tm._typed_params(case)
    width, height = tm.REFERENCE_FRAME
    styled = text_overlay_caption_style(params, height)
    assert styled is not None
    wrap_drawn = measure_caption_layout(word, width, height, style=styled).box_width
    alpha = render_caption_raster(word, width, height, style=styled).image[..., 3]
    columns = alpha.max(axis=0).nonzero()[0]
    ink_drawn = int(columns[-1] - columns[0] + 1)
    wrap, ink = _typed_predict(metrics, params, word)
    # The wrap width is arithmetic on the same advances the renderer sums; it reads wide only
    # where a weight is bucketed UP (600 is measured at 700), never narrow.
    assert wrap + PIXEL_SLACK >= wrap_drawn * (1 - MAX_UNDER_READ), (case, wrap, wrap_drawn)
    assert wrap <= wrap_drawn * OVER_READ + PIXEL_SLACK, (case, wrap, wrap_drawn)
    # What is drawn is the chip where there is one, else the stroked ink; the fit's
    # max(wrap, ink) must never read narrower than it.
    assert max(wrap, ink) + PIXEL_SLACK >= ink_drawn * (1 - MAX_UNDER_READ), (case, wrap, ink)
    if params["background"] is None:
        assert ink + PIXEL_SLACK >= ink_drawn * (1 - MAX_UNDER_READ), (case, ink, ink_drawn)
        assert ink <= ink_drawn * OVER_READ + PIXEL_SLACK, (case, ink, ink_drawn)
    # And tracking is really in it: the same word untracked wraps narrower when the tracking
    # widens it, and wider when negative tracking tightens it.
    spacing = case[4]
    if spacing != 0:
        typography = params["typography"]
        assert isinstance(typography, dict)
        untracked = {**params, "typography": {**typography, "letterSpacing": 0}}
        plain = _typed_predict(metrics, untracked, word)[0]
        assert plain < wrap if spacing > 0 else plain > wrap, (case, plain, wrap)


def _committed_lines(text: str, name: str) -> dict[str, list[int]]:
    """``family -> [ascent, descent, xHeight]`` parsed from one committed line-metrics block."""
    block = text.split(f"export const {name}:")[1].split("\n};")[0]
    return {
        json.loads(family): [int(a), int(d), int(x)]
        for family, a, d, x in re.findall(r'^\s*("[^"]*"): \[(\d+), (\d+), (\d+)\]', block, re.M)
    }


def test_the_committed_line_metrics_are_what_the_fonts_measure(
    metrics: dict[str, object],
) -> None:
    text = (REPO_ROOT / tm.OUTPUT).read_text()
    for name, key, faces_key in (
        ("TITLE_FACE_LINES", "lines", "faces"),
        ("TITLE_ITALIC_FACE_LINES", "italicLines", "italicFaces"),
    ):
        fresh = metrics[key]
        faces = metrics[faces_key]
        assert isinstance(fresh, dict) and isinstance(faces, dict)
        committed = _committed_lines(text, name)
        assert set(committed) == set(faces), name
        for family, values in committed.items():
            worst = max(abs(a - b) for a, b in zip(values, fresh[family], strict=True))
            assert worst <= TABLE_TOLERANCE, (name, family, worst)


def test_one_line_entry_per_file_holds_at_every_weight() -> None:
    # One entry per file is only honest if a variable font's weight axis leaves the line
    # metrics alone, and if the lightest cut's x-height is the least any weight draws: a
    # heavier cut's ink rises a little higher, and the x-height is used as a floor.
    for family in ["Playfair Display", "Manrope", "Inter", "Montserrat", "Fraunces"]:
        measured = [tm._line_metrics(tm._face(family, w)) for w in tm.WEIGHT_BUCKETS]
        assert len({(a, d) for a, d, _x in measured}) == 1, (family, measured)
        assert measured[0][2] == min(x for _a, _d, x in measured), (family, measured)


#: Typed titles whose drawn height the line metrics must predict: ``(params, text)``. The first
#: two are harness run 16's "Until next weekend." and "SEPT 2026", which drew over each other.
_HEIGHT_CASES: tuple[tuple[dict[str, object], str], ...] = (
    (
        {
            "fontFamily": "Playfair Display",
            "fontSizePercent": 5.5,
            "typography": {
                "outlineColor": "#000000",
                "outlineWidth": 1.3333333333333333,
                "fontStyle": "italic",
            },
        },
        "Until next weekend.",
    ),
    (
        {
            "fontFamily": "Manrope",
            "fontWeight": 600,
            "fontSizePercent": 1.6,
            "typography": {
                "outlineColor": "#000000",
                "outlineWidth": 1.3333333333333333,
                "letterSpacing": 0.25,
            },
        },
        "SEPT 2026",
    ),
    (
        {
            "fontFamily": "Inter",
            "fontWeight": 600,
            "fontSizePercent": 2.7,
            "boxWidthPercent": 40,
            "background": "#14141473",
            "typography": {"background": {"paddingX": 0.7, "paddingY": 0.3}, "lineHeight": 1.2},
        },
        "Somewhere between here and home.",
    ),
)


@pytest.mark.parametrize("case", _HEIGHT_CASES, ids=[c[1] for c in _HEIGHT_CASES])
def test_the_line_metrics_predict_the_typed_title_height(
    metrics: dict[str, object], case: tuple[dict[str, object], str]
) -> None:
    """The arithmetic ``overlay-fit.ts`` ``drawnTextRects`` does, against the caption rasterizer.

    The chip is ``lines x (ascent + descent + 2 x stroke) + gaps + 2 x paddingY``, the ascent and
    descent rounded up to whole pixels as FreeType reports them; each line's ink covers at least
    its x-height above its baseline.
    """
    from framepilot_engine.render.captions import (
        _layout_styled_caption,
        render_caption_raster,
    )
    from framepilot_engine.render.text_overlay import text_overlay_caption_style

    params, text = case
    width, height = tm.REFERENCE_FRAME
    styled = text_overlay_caption_style(params, height)
    assert styled is not None
    layout = _layout_styled_caption(text, width, height, styled, [], 0.0)
    typography = params["typography"]
    assert isinstance(typography, dict)
    italic = typography.get("fontStyle") == "italic"
    lines_key = "italicLines" if italic else "lines"
    table = metrics[lines_key]
    assert isinstance(table, dict)
    ascent_em, descent_em, x_em = table[str(params["fontFamily"])]
    size = layout.font_size
    ascent = math.ceil(ascent_em * size / 1000 - 1e-9)
    descent = math.ceil(descent_em * size / 1000 - 1e-9)
    line = ascent + descent + 2 * layout.stroke
    rows = len(layout.lines)
    predicted = rows * line + layout.line_gap * (rows - 1) + 2 * layout.pad_y
    assert abs(predicted - (layout.block_h + 2 * layout.pad_y)) <= rows, (predicted, layout.block_h)
    # Every line's x-height band is inked (the chip, where there is one, is inked everywhere).
    raster = render_caption_raster(
        text, width, height, style=styled.model_copy(update={"shadow": None})
    )
    alpha = raster.image[..., 3]
    inked_rows = alpha.max(axis=1) > 0
    top = raster.margin + layout.pad_y
    for index in range(rows):
        baseline = top + index * (line + layout.line_gap) + ascent + layout.stroke
        band_top = baseline - math.floor(x_em * size / 1000) - layout.stroke
        band = inked_rows[band_top + PIXEL_SLACK : baseline - PIXEL_SLACK]
        assert band.size > 0 and bool(band.all()), (text, index, band_top, baseline)
