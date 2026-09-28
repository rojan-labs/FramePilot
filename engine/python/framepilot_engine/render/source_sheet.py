"""Many source files as shot, tiled into ONE labelled image (``get_frame { sources }``).

WHY this exists: desktop run ``d8d2e445`` was told "look at every clip before cutting", had
20 source clips, looked at 3 (``get_frame { assetId }`` returns one picture per call and
its description says "not a sweep"), and put 29 clips on automatic centred crops. Looking
at every source one call at a time is 20 turns of latency and 20 images of context; one
sheet is one turn and one image whose pixel count the caller bounds.

WHY it reuses the source view: every tile is :func:`frame_grab.source_view_project` rendered
through :func:`frame_grab.render_frame_pixels` — the same compiler the export uses, the whole
uncropped frame as shot. A second decoder would be a second opinion about rotation,
anamorphic pixels and stills.

WHY the layout is fixed arithmetic: the tile index printed on the image is the number the
model refers back with, and the tool result lists tiles in the same order. Same sources in,
same grid, same labels, same pixels out.
"""

from __future__ import annotations

import io
import logging
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from framepilot_engine.render.frame_grab import (
    MAX_ALLOWED_DIMENSION,
    FrameGrabError,
    render_frame_pixels,
    source_view_project,
)
from framepilot_engine.timeline.models import Asset, Project

if TYPE_CHECKING:
    from PIL import Image as PILImage
    from PIL import ImageFont

_log = logging.getLogger(__name__)

#: Most sources one sheet shows. Past a 4x3 grid, a tile at the 1280px ceiling is too small
#: to judge framing in, which is the reason to look.
MAX_SHEET_SOURCES = 12
#: Longest edge of a sheet when the caller names none. Larger than a single frame's default
#: (512): a sheet splits its pixels between up to twelve pictures.
DEFAULT_SHEET_MAX_DIMENSION = 1024
#: Pixels between tiles and around the sheet.
_GAP = 4
_BACKGROUND = (24, 24, 24)
_LABEL_BACKGROUND = (0, 0, 0)
_LABEL_TEXT = (255, 255, 255)
_ERROR_TEXT = (255, 120, 120)
_JPEG_QUALITY = 85
#: Label font size bounds (pixels). The floor keeps a 512px sheet's labels readable.
_MIN_FONT = 12
_MAX_FONT = 18
#: Sheet longest edge per label-font pixel: 1024px -> 16px labels.
_SHEET_PIXELS_PER_FONT_PIXEL = 64


@dataclass(frozen=True)
class SheetSource:
    """One source to show: the asset, and when in it (``None`` = its representative instant)."""

    asset_id: str
    seconds: float | None = None


@dataclass(frozen=True)
class SheetTile:
    """What one tile shows, in the order the sheet numbers them (``index`` is 1-based)."""

    index: int
    asset_id: str
    name: str
    seconds: float
    duration_seconds: float
    #: Why this tile has no picture, when it has none.
    error: str | None = None


@dataclass(frozen=True)
class SourceSheet:
    """The encoded sheet and its tiles, in reading order (left to right, top to bottom)."""

    data: bytes
    media_type: str
    width: int
    height: int
    columns: int
    rows: int
    tiles: tuple[SheetTile, ...]


def grid_shape(count: int) -> tuple[int, int]:
    """``(columns, rows)`` for ``count`` tiles: as square as possible, wider than tall.

    1 -> 1x1, 2 -> 2x1, 4 -> 2x2, 6 -> 3x2, 9 -> 3x3, 12 -> 4x3.
    """
    if count < 1:
        raise FrameGrabError("A source sheet needs at least one source.")
    columns = math.ceil(math.sqrt(count))
    return columns, math.ceil(count / columns)


def representative_seconds(asset: Asset, duration: float) -> float:
    """The instant a tile shows when the caller names none: the middle of the source.

    The middle rather than the start: a camera clip's first second is the operator settling
    the shot, and the ledger's representative frame is not on the project document this
    route receives (it would cost a brain lookup per tile). A still has one instant.
    """
    if asset.kind == "image":
        return 0.0
    return max(0.0, duration / 2.0)


def _asset_name(asset: Asset) -> str:
    return Path(asset.path).name or asset.id


def _resolve_assets(project: Project, sources: list[SheetSource]) -> list[Asset]:
    """The asset behind every source, or ONE error naming every id that has no picture.

    A wrong id is the model's mistake to fix, so it refuses the sheet rather than drawing a
    blank tile the model could mistake for a black shot.
    """
    by_id = {asset.id: asset for asset in project.assets}
    missing = [source.asset_id for source in sources if source.asset_id not in by_id]
    if missing:
        raise FrameGrabError(
            f"Asset not found: {', '.join(missing)}. Use ids from list_assets or the media bin."
        )
    silent = [
        source.asset_id
        for source in sources
        if by_id[source.asset_id].kind not in ("video", "image")
    ]
    if silent:
        raise FrameGrabError(
            f"No picture to show for {', '.join(silent)} (audio). Pass video or image assets."
        )
    return [by_id[source.asset_id] for source in sources]


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    from PIL import ImageFont

    # Pillow's bundled font at a real size (Pillow >= 10.1): no system font lookup, so the
    # labels are the same pixels on every machine.
    return ImageFont.load_default(size=size)


def _fit_label(text: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont, width: int) -> str:
    """``text`` shortened with an ellipsis until it fits ``width`` pixels."""
    if font.getlength(text) <= width:
        return text
    trimmed = text
    while trimmed and font.getlength(trimmed + "…") > width:
        trimmed = trimmed[:-1]
    return trimmed + "…"


def _layout(
    count: int, max_dimension: int, cell_aspect: float
) -> tuple[int, int, int, int, int, int]:
    """``(columns, rows, cell_width, cell_height, label_height, font_size)`` within the cap."""
    columns, rows = grid_shape(count)
    font_size = max(_MIN_FONT, min(_MAX_FONT, max_dimension // _SHEET_PIXELS_PER_FONT_PIXEL))
    label_height = font_size + 8
    cell_width = (max_dimension - (columns + 1) * _GAP) // columns
    cell_height = round(cell_width / cell_aspect)
    total_height = rows * (cell_height + label_height) + (rows + 1) * _GAP
    if total_height > max_dimension:
        cell_height = (max_dimension - (rows + 1) * _GAP) // rows - label_height
        cell_width = round(cell_height * cell_aspect)
    return columns, rows, max(1, cell_width), max(1, cell_height), label_height, font_size


def _cell_aspect(assets: list[Asset]) -> float:
    """The median source aspect: all-landscape sources get landscape cells, and so on."""
    aspects = []
    for asset in assets:
        size = asset.media.display_size() if asset.media is not None else None
        aspects.append(size[0] / size[1] if size and size[1] > 0 else 16 / 9)
    aspects.sort()
    return aspects[len(aspects) // 2]


def _paste_fitted(sheet: PILImage.Image, pixels: Any, box: tuple[int, int, int, int]) -> None:
    """Scale the frame into ``box`` (never up), centred, letterboxed on the sheet background."""
    from PIL import Image

    x, y, width, height = box
    image = Image.fromarray(pixels).convert("RGB")
    scale = min(width / image.width, height / image.height, 1.0)
    target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    if target != image.size:
        image = image.resize(target, Image.Resampling.LANCZOS)
    sheet.paste(image, (x + (width - target[0]) // 2, y + (height - target[1]) // 2))


def grab_source_sheet(
    project: Project,
    base_dir: Path,
    sources: list[SheetSource],
    *,
    max_dimension: int = DEFAULT_SHEET_MAX_DIMENSION,
    image_format: str = "jpeg",
) -> SourceSheet:
    """Render every source as shot and tile them into one labelled image.

    :param project: The project that holds the assets.
    :param base_dir: The project directory; assets are sandbox-resolved against it.
    :param sources: 1..:data:`MAX_SHEET_SOURCES` sources, in the order the tiles are
        numbered. The same asset may appear twice (two moments of one clip).
    :param max_dimension: Longest edge of the whole sheet, clamped to
        :data:`MAX_ALLOWED_DIMENSION`.
    :param image_format: ``"jpeg"`` or ``"png"``.
    :returns: The sheet and its tiles in order.
    :raises FrameGrabError: For no sources, too many, an unknown or audio-only asset, an
        unsupported format, or when no tile could be rendered at all. A tile that fails on
        its own is drawn as a labelled error and the rest of the sheet still answers.
    """
    from PIL import Image, ImageDraw

    if not sources:
        raise FrameGrabError("A source sheet needs at least one source.")
    if len(sources) > MAX_SHEET_SOURCES:
        raise FrameGrabError(
            f"A source sheet shows at most {MAX_SHEET_SOURCES} sources; got {len(sources)}. "
            "Split them across calls."
        )
    fmt = image_format.lower()
    if fmt not in {"jpeg", "png"}:
        raise FrameGrabError(f"Unsupported image format {image_format!r}; use 'jpeg' or 'png'.")
    assets = _resolve_assets(project, sources)
    sheet_dimension = min(max(128, int(max_dimension)), MAX_ALLOWED_DIMENSION)
    columns, rows, cell_w, cell_h, label_h, font_size = _layout(
        len(sources), sheet_dimension, _cell_aspect(assets)
    )
    width = columns * cell_w + (columns + 1) * _GAP
    height = rows * (cell_h + label_h) + (rows + 1) * _GAP
    sheet = Image.new("RGB", (width, height), _BACKGROUND)
    draw = ImageDraw.Draw(sheet)
    font = _load_font(font_size)

    started = time.monotonic()
    tiles: list[SheetTile] = []
    for position, (source, asset) in enumerate(zip(sources, assets, strict=True)):
        view, length = source_view_project(project, asset.id)
        wanted = representative_seconds(asset, length) if source.seconds is None else source.seconds
        x = _GAP + (position % columns) * (cell_w + _GAP)
        y = _GAP + (position // columns) * (cell_h + label_h + _GAP)
        error: str | None = None
        seconds = wanted
        try:
            pixels, seconds, _duration = render_frame_pixels(
                view, base_dir, wanted, max_dimension=max(cell_w, cell_h), burn_captions=False
            )
            _paste_fitted(sheet, pixels, (x, y, cell_w, cell_h))
        except FrameGrabError as exc:
            error = str(exc)
            _log.warning("source sheet: tile %d (%s) failed: %s", position + 1, asset.id, exc)
            draw.text(
                (x + 6, y + 6),
                _fit_label("could not render", font, cell_w - 12),
                fill=_ERROR_TEXT,
                font=font,
            )
        index = position + 1
        name = _asset_name(asset)
        label = f"{index}  {name}  {seconds:.1f}s"
        draw.rectangle((x, y + cell_h, x + cell_w - 1, y + cell_h + label_h - 1), _LABEL_BACKGROUND)
        draw.text(
            (x + 4, y + cell_h + (label_h - font_size) // 2 - 1),
            _fit_label(label, font, cell_w - 8),
            fill=_LABEL_TEXT,
            font=font,
        )
        tiles.append(
            SheetTile(
                index=index,
                asset_id=asset.id,
                name=name,
                seconds=round(seconds, 3),
                duration_seconds=round(length, 3),
                error=error,
            )
        )
    if all(tile.error is not None for tile in tiles):
        raise FrameGrabError(f"No source in the sheet could be rendered: {tiles[0].error}")

    buffer = io.BytesIO()
    try:
        if fmt == "jpeg":
            sheet.save(buffer, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
            media_type = "image/jpeg"
        else:
            sheet.save(buffer, format="PNG", optimize=True)
            media_type = "image/png"
    except Exception as exc:
        raise FrameGrabError(f"Rendered the source sheet but could not encode it: {exc}") from exc
    data = buffer.getvalue()
    _log.info(
        "ACT source sheet: %d sources grid=%dx%d size=%dx%d bytes=%d failed=%d in %.2fs",
        len(tiles),
        columns,
        rows,
        width,
        height,
        len(data),
        sum(tile.error is not None for tile in tiles),
        time.monotonic() - started,
    )
    return SourceSheet(
        data=data,
        media_type=media_type,
        width=width,
        height=height,
        columns=columns,
        rows=rows,
        tiles=tuple(tiles),
    )
