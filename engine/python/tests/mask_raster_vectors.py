"""Write the rasteriser's byte-exact vectors into ``tests/fixtures/mask-raster/*.json`` (MK2.3).

The Python half of the ``mask_raster.py`` <-> ``mask-raster.ts`` pair: the engine is the
export, so its quantised alpha is the expected value, and the TypeScript twin (MK3.1) must
reproduce it byte for byte at every resolution. Run after a deliberate change::

    pnpm mask-raster:vectors

``test_mask_raster_vectors.py`` fails when the stored vectors no longer match the engine.

Each case is a stack of layers in SOURCE units (``sourceSize``), rasterised at three
resolutions. A layer's ``shape`` is one of::

    {"kind": "rectangle", "cx", "cy", "width", "height", "rotation", "roundness"}
    {"kind": "ellipse", "cx", "cy", "rx", "ry", "rotation"}
    {"kind": "path", "points": [x, y, inX, inY, outX, outY, ...], "featherPx"?: [...],
     "firstVertex"?: n}
    {"kind": "linear", "originX", "originY", "angle", "softnessPx"}            (MK8.1)
    {"kind": "band", "originX", "originY", "angle", "widthPx", "softnessPx"}
    {"kind": "gradient", "shape": "linear" | "radial", "startX", "startY", "endX", "endY",
     "curve"}

The analytic kinds (split, band, gradient) are drawn by ``analytic_alpha`` with the same
mapping; their expansion and feathers come from the layer like a shape's.

Rasterising a case at a resolution ``{width, height}`` uses ``scaleX = width / sourceW``,
``scaleY = height / sourceH``, zero offsets, and ``distanceScale = min(scaleX, scaleY)`` for
expansion and feathers (per-vertex feathers included). The stack starts at zero; each layer is
``shape_alpha`` -> invert -> opacity -> ``combine`` by mode; the result is quantised once.
``expected[i]`` is base64 of the ``height * width`` uint8 alpha, rows top to bottom.
"""

from __future__ import annotations

import base64
import json
import logging
import sys
from pathlib import Path
from typing import Any

import numpy as np

from framepilot_engine.render import mask_raster as mr

_log = logging.getLogger(__name__)

FIXTURE_DIR = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "mask-raster"
SOURCE = (96, 72)
#: Three raster sizes of the 96x72 source: two uniform downscales and one non-uniform odd one.
RESOLUTIONS = ((64, 48), (40, 30), (23, 17))


def _rect(
    cx: float, cy: float, w: float, h: float, rot: float = 0.0, rnd: float = 0.0
) -> dict[str, Any]:
    return {
        "kind": "rectangle",
        "cx": cx,
        "cy": cy,
        "width": w,
        "height": h,
        "rotation": rot,
        "roundness": rnd,
    }


def _ellipse(cx: float, cy: float, rx: float, ry: float, rot: float = 0.0) -> dict[str, Any]:
    return {"kind": "ellipse", "cx": cx, "cy": cy, "rx": rx, "ry": ry, "rotation": rot}


def _poly(
    *xy: float,
    feather: list[float] | None = None,
    first: int = 0,
    tangents: dict[int, tuple[float, float, float, float]] | None = None,
) -> dict[str, Any]:
    points: list[float] = []
    for index in range(0, len(xy), 2):
        t = (tangents or {}).get(index // 2, (0.0, 0.0, 0.0, 0.0))
        points.extend([xy[index], xy[index + 1], *t])
    shape: dict[str, Any] = {"kind": "path", "points": points, "firstVertex": first}
    if feather is not None:
        shape["featherPx"] = feather
    return shape


def _layer(shape: dict[str, Any], **extra: Any) -> dict[str, Any]:
    layer = {
        "shape": shape,
        "mode": "add",
        "opacity": 1.0,
        "invert": False,
        "expansionPx": 0.0,
        "featherInnerPx": 0.0,
        "featherOuterPx": 0.0,
        "falloff": "smooth",
    }
    layer.update(extra)
    return layer


_CURVED = _poly(
    14,
    12,
    70,
    8,
    84,
    60,
    20,
    58,
    tangents={0: (0, 12, 18, -6), 1: (-14, -4, 10, 14), 2: (6, -16, -30, 6), 3: (14, 6, -8, -14)},
)
_STAR = _poly(48, 4, 57, 28, 88, 30, 62, 46, 72, 70, 48, 55, 24, 70, 34, 46, 8, 30, 39, 28)
#: One closed path tracing two overlapping squares the same way round (winding 2 where they
#: overlap), joined by a bridge walked out and back.
_OVERLAP = _poly(
    10.3,
    10.2,
    60.4,
    10.2,
    60.4,
    50.6,
    10.3,
    50.6,
    10.3,
    10.2,
    30.7,
    20.9,
    80.1,
    20.9,
    80.1,
    62.3,
    30.7,
    62.3,
    30.7,
    20.9,
)
#: A curved figure eight whose crossing falls at a fractional position inside a pixel.
_FIGURE_EIGHT = _poly(
    12.2,
    36.3,
    48.37,
    36.71,
    84.1,
    36.2,
    48.37,
    36.71,
    tangents={0: (0, 20, 0, -20), 1: (-14, -14, 14, 14), 2: (0, -20, 0, 20), 3: (14, -14, -14, 14)},
)
#: A triangle whose one edge carries a loop smaller than a pixel.
_TINY_LOOP = _poly(10, 60, 40.2, 30.3, 40.8, 30.9, 40.3, 30.8, 40.6, 30.2, 86, 12, 80, 66)
_BOWTIE = _poly(10, 10, 86, 62, 86, 10, 10, 62)


def _split(ox: float, oy: float, angle: float = 0.0, softness: float = 0.0) -> dict[str, Any]:
    return {"kind": "linear", "originX": ox, "originY": oy, "angle": angle, "softnessPx": softness}


def _band(
    ox: float, oy: float, angle: float, width: float, softness: float = 0.0
) -> dict[str, Any]:
    return {
        "kind": "band",
        "originX": ox,
        "originY": oy,
        "angle": angle,
        "widthPx": width,
        "softnessPx": softness,
    }


def _gradient(
    shape: str, sx: float, sy: float, ex: float, ey: float, curve: str = "linear"
) -> dict[str, Any]:
    return {
        "kind": "gradient",
        "shape": shape,
        "startX": sx,
        "startY": sy,
        "endX": ex,
        "endY": ey,
        "curve": curve,
    }


ANALYTIC_KINDS = frozenset({"linear", "band", "gradient"})

CASES: dict[str, list[dict[str, Any]]] = {
    "coverage": [
        {"id": "rect-integer", "layers": [_layer(_rect(48, 36, 40, 30))]},
        {"id": "rect-fractional", "layers": [_layer(_rect(47.3, 35.61, 41.27, 29.9))]},
        {"id": "rect-rotated", "layers": [_layer(_rect(48, 36, 50, 28, 17.5))]},
        {"id": "rect-rotated-quarter", "layers": [_layer(_rect(48.25, 36.5, 50, 28, 90))]},
        {"id": "rect-rounded", "layers": [_layer(_rect(48, 36, 60, 40, -8, 0.35))]},
        {"id": "ellipse", "layers": [_layer(_ellipse(48.4, 35.7, 33.3, 24.1))]},
        {"id": "ellipse-rotated", "layers": [_layer(_ellipse(48, 36, 40, 14, 33))]},
        {"id": "path-curved", "layers": [_layer(_CURVED)]},
        {"id": "path-star-concave", "layers": [_layer(_STAR)]},
        {"id": "path-bowtie-nonzero", "layers": [_layer(_BOWTIE)]},
        {"id": "path-overlap-same-direction", "layers": [_layer(_OVERLAP)]},
        {"id": "path-figure-eight-curved", "layers": [_layer(_FIGURE_EIGHT)]},
        {"id": "path-tiny-loop-in-one-pixel", "layers": [_layer(_TINY_LOOP)]},
        {"id": "path-first-vertex", "layers": [_layer({**_CURVED, "firstVertex": 2})]},
        {"id": "subpixel-shape", "layers": [_layer(_ellipse(30.3, 20.6, 0.7, 0.45))]},
        {"id": "past-the-frame", "layers": [_layer(_rect(90, 70, 60, 50, 11))]},
        {"id": "degenerate-zero-size", "layers": [_layer(_rect(48, 36, 0, 20))]},
    ],
    "feather": [
        {
            "id": "outer-linear",
            "layers": [_layer(_rect(48, 36, 40, 30), featherOuterPx=9, falloff="linear")],
        },
        {
            "id": "outer-smooth-ellipse",
            "layers": [_layer(_ellipse(48, 36, 26, 18, 25), featherOuterPx=7.5)],
        },
        {"id": "outer-gaussian", "layers": [_layer(_CURVED, featherOuterPx=6, falloff="gaussian")]},
        {
            "id": "inner-only",
            "layers": [_layer(_ellipse(48, 36, 30, 22), featherInnerPx=8, falloff="linear")],
        },
        {"id": "inner-and-outer", "layers": [_layer(_STAR, featherInnerPx=3, featherOuterPx=5)]},
        {"id": "expand-hard", "layers": [_layer(_rect(48, 36, 30, 20, 30), expansionPx=4.5)]},
        {
            "id": "shrink-feathered",
            "layers": [
                _layer(
                    _ellipse(48, 36, 34, 26), expansionPx=-6, featherOuterPx=4, falloff="gaussian"
                )
            ],
        },
        {
            "id": "per-vertex",
            "layers": [
                _layer(
                    _poly(12, 14, 84, 14, 84, 60, 12, 60, feather=[0, 12, 3, 6]), featherInnerPx=1
                )
            ],
        },
        {
            "id": "per-vertex-curved",
            "layers": [_layer({**_CURVED, "featherPx": [2, 9, 0, 5]}, falloff="gaussian")],
        },
        {
            "id": "rounded-inner-outer",
            "layers": [
                _layer(
                    _rect(48, 36, 64, 44, 0, 0.6),
                    featherInnerPx=4,
                    featherOuterPx=4,
                    falloff="linear",
                )
            ],
        },
    ],
    "analytic": [
        {"id": "split-horizontal", "layers": [_layer(_split(48, 36.3))]},
        {"id": "split-vertical-integer", "layers": [_layer(_split(40, 36, 90))]},
        {"id": "split-diagonal", "layers": [_layer(_split(47.2, 35.9, 33.7))]},
        {"id": "split-steep-negative", "layers": [_layer(_split(30.4, 20.1, -71.25))]},
        {"id": "split-expanded", "layers": [_layer(_split(48, 36, 212, 0), expansionPx=5.5)]},
        {
            "id": "split-soft-smooth",
            "layers": [_layer(_split(48, 36, 17, 12))],
        },
        {
            "id": "split-soft-feathers-gaussian",
            "layers": [
                _layer(
                    _split(52, 30, -40, 4),
                    featherInnerPx=3,
                    featherOuterPx=6,
                    expansionPx=-2,
                    falloff="gaussian",
                )
            ],
        },
        {"id": "split-off-frame", "layers": [_layer(_split(48, -500, 0))]},
        {"id": "band-horizontal", "layers": [_layer(_band(48, 36, 0, 20.5))]},
        {"id": "band-rotated", "layers": [_layer(_band(46.7, 37.2, 58, 18))]},
        {"id": "band-thin", "layers": [_layer(_band(48, 36, 123, 0.6))]},
        {"id": "band-collapsed", "layers": [_layer(_band(48, 36, 30, 4), expansionPx=-3)]},
        {
            "id": "band-soft-linear",
            "layers": [_layer(_band(48, 36, -15, 16, 10), falloff="linear")],
        },
        {
            "id": "band-soft-narrow",
            "layers": [_layer(_band(48, 36, 80, 2, 0), featherOuterPx=7, featherInnerPx=5)],
        },
        {"id": "gradient-linear", "layers": [_layer(_gradient("linear", 10, 20, 80, 50))]},
        {
            "id": "gradient-linear-smooth",
            "layers": [_layer(_gradient("linear", 90, 5, 20, 60, "smooth"))],
        },
        {
            "id": "gradient-radial",
            "layers": [_layer(_gradient("radial", 48.3, 35.6, 78.1, 49.9))],
        },
        {
            "id": "gradient-radial-gaussian",
            "layers": [_layer(_gradient("radial", 20, 60, 60, 10, "gaussian"))],
        },
        {"id": "gradient-zero-length", "layers": [_layer(_gradient("linear", 40, 40, 40, 40))]},
        {
            "id": "split-screen-stack",
            "layers": [
                _layer(_split(48, 36, 90)),
                _layer(_ellipse(60, 36, 20, 16), mode="add", featherOuterPx=3),
                _layer(_band(48, 36, 0, 10, 4), mode="subtract", opacity=0.7),
            ],
        },
        {
            "id": "gradient-over-shape",
            "layers": [
                _layer(_rect(48, 36, 70, 50, 0, 0.3)),
                _layer(_gradient("linear", 48, 10, 48, 62, "smooth"), mode="intersect"),
                _layer(_split(48, 36, 45), mode="lighten", invert=True, opacity=0.25),
            ],
        },
    ],
    "stack": [
        *[
            {
                "id": f"mode-{mode}",
                "layers": [
                    _layer(_rect(40, 36, 44, 40), featherOuterPx=3, opacity=0.8),
                    _layer(
                        _ellipse(58, 36, 24, 20),
                        mode=mode,
                        opacity=0.6,
                        falloff="linear",
                        featherOuterPx=4,
                    ),
                ],
            }
            for mode in ("add", "subtract", "intersect", "difference", "lighten", "darken")
        ],
        {
            "id": "first-subtract-is-empty",
            "layers": [_layer(_rect(48, 36, 40, 30), mode="subtract")],
        },
        {
            "id": "invert-opacity",
            "layers": [
                _layer(_ellipse(48, 36, 30, 20), invert=True, opacity=0.45, featherOuterPx=5)
            ],
        },
        {
            "id": "three-layers",
            "layers": [
                _layer(_rect(48, 36, 80, 60, 0, 0.2)),
                _layer(_STAR, mode="subtract", featherOuterPx=2),
                _layer(_ellipse(48, 36, 10, 10), mode="lighten", invert=True, opacity=0.3),
            ],
        },
    ],
}


def _path_for(shape: dict[str, Any]) -> mr.BezierPath:
    if shape["kind"] == "rectangle":
        return mr.rectangle_path(
            shape["cx"],
            shape["cy"],
            shape["width"],
            shape["height"],
            shape["rotation"],
            shape["roundness"],
        )
    if shape["kind"] == "ellipse":
        return mr.ellipse_path(
            shape["cx"], shape["cy"], shape["rx"], shape["ry"], shape["rotation"]
        )
    return mr.path_from_points(shape["points"], shape.get("featherPx"), shape.get("firstVertex", 0))


def layer_raster(layer: dict[str, Any], width: int, height: int) -> mr.ShapeRaster:
    """A vector layer as a raster-px :class:`~mr.ShapeRaster` at one resolution."""
    scale_x = width / SOURCE[0]
    scale_y = height / SOURCE[1]
    distance = min(scale_x, scale_y)
    polyline = mr.to_raster(mr.flatten_path(_path_for(layer["shape"])), scale_x, scale_y, 0.0, 0.0)
    if polyline.feathers is not None:
        polyline = mr.Polyline(polyline.xs, polyline.ys, polyline.feathers * distance)
    return mr.ShapeRaster(
        polyline=polyline,
        expansion=layer["expansionPx"] * distance,
        feather_inner=layer["featherInnerPx"] * distance,
        feather_outer=layer["featherOuterPx"] * distance,
        falloff=layer["falloff"],
    )


def analytic_shape(layer: dict[str, Any]) -> mr.AnalyticShape:
    """A vector layer of an analytic kind as a source-unit :class:`~mr.AnalyticShape`."""
    shape = layer["shape"]
    if shape["kind"] == "gradient":
        return mr.AnalyticShape(
            kind="gradient",
            gradient_shape=shape["shape"],
            start_x=shape["startX"],
            start_y=shape["startY"],
            end_x=shape["endX"],
            end_y=shape["endY"],
            curve=shape["curve"],
        )
    return mr.AnalyticShape(
        kind=shape["kind"],
        origin_x=shape["originX"],
        origin_y=shape["originY"],
        angle=shape["angle"],
        band_width=shape.get("widthPx", 0.0),
        softness=shape["softnessPx"],
        expansion=layer["expansionPx"],
        feather_inner=layer["featherInnerPx"],
        feather_outer=layer["featherOuterPx"],
        falloff=layer["falloff"],
    )


def layer_float(layer: dict[str, Any], width: int, height: int) -> np.ndarray:
    """One vector layer's alpha before invert and opacity."""
    if layer["shape"]["kind"] in ANALYTIC_KINDS:
        scale_x = width / SOURCE[0]
        scale_y = height / SOURCE[1]
        return mr.analytic_alpha(
            analytic_shape(layer),
            width,
            height,
            scale_x=scale_x,
            scale_y=scale_y,
            offset_x=0.0,
            offset_y=0.0,
            distance_scale=min(scale_x, scale_y),
        )
    return mr.shape_alpha(layer_raster(layer, width, height), width, height)


def stack_float(layers: list[dict[str, Any]], width: int, height: int) -> np.ndarray:
    """The unquantised combined alpha of a case at one resolution."""
    accumulated = np.zeros((height, width), dtype=np.float64)
    for layer in layers:
        alpha = layer_float(layer, width, height)
        alpha = mr.layer_alpha(alpha, invert=layer["invert"], opacity=layer["opacity"])
        accumulated = mr.combine(accumulated, alpha, layer["mode"])
    return accumulated


def encode(alpha: np.ndarray) -> str:
    return base64.b64encode(mr.quantize_alpha(alpha).tobytes()).decode("ascii")


def document(area: str) -> dict[str, Any]:
    cases = []
    for case in CASES[area]:
        cases.append(
            {
                **case,
                "expected": [
                    {"width": w, "height": h, "alpha": encode(stack_float(case["layers"], w, h))}
                    for w, h in RESOLUTIONS
                ],
            }
        )
    return {
        "area": area,
        "spec": "engine/python/tests/mask_raster_vectors.py (format); plan 10, Rasteriser",
        "sourceSize": list(SOURCE),
        "falloffTable": "engine/python/framepilot_engine/render/mask_falloff_gaussian.json",
        "cases": cases,
    }


def serialize(doc: dict[str, Any]) -> str:
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for area in CASES:
        path = FIXTURE_DIR / f"{area}.json"
        path.write_text(serialize(document(area)), encoding="utf-8")
        _log.info("wrote %s (%d cases)", path.name, len(CASES[area]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
