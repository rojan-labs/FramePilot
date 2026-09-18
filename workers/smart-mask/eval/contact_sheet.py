"""The eval's contact sheet for human review (plan 06 "Harness").

One row per scored clip, at its worst frame: the source, the composite over magenta, the
composite over a text layer (text behind the subject, the main use case), the matte, an error
heat map (|α - ground truth|, black = exact), and a strip underneath comparing, frame by frame,
what verification flagged (top) with what was actually wrong by the 06 rule (bottom):
green = verified and right, red = verified but wrong (a silent miss), amber = flagged and wrong
(caught), grey = flagged but right (review load spent on a good frame).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import numpy.typing as npt

U8 = npt.NDArray[np.uint8]
TILE_W, TILE_H = 256, 144
STRIP_H = 12
LABEL_H = 18
MAGENTA = np.array([255, 0, 255], np.float32)
COLOURS = {
    "right": (46, 160, 67),
    "silent": (220, 38, 38),
    "caught": (245, 158, 11),
    "spent": (140, 140, 140),
}


@dataclass
class SheetRow:
    name: str
    frame: int
    source_rgb: U8
    matte: U8
    truth: U8
    flagged: list[bool]
    wrong: list[bool | None]  # None: no ground truth on that frame (human keyframes only)


def _tile(image: U8) -> U8:
    tile: U8 = cv2.resize(image, (TILE_W, TILE_H), interpolation=cv2.INTER_AREA)
    return tile


def _over(rgb: U8, alpha: U8, background: npt.NDArray[np.float32]) -> U8:
    a = alpha.astype(np.float32)[..., None] / 255.0
    out: U8 = (rgb.astype(np.float32) * a + background * (1.0 - a)).clip(0, 255).astype(np.uint8)
    return out


def _text_layer(height: int, width: int) -> npt.NDArray[np.float32]:
    layer = np.full((height, width, 3), (24, 32, 48), np.uint8)
    scale = height / 180
    cv2.putText(layer, "BEHIND", (int(width * 0.08), int(height * 0.62)), cv2.FONT_HERSHEY_DUPLEX,
                2.4 * scale, (250, 250, 250), max(1, int(5 * scale)), cv2.LINE_AA)  # fmt: skip
    out: npt.NDArray[np.float32] = layer.astype(np.float32)
    return out


def _strip(flagged: list[bool], wrong: list[bool | None]) -> U8:
    strip = np.full((STRIP_H, TILE_W * 6, 3), 255, np.uint8)
    count = max(len(flagged), 1)
    for index, (flag, bad) in enumerate(zip(flagged, wrong, strict=True)):
        x0, x1 = index * TILE_W * 6 // count, (index + 1) * TILE_W * 6 // count
        if bad is None:
            outcome = (210, 210, 210)
        elif bad:
            outcome = COLOURS["caught"] if flag else COLOURS["silent"]
        else:
            outcome = COLOURS["spent"] if flag else COLOURS["right"]
        strip[: STRIP_H // 2, x0:x1] = COLOURS["caught"] if flag else COLOURS["right"]
        strip[STRIP_H // 2 :, x0:x1] = outcome
    return strip


def row_image(row: SheetRow) -> U8:
    height, width = row.matte.shape
    heat = np.abs(row.matte.astype(np.int16) - row.truth.astype(np.int16)).astype(np.uint8)
    heat_rgb = cv2.applyColorMap(heat, cv2.COLORMAP_INFERNO)[..., ::-1]
    tiles = [
        row.source_rgb,
        _over(row.source_rgb, row.matte, MAGENTA),
        _over(row.source_rgb, row.matte, _text_layer(height, width)),
        np.repeat(row.matte[..., None], 3, axis=2),
        heat_rgb,
        np.repeat(row.truth[..., None], 3, axis=2),
    ]
    band = np.concatenate([_tile(np.ascontiguousarray(tile)) for tile in tiles], axis=1)
    label = np.full((LABEL_H, band.shape[1], 3), 255, np.uint8)
    cv2.putText(label, f"{row.name}  frame {row.frame}   source | over magenta | text behind | "
                "matte | |error| | ground truth", (4, 13), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1,
                cv2.LINE_AA)  # fmt: skip
    return np.concatenate([label, band, _strip(row.flagged, row.wrong)], axis=0)


def write_sheet(rows: list[SheetRow], path: Path, title: str) -> Path:
    """Write the sheet as a JPEG (quality 88): a few hundred KB for 20 clips."""
    header = np.full((40, TILE_W * 6, 3), 255, np.uint8)
    cv2.putText(header, title, (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)
    legend = ("strip: top = flagged (amber) / verified (green); bottom = caught (amber), "
              "silent miss (red), right (green), review spent on a right frame (grey)")  # fmt: skip
    cv2.putText(
        header, legend, (6, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.3, (60, 60, 60), 1, cv2.LINE_AA
    )
    sheet = np.concatenate([header, *[row_image(row) for row in rows]], axis=0)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), sheet[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 88]):
        raise OSError(f"could not write {path.name}")
    return path


__all__ = ["SheetRow", "row_image", "write_sheet"]
