"""Per-glyph title metrics for the AI layer's title fit, generated from the bundled fonts.

WHY THIS EXISTS. The agent fits a title to the frame before the edit is made
(``packages/ai-sdk/src/overlay-fit.ts``): a word too wide for a 9:16 frame at the size asked
for is brought down to one that fits, instead of running off both sides — the "MOTION" title
of the captured 2026-09-23 runs. That fit ran on one font's advances scaled by a per-family
factor, and against this module's rasterizer it was wrong by -24 % to +33 %: it over-shrank
condensed capitals (Anton, Bebas Neue) and, in the direction that matters, let short words in
script faces (Caveat, Pacifico) through at sizes that ran out of the frame. It also ignored
the stroke and padding the rasterizer adds (``6 * (size // 12)`` pixels per line), which is
most of the error on a short word.

So the fit reads what the export draws: for every bundled family at the three weights a title
is bucketed into, each printable ASCII glyph's advance and the left and right edges of its
ink, in thousandths of an em. The width of a single line is then exact up to kerning (which
Pillow's basic layout does not apply)::

    ink = Σ advance(all but last) + inkRight(last) - inkLeft(first)
    drawn = ink * size + 6 * max(1, size // 12)      # text_overlay.render_text_overlay_image

``python -m framepilot_engine.render.title_metrics`` writes the table to
``packages/ai-sdk/src/title-metrics.generated.ts``; ``tests/test_title_metrics.py`` fails when
the committed table no longer matches the fonts, and checks the formula against the rasterizer.

PLATFORM. Glyphs are measured with Pillow's BASIC layout on every machine, so the table is the
same wherever it is generated. The rasterizer uses whatever layout Pillow was built with: the
macOS wheels the desktop ships draw with basic layout (the formula is exact to rounding there);
Linux wheels carry libraqm, whose ligatures ("fl") draw narrower than the summed advances and
whose kerning can draw a pair up to ~3 % wider (CI, 2026-09-24) — inside the 4 % margin the fit
keeps on each side of the frame. The reference widths are the desktop's own,
written by whoever regenerates the file; they are data for the TS test, not drift-checked.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from PIL import ImageFont

from framepilot_engine.render.captions import (
    _bundled_font_path,
    _font_manifest,
    _set_weight_axis,
)
from framepilot_engine.render.text_overlay import rasterize_text_overlay

#: The glyphs measured: printable ASCII. Anything else is charged a full em by the fit.
GLYPHS = "".join(chr(code) for code in range(32, 127))
#: The weights a title's ``fontWeight`` is bucketed into (up to and including each).
WEIGHT_BUCKETS = (400, 700, 900)
#: The size glyphs are measured at: large enough that rounding to 1/1000 em is exact.
REFERENCE_SIZE = 1000
#: The key of Pillow's default face, drawn when a title names no family.
DEFAULT_FACE = ""
#: Where the generated table is written, relative to the repository root.
OUTPUT = Path("packages/ai-sdk/src/title-metrics.generated.ts")
#: Words whose drawn widths ride along for the TS side to check its arithmetic against.
REFERENCE_WORDS = ("MOTION", "WAIT", "jig", "Behind", "SUBSCRIBE", "100%")
#: Opens the reference-widths section of the generated file. Everything above it is the table,
#: which the drift test compares on any platform; the widths below are the generating machine's.
REFERENCE_MARKER = (
    "/** Widths the export's rasterizer drew on the machine that generated this file (the "
    "desktop), for the TS arithmetic to be checked against. */"
)
#: The frame the reference widths are drawn in, and the sizes, as percents of its height.
REFERENCE_FRAME = (1080, 1920)
REFERENCE_SIZES = (6.0, 15.0)


def _face(family: str, weight: int) -> Any:
    """The face the export draws ``family`` with, opened with BASIC layout (see PLATFORM)."""
    basic = ImageFont.Layout.BASIC
    if family == DEFAULT_FACE:
        default = ImageFont.load_default(size=REFERENCE_SIZE)
        if not isinstance(default, ImageFont.FreeTypeFont):  # pragma: no cover - Pillow < 10.1
            raise TypeError("Pillow's default face must be a TrueType font to be measured.")
        return default.font_variant(layout_engine=basic)
    bundled = _bundled_font_path(family, weight, False)
    if bundled is None:  # pragma: no cover - the manifest lists only bundled families
        raise ValueError(f"{family!r} is in the font manifest but not bundled.")
    path, is_variable = bundled
    font = ImageFont.truetype(path, REFERENCE_SIZE, layout_engine=basic)
    if is_variable:
        _set_weight_axis(font, weight)
    return font


def _glyph_row(font: Any) -> list[list[int]]:
    """``[advance, inkLeft, inkRight]`` per glyph of :data:`GLYPHS`, in 1/1000 em."""
    row: list[list[int]] = []
    for glyph in GLYPHS:
        advance = round(font.getlength(glyph) * 1000 / REFERENCE_SIZE)
        left, _top, right, _bottom = font.getbbox(glyph)
        if right <= left:  # a space: no ink, so the edges are the advance
            row.append([advance, 0, advance])
            continue
        row.append(
            [
                advance,
                round(left * 1000 / REFERENCE_SIZE),
                round(right * 1000 / REFERENCE_SIZE),
            ]
        )
    return row


def build_title_metrics() -> dict[str, Any]:
    """The table: every face's glyph rows, deduplicated, and each family's weight → row."""
    families = [DEFAULT_FACE, *sorted(_font_manifest())]
    tables: list[list[list[int]]] = []
    index_of: dict[str, int] = {}
    faces: dict[str, list[int]] = {}
    for family in families:
        buckets: list[int] = []
        for weight in WEIGHT_BUCKETS:
            row = _glyph_row(_face(family, weight))
            key = json.dumps(row, separators=(",", ":"))
            if key not in index_of:
                index_of[key] = len(tables)
                tables.append(row)
            buckets.append(index_of[key])
        faces[family] = buckets
    return {"glyphs": GLYPHS, "weights": list(WEIGHT_BUCKETS), "faces": faces, "tables": tables}


def reference_widths() -> list[dict[str, Any]]:
    """Drawn widths of :data:`REFERENCE_WORDS`, straight from the export's rasterizer."""
    width, height = REFERENCE_FRAME
    cases: list[dict[str, Any]] = []
    for family in [DEFAULT_FACE, *sorted(_font_manifest())]:
        for word in REFERENCE_WORDS:
            for size in REFERENCE_SIZES:
                style: dict[str, Any] = {"fontSizePercent": size, "boxWidthPercent": 100}
                if family != DEFAULT_FACE:
                    style["fontFamily"] = family
                drawn = rasterize_text_overlay(word, style, width, height).shape[1]
                cases.append({"family": family, "word": word, "size": size, "px": int(drawn)})
    return cases


def render_title_metrics_ts(metrics: dict[str, Any], cases: list[dict[str, Any]]) -> str:
    """The generated TypeScript module, byte-for-byte what is committed."""
    tables = ",\n".join(
        "  [" + ",".join(f"[{a},{left},{right}]" for a, left, right in row) + "]"
        for row in metrics["tables"]
    )
    faces = ",\n".join(
        f"  {json.dumps(family)}: [{', '.join(str(i) for i in rows)}]"
        for family, rows in metrics["faces"].items()
    )
    case_lines = ",\n".join(
        f"  {{ family: {json.dumps(c['family'])}, word: {json.dumps(c['word'])}, "
        f"size: {c['size']}, px: {c['px']} }}"
        for c in cases
    )
    frame_width, frame_height = REFERENCE_FRAME
    return (
        "// GENERATED by `python -m framepilot_engine.render.title_metrics` from the bundled\n"
        "// fonts (engine/python/framepilot_engine/render/fonts). Do not edit: regenerate.\n"
        "// tests/test_title_metrics.py fails when this no longer matches the fonts.\n"
        "\n"
        "/** The glyphs each row covers, in order: printable ASCII. */\n"
        f"export const TITLE_GLYPHS = {json.dumps(metrics['glyphs'])};\n"
        "\n"
        "/** The upper bound of each weight bucket a row index is listed for. */\n"
        f"export const TITLE_WEIGHT_BUCKETS = {json.dumps(metrics['weights'])} as const;\n"
        "\n"
        "/** Per glyph: `[advance, inkLeft, inkRight]` in 1/1000 em. */\n"
        "export const TITLE_GLYPH_TABLES: readonly (readonly (readonly [number, number, number])"
        "[])[] = [\n"
        f"{tables}\n"
        "];\n"
        "\n"
        '/** Family (`""` = the default face) → the table index for each weight bucket. */\n'
        "export const TITLE_FACES: Readonly<Record<string, readonly [number, number, number]>> ="
        " {\n"
        f"{faces}\n"
        "};\n"
        "\n"
        f"{REFERENCE_MARKER}\n"
        "export const TITLE_REFERENCE_FRAME = "
        f"{{ width: {frame_width}, height: {frame_height} }};\n"
        "export const TITLE_REFERENCE_WIDTHS: readonly {\n"
        "  readonly family: string;\n"
        "  readonly word: string;\n"
        "  readonly size: number;\n"
        "  readonly px: number;\n"
        "}[] = [\n"
        f"{case_lines}\n"
        "];\n"
    )


def main(argv: list[str] | None = None) -> int:
    """Write the generated module under the repository root given (default: the cwd's)."""
    args = sys.argv[1:] if argv is None else argv
    root = Path(args[0]) if args else Path(__file__).resolve().parents[4]
    target = root / OUTPUT
    target.write_text(render_title_metrics_ts(build_title_metrics(), reference_widths()))
    print(f"title-metrics: wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
