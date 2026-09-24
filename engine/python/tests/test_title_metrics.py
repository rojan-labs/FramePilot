"""The title metrics the AI layer fits titles with (``render/title_metrics.py``).

Two things must hold for the agent's title fit to describe the export: the committed table is
what the bundled fonts measure today, and the width formula it feeds predicts what the
rasterizer draws. The first is a byte-for-byte comparison; the second is checked across every
bundled family, weights inside each bucket, and words chosen for their overhangs.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from PIL import features

from framepilot_engine.render import title_metrics as tm
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
#: The most the formula may read WIDER than the raster: rounding on basic layout; kerning and
#: ligatures ("fl") on shaped layout, where a short word can draw a quarter narrower.
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
                assert predicted <= drawn * OVER_READ + PIXEL_SLACK, (family, weight, word, size, drawn)
    assert worst >= -MAX_UNDER_READ, worst_case


def test_every_bundled_family_has_a_row_for_every_weight(metrics: dict[str, object]) -> None:
    faces = metrics["faces"]
    assert isinstance(faces, dict)
    assert tm.DEFAULT_FACE in faces
    assert len(faces) > 90
    assert all(len(rows) == len(tm.WEIGHT_BUCKETS) for rows in faces.values())
