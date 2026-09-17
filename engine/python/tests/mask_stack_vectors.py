"""Write the preview mask stack's exact vectors (MK3.2) into ``tests/fixtures/mask-raster``.

The TypeScript preview (``apps/web-editor/src/preview/masks``) draws a clip's v22 mask stack
itself, so the parts of the export it mirrors beyond the shape rasteriser need their own
byte-exact vectors:

* ``legacy.json``: the ``gaussian-legacy`` path, :func:`render.masks.rasterize_mask` (Pillow
  ``ImageDraw`` rectangle/ellipse/polygon + ``GaussianBlur``) for frame-fraction specs at four
  resolutions. ``expected[].pixels`` is base64 of the Pillow ``L`` bytes (invert off, opacity 1).
* ``stack-clips.json``: whole clips through :func:`render.mask_stack.clip_mask_stacks` at
  clip-relative times and frame sizes: source clock, keyframes, crop, pixel/normalized units,
  the legacy spec recovery, multi-mask stacks, effect targets. ``expected[].sha256`` is the
  SHA-256 of the float64 little-endian alpha the export attaches (rows top to bottom); the
  TypeScript twin must produce the identical 8 bytes per pixel.

Run after a deliberate change::

    pnpm mask-raster:vectors

``test_mask_stack_vectors.py`` fails when the stored vectors no longer match the engine.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

from framepilot_engine.render.mask_stack import clip_mask_stacks
from framepilot_engine.render.masks import MaskSpec, rasterize_mask
from framepilot_engine.timeline.models import Clip

_log = logging.getLogger(__name__)

REPO = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO / "tests" / "fixtures" / "mask-raster"
LEGACY_RESOLUTIONS = ((64, 48), (40, 30), (23, 17), (96, 54))

_STAR = (
    (0.5, 0.05),
    (0.61, 0.38),
    (0.95, 0.4),
    (0.66, 0.6),
    (0.77, 0.95),
    (0.5, 0.74),
    (0.23, 0.95),
    (0.34, 0.6),
    (0.05, 0.4),
    (0.39, 0.38),
)

LEGACY_CASES: list[dict[str, Any]] = [
    {"id": "rect-fractional", "spec": {"x": 0.2, "y": 0.3, "width": 0.45, "height": 0.37}},
    {"id": "rect-full", "spec": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}},
    {"id": "rect-off-frame", "spec": {"x": -0.1, "y": 0.8, "width": 0.5, "height": 0.5}},
    {"id": "rect-tiny", "spec": {"x": 0.5, "y": 0.5, "width": 0.001, "height": 0.001}},
    {
        "id": "rect-feathered",
        "spec": {"x": 0.25, "y": 0.2, "width": 0.5, "height": 0.6, "feather": 0.05},
    },
    {
        "id": "ellipse",
        "spec": {"shape": "ellipse", "x": 0.13, "y": 0.21, "width": 0.61, "height": 0.52},
    },
    {
        "id": "ellipse-wide",
        "spec": {"shape": "ellipse", "x": 0.02, "y": 0.4, "width": 0.97, "height": 0.21},
    },
    {
        "id": "ellipse-off-frame",
        "spec": {"shape": "ellipse", "x": 0.6, "y": -0.2, "width": 0.7, "height": 0.6},
    },
    {
        "id": "ellipse-tiny",
        "spec": {"shape": "ellipse", "x": 0.4, "y": 0.4, "width": 0.02, "height": 0.03},
    },
    {
        "id": "ellipse-feathered",
        "spec": {
            "shape": "ellipse",
            "x": 0.1,
            "y": 0.1,
            "width": 0.8,
            "height": 0.8,
            "feather": 0.02,
        },
    },
    {
        "id": "polygon-triangle",
        "spec": {"shape": "polygon", "points": [(0.1, 0.9), (0.5, 0.07), (0.93, 0.8)]},
    },
    {"id": "polygon-star", "spec": {"shape": "polygon", "points": list(_STAR)}},
    {
        "id": "polygon-axis-aligned",
        "spec": {
            "shape": "polygon",
            "points": [(0.1, 0.1), (0.5, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)],
        },
    },
    {
        "id": "polygon-bowtie",
        "spec": {"shape": "polygon", "points": [(0.1, 0.1), (0.9, 0.9), (0.9, 0.1), (0.1, 0.9)]},
    },
    {
        "id": "polygon-off-frame",
        "spec": {"shape": "polygon", "points": [(-0.2, 0.21), (1.2, 0.35), (0.6, 1.4)]},
    },
    {
        "id": "polygon-wide-feather",
        "spec": {
            "shape": "polygon",
            "points": [(0.2, 0.2), (0.8, 0.25), (0.5, 0.85)],
            "feather": 0.3,
        },
    },
    {
        "id": "rect-hairline-feather",
        "spec": {"x": 0.3, "y": 0.3, "width": 0.4, "height": 0.4, "feather": 0.001},
    },
    {
        "id": "polygon-two-points-is-bounds",
        "spec": {
            "shape": "polygon",
            "x": 0.3,
            "y": 0.2,
            "width": 0.3,
            "height": 0.4,
            "points": [(0.1, 0.1), (0.9, 0.9)],
        },
    },
]


def _spec(raw: dict[str, Any]) -> MaskSpec:
    fields = {**raw}
    if "points" in fields:
        fields["points"] = tuple(tuple(point) for point in fields["points"])
    return MaskSpec(**fields)


def _legacy_document() -> dict[str, Any]:
    cases = []
    for case in LEGACY_CASES:
        spec = _spec(case["spec"])
        expected = []
        for width, height in LEGACY_RESOLUTIONS:
            alpha = rasterize_mask(spec, width, height)
            pixels = np.rint(alpha * 255.0).astype(np.uint8)
            expected.append(
                {
                    "width": width,
                    "height": height,
                    "pixels": base64.b64encode(pixels.tobytes()).decode("ascii"),
                }
            )
        raw = {**case["spec"]}
        if "points" in raw:
            raw["points"] = [list(point) for point in raw["points"]]
        cases.append({"id": case["id"], "spec": raw, "expected": expected})
    return {
        "area": "legacy",
        "spec": "engine/python/tests/mask_stack_vectors.py; render/masks.py rasterize_mask",
        "cases": cases,
    }


# --- Whole clips ------------------------------------------------------------------------


def _frame_times(clip: dict[str, Any], fps: float) -> list[float]:
    """Up to four clip-local frame times: first, two interior, last."""
    start, end = float(clip["start"]), float(clip["end"])
    count = max(1, math.ceil((end - start) * fps - 1e-9))
    picks = sorted({0, count // 3, (2 * count) // 3, count - 1})
    return [index / fps for index in picks]


def _migrated_clip_cases() -> list[dict[str, Any]]:
    source = json.loads(
        (REPO / "tests" / "fixtures" / "mask-render" / "legacy-v21.json").read_text("utf-8")
    )
    migrated = json.loads(
        (REPO / "tests" / "fixtures" / "mask-render" / "legacy-v21.migrated.json").read_text(
            "utf-8"
        )
    )
    by_id = {case["id"]: case for case in source["cases"]}
    cases = []
    for case in migrated["cases"]:
        clip = case["clip"]
        media = by_id[case["id"]].get("media", source["media"])
        crop = clip.get("crop") or {"width": 1.0, "height": 1.0}
        full = (
            round(crop["width"] * source["media"]["width"]),
            round(crop["height"] * source["media"]["height"]),
        )
        cases.append(
            {
                "id": f"migrated/{case['id']}",
                "clip": clip,
                "media": media,
                "sizes": [list(full), [full[0] // 2, full[1] // 2]],
                "times": _frame_times(clip, float(source["fps"])),
            }
        )
    return cases


def _mask(**fields: Any) -> dict[str, Any]:
    return {"id": fields.pop("id"), **fields}


def _clip(clip_id: str, masks: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {
        "id": clip_id,
        "assetId": "port",
        "trackId": "v1",
        "start": 0.0,
        "end": 2.0,
        "sourceStart": 2.0,
        "sourceEnd": 4.0,
        "effects": [],
        "keyframes": [],
        "masks": masks,
        **extra,
    }


_HOLE_PATH = [400, 800, 0, 0, 0, 0, 700, 800, 0, 0, 0, 0, 550, 1100, 0, 0, 0, 0]
_CURVED_PATH = [
    300, 500, 0, -120, 0, 120,
    760, 620, 60, -90, -60, 90,
    820, 1400, 120, 0, -120, 0,
    240, 1300, 0, 150, 0, -150,
]  # fmt: skip
_PORT = {"width": 1080, "height": 1920}

#: Stacks the oracle's `alpha/*` mask rows draw, rasterised at the decode sizes they land at.
STACK_CASES: list[dict[str, Any]] = [
    {
        "id": "stack/legacy-ellipse-over-subtracted-path",
        "clip": _clip(
            "m2",
            [
                _mask(
                    id="m2__mask",
                    kind="ellipse",
                    featherModel="gaussian-legacy",
                    cx=270,
                    cy=960,
                    rx=270,
                    ry=480,
                    keyframes=[
                        {
                            "id": "k0",
                            "sourceTime": 2.0,
                            "property": "cx",
                            "value": 270,
                            "easing": "linear",
                        },
                        {
                            "id": "k1",
                            "sourceTime": 4.0,
                            "property": "cx",
                            "value": 810,
                            "easing": "linear",
                        },
                    ],
                ),
                _mask(
                    id="m2__hole",
                    kind="path",
                    mode="subtract",
                    invert=True,
                    featherOuterPx=12,
                    pathKeyframes=[
                        {
                            "id": "p0",
                            "sourceTime": 2.0,
                            "points": _HOLE_PATH,
                            "vertexTypes": [0, 0, 0],
                        }
                    ],
                ),
                _mask(
                    id="m2__off", kind="rectangle", enabled=False, cx=10, cy=10, width=5, height=5
                ),
            ],
        ),
        "media": _PORT,
        "sizes": [[406, 720], [203, 360]],
        "times": [0.0, 0.5, 1.0],
    },
    *[
        {
            "id": f"stack/mode-{mode}",
            "clip": _clip(
                f"mode-{mode}",
                [
                    _mask(
                        id="a",
                        kind="rectangle",
                        cx=460,
                        cy=900,
                        width=620,
                        height=1100,
                        rotation=12,
                        roundness=0.25,
                        featherOuterPx=30,
                        opacity=0.9,
                    ),
                    _mask(
                        id="b",
                        kind="ellipse",
                        mode=mode,
                        cx=640,
                        cy=1000,
                        rx=300,
                        ry=420,
                        featherInnerPx=20,
                        featherOuterPx=10,
                        falloff="linear",
                        opacity=0.7,
                    ),
                ],
            ),
            "media": _PORT,
            "sizes": [[406, 720]],
            "times": [0.0],
        }
        for mode in ("add", "subtract", "intersect", "difference", "lighten", "darken")
    ],
    {
        "id": "stack/path-per-vertex-expanded-keyframed",
        "clip": _clip(
            "pv",
            [
                _mask(
                    id="pv",
                    kind="path",
                    expansionPx=-18,
                    featherInnerPx=6,
                    falloff="gaussian",
                    firstVertex=1,
                    pathKeyframes=[
                        {
                            "id": "p0",
                            "sourceTime": 2.0,
                            "points": _CURVED_PATH,
                            "vertexTypes": [1, 1, 1, 1],
                            "featherPx": [0, 40, 10, 25],
                            "easing": "ease-in-out",
                        },
                        {
                            "id": "p1",
                            "sourceTime": 4.0,
                            "points": [
                                v + (30 if i % 6 == 0 else 0) for i, v in enumerate(_CURVED_PATH)
                            ],
                            "vertexTypes": [1, 1, 1, 1],
                            "featherPx": [10, 20, 30, 5],
                        },
                    ],
                )
            ],
        ),
        "media": _PORT,
        "sizes": [[406, 720], [135, 240]],
        "times": [0.0, 0.7, 1.9],
    },
    {
        "id": "stack/invert-cropped-scalar-keyframes",
        "clip": _clip(
            "ck",
            [
                _mask(
                    id="ck",
                    kind="rectangle",
                    invert=True,
                    cx=540,
                    cy=960,
                    width=500,
                    height=700,
                    expansionPx=15,
                    keyframes=[
                        {
                            "id": "o0",
                            "sourceTime": 2.0,
                            "property": "opacity",
                            "value": 0.2,
                            "easing": "ease-out",
                        },
                        {
                            "id": "o1",
                            "sourceTime": 3.5,
                            "property": "opacity",
                            "value": 1.0,
                            "easing": "linear",
                        },
                        {
                            "id": "r0",
                            "sourceTime": 2.5,
                            "property": "rotation",
                            "value": -20,
                            "easing": "linear",
                        },
                        {
                            "id": "r1",
                            "sourceTime": 3.0,
                            "property": "rotation",
                            "value": 25,
                            "easing": "hold",
                        },
                    ],
                )
            ],
            crop={"x": 0.1, "y": 0.05, "width": 0.8, "height": 0.7},
            speed=0.75,
        ),
        "media": _PORT,
        "sizes": [[324, 538]],
        "times": [0.0, 0.6, 1.2, 1.9],
    },
    {
        "id": "stack/effect-target-and-alpha",
        "clip": _clip(
            "fx",
            [
                _mask(id="cut", kind="ellipse", cx=540, cy=960, rx=500, ry=900),
                _mask(
                    id="face",
                    kind="ellipse",
                    target={"kind": "effect", "effectId": "grade1"},
                    cx=540,
                    cy=700,
                    rx=200,
                    ry=260,
                    featherOuterPx=24,
                ),
                _mask(
                    id="face-hole",
                    kind="rectangle",
                    mode="subtract",
                    target={"kind": "effect", "effectId": "grade1"},
                    cx=540,
                    cy=800,
                    width=120,
                    height=60,
                ),
            ],
            effects=[
                {
                    "id": "grade1",
                    "type": "color_grade",
                    "params": {"saturation": -1, "exposure": 0.4},
                }
            ],
        ),
        "media": _PORT,
        "sizes": [[406, 720]],
        "times": [0.0],
        "effects": ["grade1"],
    },
]


def _digest(alpha: np.ndarray | None) -> str | None:
    if alpha is None:
        return None
    return hashlib.sha256(np.ascontiguousarray(alpha, dtype="<f8").tobytes()).hexdigest()


def _clip_document() -> dict[str, Any]:
    cases = []
    for case in [*_migrated_clip_cases(), *STACK_CASES]:
        clip = Clip.model_validate(case["clip"])
        media = case["media"]
        size = None if media is None else (float(media["width"]), float(media["height"]))
        stacks = clip_mask_stacks(clip, size)
        assert stacks is not None, case["id"]
        expected = []
        for width, height in case["sizes"]:
            for t in case["times"]:
                entry: dict[str, Any] = {
                    "width": width,
                    "height": height,
                    "time": t,
                    "alpha": _digest(stacks.alpha_at(t, width, height)),
                }
                for effect_id in case.get("effects", []):
                    entry[f"effect:{effect_id}"] = _digest(
                        stacks.effect_alpha_at(effect_id, t, width, height)
                    )
                expected.append(entry)
        cases.append({**case, "expected": expected})
    return {
        "area": "stack-clips",
        "spec": "engine/python/tests/mask_stack_vectors.py; render/mask_stack.py ClipMaskStacks",
        "cases": cases,
    }


# --- Matte layers (BR5.1) ------------------------------------------------------------------

#: The synthetic matte artifact every matte vector reads: DISPLAY pixels, like a real artifact.
MATTE_SIZE = (48, 27)
_MATTE_ARTIFACT = {
    "key": "d" * 64,
    "files": [
        {"name": "matte.mkv", "sha256": "e" * 64},
        {"name": "foreground.mkv", "sha256": "f" * 64},
        {"name": "frames.json", "sha256": "0" * 64},
    ],
    "width": MATTE_SIZE[0],
    "height": MATTE_SIZE[1],
    "coverage": {"sourceStart": 0.0, "sourceEnd": 10.0},
    "packId": "framepilot.smart-mask",
    "packVersion": "1.0.0",
    "modelDigests": [],
}


def matte_frame_values(maximum: int) -> np.ndarray:
    """A soft disc, a hard one-pixel line and a ramp, stored at ``maximum`` (255 or 65535)."""
    width, height = MATTE_SIZE
    y, x = np.mgrid[0:height, 0:width].astype(np.float64)
    disc = np.clip(9.5 - np.hypot(x - 17.0, y - 13.0), 0.0, 1.0)
    ramp = np.clip((x - 30.0) / 12.0, 0.0, 1.0) * (y > 6)
    alpha = np.maximum(disc, ramp)
    alpha[:, 44] = 1.0
    alpha[3, :] = 0.5
    dtype = np.uint16 if maximum > 255 else np.uint8
    return np.rint(alpha * maximum).astype(dtype)


def matte_foreground() -> np.ndarray:
    width, height = MATTE_SIZE
    y, x = np.mgrid[0:height, 0:width].astype(np.int64)
    return np.stack([(x * 11 + 40) & 255, (y * 9 + 7) & 255, (x * y) & 255], axis=-1).astype(
        np.uint8
    )


def matte_picture(width: int, height: int) -> np.ndarray:
    """The decoded, cropped picture a decontamination vector cleans (both sides make it)."""
    y, x = np.mgrid[0:height, 0:width].astype(np.int64)
    return np.stack(
        [(x * 13 + y * 7) & 255, (x * 5 + y * 3 + 40) & 255, (x ^ y) & 255], axis=-1
    ).astype(np.uint8)


def _matte(**fields: Any) -> dict[str, Any]:
    return _mask(kind="matte", artifact=_MATTE_ARTIFACT, **fields)


def _matte_clip(clip_id: str, masks: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {**_clip(clip_id, masks, **extra), "assetId": "land"}


_MATTE_MEDIA = {"width": MATTE_SIZE[0], "height": MATTE_SIZE[1]}
_MATTE_SIZES = [[48, 27], [32, 18], [96, 54], [40, 30]]

MATTE_CASES: list[dict[str, Any]] = [
    {
        "id": "matte/sharp-decontaminate",
        "clip": _matte_clip("ms", [_matte(id="m", edgeMode="sharp")]),
    },
    {
        "id": "matte/smooth-grow-fraction",
        "clip": _matte_clip("mg", [_matte(id="m", edgeShiftPx=1.5, decontaminate=False)]),
    },
    {
        "id": "matte/shrink-invert-opacity",
        "clip": _matte_clip(
            "mi", [_matte(id="m", edgeShiftPx=-2, invert=True, opacity=0.6, decontaminate=False)]
        ),
    },
    {
        "id": "matte/feather-expansion-gaussian",
        "clip": _matte_clip(
            "mf",
            [
                _matte(
                    id="m",
                    expansionPx=2,
                    featherOuterPx=3,
                    featherInnerPx=1.5,
                    falloff="gaussian",
                )
            ],
        ),
    },
    {
        "id": "matte/feather-smooth-contract",
        "clip": _matte_clip(
            "mc", [_matte(id="m", expansionPx=-1.25, featherOuterPx=2, falloff="smooth")]
        ),
    },
    {
        "id": "matte/finesse-clean-levels",
        "clip": _matte_clip(
            "ml",
            [_matte(id="m", edgeMode="sharp", finesse={"cleanBlack": 0.2, "cleanWhite": 0.7})],
        ),
    },
    {
        "id": "matte/finesse-threshold",
        "clip": _matte_clip("mt", [_matte(id="m", finesse={"cleanBlack": 0.5, "cleanWhite": 0.5})]),
    },
    {
        "id": "matte/cropped-minus-rectangle",
        "clip": _matte_clip(
            "mr",
            [
                _matte(id="m", edgeShiftPx=0.5),
                _mask(
                    id="stand", kind="rectangle", mode="subtract", cx=30, cy=20, width=8, height=12
                ),
            ],
            crop={"x": 0.1, "y": 0.2, "width": 0.7, "height": 0.75},
        ),
    },
    {
        "id": "matte/effect-target-and-alpha",
        "clip": _matte_clip(
            "me",
            [
                _matte(id="cut", decontaminate=False),
                _matte(
                    id="bg",
                    invert=True,
                    target={"kind": "effect", "effectId": "grade1"},
                ),
            ],
            effects=[{"id": "grade1", "type": "color_grade", "params": {"exposure": -1}}],
        ),
        "effects": ["grade1"],
    },
    {
        "id": "matte/gray16",
        "clip": _matte_clip("m16", [_matte(id="m", edgeShiftPx=-0.75, featherOuterPx=1)]),
        "maximum": 65535,
    },
    {
        "id": "matte/keyframed-shift-ramped",
        "clip": _matte_clip(
            "mk",
            [
                _matte(
                    id="m",
                    keyframes=[
                        {
                            "id": "s0",
                            "sourceTime": 2.0,
                            "property": "edgeShiftPx",
                            "value": -1,
                            "easing": "linear",
                        },
                        {
                            "id": "s1",
                            "sourceTime": 4.0,
                            "property": "edgeShiftPx",
                            "value": 2.5,
                            "easing": "linear",
                        },
                    ],
                )
            ],
            speedRamp=[
                {"id": "r0", "sourceTime": 0.0, "rate": 1.0, "easing": "ease-in-out"},
                {"id": "r1", "sourceTime": 2.0, "rate": 2.0},
            ],
        ),
        "times": [0.0, 0.45, 1.1],
    },
]


def _float_digest(values: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(values, dtype="<f8").tobytes()).hexdigest()


def _matte_document() -> dict[str, Any]:
    from framepilot_engine.render.matte_edges import _crop_slices, decontaminate
    from framepilot_engine.render.mattes import MatteFrame

    cases = []
    for case in MATTE_CASES:
        maximum = int(case.get("maximum", 255))
        values = matte_frame_values(maximum)
        foreground = matte_foreground()
        frame = MatteFrame(index=0, alpha=values, maximum=maximum, foreground=foreground)
        clip = Clip.model_validate(case["clip"])
        media = (float(_MATTE_MEDIA["width"]), float(_MATTE_MEDIA["height"]))
        expected = []
        for decoded_w, decoded_h in _MATTE_SIZES:
            rows, cols = _crop_slices(clip, decoded_w, decoded_h)
            width = len(range(*cols.indices(decoded_w)))
            height = len(range(*rows.indices(decoded_h)))
            mattes = {
                str(mask.id): (lambda _t, frame=frame: frame)
                for mask in clip.masks or []
                if mask.kind == "matte"
            }
            stacks = clip_mask_stacks(clip, media, mattes, (decoded_w, decoded_h))
            assert stacks is not None, case["id"]
            for t in case.get("times", [0.0]):
                picture = matte_picture(width, height)
                for mask in reversed([m for m in stacks.matte_masks() if m.decontaminate]):
                    picture = decontaminate(
                        picture, values, maximum, foreground, clip, (decoded_w, decoded_h)
                    )
                entry: dict[str, Any] = {
                    "decoded": [decoded_w, decoded_h],
                    "width": width,
                    "height": height,
                    "time": t,
                    "alpha": _digest(stacks.alpha_at(t, width, height)),
                    "decontaminated": hashlib.sha256(picture.tobytes()).hexdigest(),
                }
                for effect_id in case.get("effects", []):
                    entry[f"effect:{effect_id}"] = _digest(
                        stacks.effect_alpha_at(effect_id, t, width, height)
                    )
                expected.append(entry)
        cases.append(
            {
                **case,
                "maximum": maximum,
                "media": _MATTE_MEDIA,
                "matte": base64.b64encode(
                    values.astype(values.dtype.newbyteorder("<")).tobytes()
                ).decode("ascii"),
                "foreground": base64.b64encode(foreground.tobytes()).decode("ascii"),
                "expected": expected,
            }
        )
    return {
        "area": "matte-clips",
        "spec": (
            "engine/python/tests/mask_stack_vectors.py; render/mask_stack.py matte layers, "
            "render/matte_edges.py decontaminate. Pictures: matte_picture(width, height)."
        ),
        "cases": cases,
    }


def serialize(doc: dict[str, Any]) -> str:
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


DOCUMENTS = {
    "legacy": _legacy_document,
    "stack-clips": _clip_document,
    "matte-clips": _matte_document,
}


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for name, build in DOCUMENTS.items():
        path = FIXTURE_DIR / f"{name}.json"
        document = build()
        path.write_text(serialize(document), encoding="utf-8")
        _log.info("wrote %s (%d cases)", path.name, len(document["cases"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
