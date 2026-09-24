"""The title metrics the AI layer fits titles with (``render/title_metrics.py``).

Two things must hold for the agent's title fit to describe the export: the committed table is
what the bundled fonts measure today, and the width formula it feeds predicts what the
rasterizer draws. The first is a byte-for-byte comparison; the second is checked across every
bundled family, weights inside each bucket, and words chosen for their overhangs.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from framepilot_engine.render import title_metrics as tm
from framepilot_engine.render.text_overlay import rasterize_text_overlay

REPO_ROOT = Path(__file__).resolve().parents[3]
#: The formula may read at most this much narrower than the drawn raster: glyph metrics are
#: rounded to 1/1000 em and ink edges to whole pixels. The fit keeps a 4 % margin each side
#: of the 92 % safe width, so an under-read this small cannot put a title off the frame.
MAX_UNDER_READ = 0.025


@pytest.fixture(scope="module")
def metrics() -> dict[str, object]:
    return tm.build_title_metrics()


def test_the_committed_table_is_what_the_fonts_measure(metrics: dict[str, object]) -> None:
    committed = (REPO_ROOT / tm.OUTPUT).read_text()
    expected = tm.render_title_metrics_ts(metrics, tm.reference_widths())
    assert committed == expected, (
        "packages/ai-sdk/src/title-metrics.generated.ts is stale: run "
        "`uv run python -m framepilot_engine.render.title_metrics` from engine/python."
    )


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
                worst = min(worst, (predicted - drawn) / drawn)
                # Exact weights read within rounding in BOTH directions: a gross over-read
                # would shrink titles for nothing, which is the other bug this replaced.
                assert predicted <= drawn * 1.03 + 2, (family, weight, word, size)
    assert worst >= -MAX_UNDER_READ


def test_every_bundled_family_has_a_row_for_every_weight(metrics: dict[str, object]) -> None:
    faces = metrics["faces"]
    assert isinstance(faces, dict)
    assert tm.DEFAULT_FACE in faces
    assert len(faces) > 20
    assert all(len(rows) == len(tm.WEIGHT_BUCKETS) for rows in faces.values())
