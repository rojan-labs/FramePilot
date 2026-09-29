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

TYPOGRAPHY (2026-09-29, #135). A title carrying caption ``typography`` is drawn by the caption
rasterizer instead, which spaces its letters (``letterSpacing``, em, after every glyph, the last
one and a space included, as the preview's CSS ``letter-spacing`` does; negative tightens, down to
``captions.MIN_LETTER_SPACING_EM``), may draw
from the family's ITALIC file, strokes by ``outlineWidth`` and wraps inside chip padding. So the
table also carries each italic file's rows (``TITLE_ITALIC_FACES``), and the reference section
carries widths the caption rasterizer drew (``TITLE_TYPED_REFERENCE_WIDTHS``) for the TS
arithmetic of a typed title to be checked against.

``python -m framepilot_engine.render.title_metrics`` writes the table to
``packages/ai-sdk/src/title-metrics.generated.ts``; ``tests/test_title_metrics.py`` fails when
the committed table no longer matches the fonts, and checks the formula against the rasterizer.

PLATFORM. Glyphs are measured with Pillow's BASIC layout on every machine, so the table is the
same wherever it is generated. The rasterizer uses whatever layout Pillow was built with: the
macOS wheels the desktop ships draw with basic layout (the formula is exact to rounding there);
Linux wheels carry libraqm; its ligatures and kerning are switched off for titles
(``captions.basic_layout_features``) so it draws what basic layout draws — a monospaced face that
joins "fl" into one cell drew "fly" a third narrower, and Shrikhand's kerning drew it 4.5 % wider,
past the 4 % margin the fit keeps on each side of the frame. The reference widths are the
desktop's own, written by whoever regenerates the file; they are data for the TS test, not
drift-checked.
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
    measure_caption_layout,
    render_caption_raster,
)
from framepilot_engine.render.text_overlay import (
    rasterize_text_overlay,
    text_overlay_caption_style,
)

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
#: Typed titles (caption typography) whose widths ride along: ``(family, weight, word, size %,
#: letterSpacing, fontStyle, outlineWidth, chip colour or None, chip paddingX or None)``. The
#: first two are the harness's "WEEKEND TRIP" in the ``tracked-caps`` style (Montserrat 600,
#: 0.24 em, 4 % of a 1080x1920 frame); the rest cover an italic file, a stroke, a chip and
#: negative tracking (the "statement" style's -0.02 em, and the Inspector's -0.1 under a stroke).
TYPED_REFERENCE_CASES: tuple[
    tuple[str, int, str, float, float, str, float, str | None, float | None], ...
] = (
    ("Montserrat", 600, "WEEKEND", 4.0, 0.24, "normal", 0.0, None, None),
    ("Montserrat", 600, "TRIP", 4.0, 0.24, "normal", 0.0, None, None),
    ("Montserrat", 600, "WEEKEND", 12.0, 0.24, "normal", 0.0, None, None),
    ("Cinzel", 600, "CINEMATIC", 6.0, 0.22, "normal", 0.0, None, None),
    ("Playfair Display", 700, "Wow!", 10.0, 0.1, "italic", 2.0, None, None),
    ("Playfair Display", 400, "jig", 15.0, 0.0, "italic", 0.0, None, None),
    ("Courier Prime", 400, "fly", 9.0, 0.3, "italic", 0.0, None, None),
    ("Inter", 800, "SUBSCRIBE", 8.0, 0.0, "normal", 0.0, "#000000cc", 0.6),
    ("Anton", 400, "MOTION", 15.0, 0.12, "normal", 2.5, "#000000cc", 0.1),
    ("Fraunces", 800, "Statement", 8.0, -0.02, "normal", 0.0, None, None),
    ("Inter", 700, "HEADING", 12.0, -0.1, "normal", 2.0, None, None),
    # Two words on one line: the space between them is a tracked glyph too (harness run 12).
    ("Inter", 700, "THE CLIMB", 6.0, 0.25, "normal", 1.5, None, None),
)


def _face(family: str, weight: int, italic: bool = False) -> Any:
    """The face the export draws ``family`` with, opened with BASIC layout (see PLATFORM).

    ``italic`` opens the family's italic file, which only a typed title draws.
    """
    basic = ImageFont.Layout.BASIC
    if family == DEFAULT_FACE:
        default = ImageFont.load_default(size=REFERENCE_SIZE)
        if not isinstance(default, ImageFont.FreeTypeFont):  # pragma: no cover - Pillow < 10.1
            raise TypeError("Pillow's default face must be a TrueType font to be measured.")
        return default.font_variant(layout_engine=basic)
    bundled = _bundled_font_path(family, weight, italic)
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


def italic_families() -> list[str]:
    """The bundled families that ship an italic file: the only ones an italic title changes."""
    manifest = _font_manifest()
    return sorted(
        family
        for family, entry in manifest.items()
        if isinstance(entry, dict) and isinstance(entry.get("italicFile"), str)
    )


def build_title_metrics() -> dict[str, Any]:
    """The table: every face's glyph rows, deduplicated, and each family's weight → row.

    ``italicFaces`` maps each family with an italic file to its italic rows; a family without
    one draws its upright file when italic is asked for, so it has no entry.
    """
    tables: list[list[list[int]]] = []
    index_of: dict[str, int] = {}

    def rows_for(family: str, italic: bool) -> list[int]:
        buckets: list[int] = []
        for weight in WEIGHT_BUCKETS:
            row = _glyph_row(_face(family, weight, italic))
            key = json.dumps(row, separators=(",", ":"))
            if key not in index_of:
                index_of[key] = len(tables)
                tables.append(row)
            buckets.append(index_of[key])
        return buckets

    faces = {
        family: rows_for(family, False) for family in [DEFAULT_FACE, *sorted(_font_manifest())]
    }
    italic_faces = {family: rows_for(family, True) for family in italic_families()}
    return {
        "glyphs": GLYPHS,
        "weights": list(WEIGHT_BUCKETS),
        "faces": faces,
        "italicFaces": italic_faces,
        "tables": tables,
    }


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


def _typed_params(
    case: tuple[str, int, str, float, float, str, float, str | None, float | None],
) -> dict[str, Any]:
    """The ``text`` effect params of one :data:`TYPED_REFERENCE_CASES` entry."""
    family, weight, _word, size, spacing, style, outline, chip, padding_x = case
    typography: dict[str, Any] = {"letterSpacing": spacing, "fontStyle": style}
    if outline > 0:
        typography.update(outlineColor="#000000", outlineWidth=outline)
    if padding_x is not None:
        typography["background"] = {"paddingX": padding_x}
    return {
        "fontFamily": family,
        "fontWeight": weight,
        "fontSizePercent": size,
        "boxWidthPercent": 100,
        "background": chip,
        "typography": typography,
    }


def typed_reference_widths() -> list[dict[str, Any]]:
    """What the caption rasterizer draws for :data:`TYPED_REFERENCE_CASES`.

    ``wrapPx`` is the width the renderer wraps against (the words plus the chip's padding,
    :func:`measure_caption_layout`); ``drawnPx`` is the width of everything visibly drawn — the
    raster's non-transparent columns, so the chip where there is one, else the stroked ink.
    """
    width, height = REFERENCE_FRAME
    cases: list[dict[str, Any]] = []
    for case in TYPED_REFERENCE_CASES:
        family, weight, word, size, spacing, style, outline, chip, padding_x = case
        styled = text_overlay_caption_style(_typed_params(case), height)
        if styled is None:  # pragma: no cover - every case is a valid typography
            raise ValueError(f"typed reference case {case!r} does not validate")
        wrap = measure_caption_layout(word, width, height, style=styled).box_width
        alpha = render_caption_raster(word, width, height, style=styled).image[..., 3]
        columns = alpha.max(axis=0).nonzero()[0]
        drawn = int(columns[-1] - columns[0] + 1) if columns.size else 0
        cases.append(
            {
                "family": family,
                "weight": weight,
                "word": word,
                "size": size,
                "letterSpacing": spacing,
                "fontStyle": style,
                "outlineWidth": outline,
                "background": chip,
                "paddingX": padding_x,
                "wrapPx": int(wrap),
                "drawnPx": drawn,
            }
        )
    return cases


def render_title_metrics_ts(
    metrics: dict[str, Any],
    cases: list[dict[str, Any]],
    typed_cases: list[dict[str, Any]] | None = None,
) -> str:
    """The generated TypeScript module, byte-for-byte what is committed."""
    tables = ",\n".join(
        "  [" + ",".join(f"[{a},{left},{right}]" for a, left, right in row) + "]"
        for row in metrics["tables"]
    )
    faces = ",\n".join(
        f"  {json.dumps(family)}: [{', '.join(str(i) for i in rows)}]"
        for family, rows in metrics["faces"].items()
    )
    italic_faces = ",\n".join(
        f"  {json.dumps(family)}: [{', '.join(str(i) for i in rows)}]"
        for family, rows in metrics["italicFaces"].items()
    )
    typed_lines = ",\n".join(
        f"  {{ family: {json.dumps(c['family'])}, weight: {c['weight']}, "
        f"word: {json.dumps(c['word'])}, size: {c['size']}, "
        f"letterSpacing: {c['letterSpacing']}, fontStyle: {json.dumps(c['fontStyle'])}, "
        f"outlineWidth: {c['outlineWidth']}, background: {json.dumps(c['background'])}, "
        f"paddingX: {json.dumps(c['paddingX'])}, wrapPx: {c['wrapPx']}, "
        f"drawnPx: {c['drawnPx']} }}"
        for c in (typed_cases or [])
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
        "/** Family → the table index for each weight bucket of its ITALIC file. A family with "
        "no italic file draws upright when italic is asked for, so it has no entry. */\n"
        "export const TITLE_ITALIC_FACES: Readonly<Record<string, readonly [number, number, "
        "number]>> = {\n"
        f"{italic_faces}\n"
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
        "\n"
        "/** Typed titles (caption typography) as the caption rasterizer drew them: `wrapPx` is "
        "the width it wraps against, `drawnPx` the width of everything visibly drawn. */\n"
        "export const TITLE_TYPED_REFERENCE_WIDTHS: readonly {\n"
        "  readonly family: string;\n"
        "  readonly weight: number;\n"
        "  readonly word: string;\n"
        "  readonly size: number;\n"
        "  readonly letterSpacing: number;\n"
        "  readonly fontStyle: 'normal' | 'italic';\n"
        "  readonly outlineWidth: number;\n"
        "  readonly background: string | null;\n"
        "  readonly paddingX: number | null;\n"
        "  readonly wrapPx: number;\n"
        "  readonly drawnPx: number;\n"
        "}[] = [\n"
        f"{typed_lines}\n"
        "];\n"
    )


def main(argv: list[str] | None = None) -> int:
    """Write the generated module under the repository root given (default: the cwd's)."""
    args = sys.argv[1:] if argv is None else argv
    root = Path(args[0]) if args else Path(__file__).resolve().parents[4]
    target = root / OUTPUT
    target.write_text(
        render_title_metrics_ts(build_title_metrics(), reference_widths(), typed_reference_widths())
    )
    print(f"title-metrics: wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
