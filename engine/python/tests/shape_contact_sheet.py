"""Render the shape contact sheet (plan/elements EL5.1): every preset, drawn by the export's own
rasteriser, in one image to review before a catalogue change merges.

Each tile is a 1280x720 frame's worth of the shape at its default size, cropped to the shape and
fitted into a cell over a mid-grey (so white fills and yellow outlines both read), labelled with
its preset id. A second sheet samples the Lucide icons. Deterministic; nothing is fetched.

Writes (run from ``engine/python``)::

    uv run python -m tests.shape_contact_sheet

- ``docs/reports/elements/shapes-contact-sheet.png``
- ``docs/reports/elements/icons-contact-sheet.png``
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from framepilot_engine.render.shape_catalog import (
    load_shape_icons,
    preset_shape_params,
    shape_preset_ids,
)
from framepilot_engine.render.shape_raster import rasterize_shape

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "docs" / "reports" / "elements"
FRAME_W, FRAME_H = 1280, 720
CELL = 132
LABEL_H = 22
COLUMNS = 14
BACKGROUND = (91, 95, 107)
PAGE = (30, 31, 36)
#: One icon in this many goes on the icon sheet: enough to see the outlines hold up.
ICON_STRIDE = 12


def _font() -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    fonts = REPO / "engine" / "python" / "framepilot_engine" / "render" / "fonts"
    for candidate in sorted(fonts.glob("Inter*.ttf")):
        return ImageFont.truetype(str(candidate), 10)
    return ImageFont.load_default()


def _tile(preset_id: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont) -> Image.Image:
    params = preset_shape_params(preset_id)
    assert params is not None, preset_id
    raster, _ = rasterize_shape(params, FRAME_W, FRAME_H)
    cell = Image.new("RGB", (CELL, CELL + LABEL_H), PAGE)
    inner = Image.new("RGBA", (CELL - 8, CELL - 8), (*BACKGROUND, 255))
    scale = min((CELL - 16) / raster.width, (CELL - 16) / raster.height, 1.0)
    fitted = raster.resize(
        (max(1, round(raster.width * scale)), max(1, round(raster.height * scale))),
        Image.Resampling.LANCZOS,
    )
    inner.alpha_composite(
        fitted, ((inner.width - fitted.width) // 2, (inner.height - fitted.height) // 2)
    )
    cell.paste(inner.convert("RGB"), (4, 4))
    label = preset_id if len(preset_id) <= 24 else f"{preset_id[:23]}…"
    ImageDraw.Draw(cell).text((4, CELL + 3), label, fill=(220, 220, 225), font=font)
    return cell


def _sheet(preset_ids: list[str], path: Path) -> None:
    font = _font()
    rows = math.ceil(len(preset_ids) / COLUMNS)
    sheet = Image.new("RGB", (COLUMNS * CELL, rows * (CELL + LABEL_H)), PAGE)
    for index, preset_id in enumerate(preset_ids):
        column, row = index % COLUMNS, index // COLUMNS
        sheet.paste(_tile(preset_id, font), (column * CELL, row * (CELL + LABEL_H)))
    sheet.save(path, optimize=True)
    sys.stdout.write(f"wrote {path} ({len(preset_ids)} tiles)\n")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    _sheet(list(shape_preset_ids()), OUT / "shapes-contact-sheet.png")
    icons = list(load_shape_icons())[::ICON_STRIDE]
    _sheet(icons, OUT / "icons-contact-sheet.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
