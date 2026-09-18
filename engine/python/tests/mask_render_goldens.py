"""Render goldens for the v22 mask stack (MK2.4, MK8.4): every kind, mode and target.

Each case compiles a real timeline (``compile_timeline``: speed stage, grade, mask stack,
compositing) over a numpy-synthesised picture written losslessly (PNG frames, RGB, no YUV
step) at the output size, so no resize runs and no codec or generator version can move a
pixel. Each sampled frame is recorded as 8x6 block means per channel, compared to within one
level: stable across builds, yet a mask that moved, grew, lost its feather, combined wrongly
or limited the wrong effect is caught.

Regenerate after a deliberate render change::

    pnpm mask-render:goldens

``test_mask_render_golden.py`` compares against ``tests/fixtures/golden/mask_render.json``.
"""

from __future__ import annotations

import json
import logging
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from framepilot_engine.media.assets import index_assets
from framepilot_engine.render.compiler import compile_timeline
from framepilot_engine.render.presets import frame_target
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Project
from tests.matte_fixtures import write_source

_log = logging.getLogger(__name__)

GOLDEN = Path(__file__).parent / "fixtures" / "golden" / "mask_render.json"
WIDTH, HEIGHT, FPS = 96, 72, 30
SECONDS = 0.5
SAMPLES = (0.1, 0.4)
BLOCKS = (8, 6)
FRAMES = round(SECONDS * FPS)


def _rect(mask_id: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "rectangle",
        "id": mask_id,
        "cx": 48,
        "cy": 36,
        "width": 50,
        "height": 36,
        **extra,
    }


def _ellipse(mask_id: str, **extra: Any) -> dict[str, Any]:
    return {"kind": "ellipse", "id": mask_id, "cx": 48, "cy": 36, "rx": 30, "ry": 22, **extra}


def _path(mask_id: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "path",
        "id": mask_id,
        "pathKeyframes": [
            {
                "id": "k0",
                "sourceTime": 0.0,
                "easing": "ease-in-out",
                "points": [
                    12,
                    10,
                    0,
                    0,
                    20,
                    -4,
                    80,
                    14,
                    -6,
                    -10,
                    0,
                    12,
                    70,
                    64,
                    0,
                    0,
                    0,
                    0,
                    20,
                    58,
                    0,
                    0,
                    0,
                    0,
                ],
                "vertexTypes": [1, 2, 0, 0],
                "featherPx": [0, 6, 2, 4],
            },
            {
                "id": "k1",
                "sourceTime": 0.5,
                "points": [
                    20,
                    14,
                    0,
                    0,
                    16,
                    0,
                    88,
                    20,
                    -6,
                    -10,
                    0,
                    12,
                    60,
                    68,
                    0,
                    0,
                    0,
                    0,
                    8,
                    50,
                    0,
                    0,
                    0,
                    0,
                ],
                "vertexTypes": [1, 2, 0, 0],
                "featherPx": [3, 3, 3, 3],
            },
        ],
        **extra,
    }


_STACK = [_rect("base", width=70, height=54, featherOuterPx=4)]

CASES: list[dict[str, Any]] = [
    {
        "id": "rectangle-rotated-rounded-feathered",
        "masks": [_rect("m", rotation=21, roundness=0.4, featherOuterPx=5, falloff="linear")],
    },
    {
        "id": "ellipse-inner-feather-expanded",
        "masks": [_ellipse("m", featherInnerPx=6, expansionPx=3, falloff="gaussian")],
    },
    {"id": "path-animated-per-vertex", "masks": [_path("m", featherInnerPx=1)]},
    {
        "id": "rectangle-keyframed-source-clock",
        "masks": [
            _rect(
                "m",
                keyframes=[
                    {"id": "a", "sourceTime": 0.0, "property": "cx", "value": 24},
                    {"id": "b", "sourceTime": 0.5, "property": "cx", "value": 72},
                ],
            )
        ],
    },
    *[
        {
            "id": f"mode-{mode}",
            "masks": [*_STACK, _ellipse("m", cx=62, mode=mode, opacity=0.7, featherOuterPx=3)],
        }
        for mode in ("add", "subtract", "intersect", "difference", "lighten", "darken")
    ],
    {"id": "invert-opacity", "masks": [_ellipse("m", invert=True, opacity=0.5, featherOuterPx=6)]},
    {
        "id": "effect-target-grade",
        "effects": [
            {"id": "grade", "type": "color_grade", "params": {"exposure": 1.5, "saturation": -1}}
        ],
        "masks": [_ellipse("m", target={"kind": "effect", "effectId": "grade"}, featherOuterPx=5)],
    },
    {
        "id": "effect-and-alpha-targets",
        "effects": [{"id": "grade", "type": "color_grade", "params": {"exposure": -1.2}}],
        "masks": [
            _rect("cut", width=80, height=60),
            _path("fx", target={"kind": "effect", "effectId": "grade"}),
        ],
    },
    {
        "id": "legacy-gaussian-migrated",
        "masks": [
            _rect("m", featherModel="gaussian-legacy", featherOuterPx=3.6, opacity=0.8, invert=True)
        ],
    },
    {
        "id": "cropped-and-reversed",
        "crop": {"x": 0.25, "y": 0.0, "width": 0.5, "height": 1.0},
        "speed": -1.0,
        "masks": [
            _ellipse(
                "m",
                cx=48,
                rx=18,
                featherOuterPx=4,
                keyframes=[
                    {"id": "a", "sourceTime": 0.0, "property": "ry", "value": 10},
                    {"id": "b", "sourceTime": 0.5, "property": "ry", "value": 34},
                ],
            )
        ],
    },
]


#: MK8.4: the matte a ``layer`` case reads is this picture again, on a track above the clip:
#: reversed in time (so the matte is not the clip's own frame) and cut to an ellipse (so its alpha
#: varies). The masked clip is never drawn over by it: the source is consumed as the matte.
_MATTE_SOURCE = {
    "id": "matte",
    "assetId": "a1",
    "trackId": "top",
    "start": 0.0,
    "end": SECONDS,
    "sourceStart": 0.0,
    "sourceEnd": SECONDS,
    "speed": -1.0,
    "effects": [],
    "masks": [_ellipse("disc", cx=40, cy=30, rx=30, ry=20, featherOuterPx=5)],
}

CASES += [
    {
        "id": "analytic-split-soft",
        "masks": [
            {
                "kind": "linear",
                "id": "m",
                "originX": 48,
                "originY": 36,
                "angle": 30,
                "softnessPx": 10,
            }
        ],
    },
    {
        "id": "analytic-band-subtract-keyframed",
        "masks": [
            *_STACK,
            {
                "kind": "band",
                "id": "m",
                "mode": "subtract",
                "originX": 48,
                "originY": 36,
                "angle": 0,
                "widthPx": 14,
                "featherOuterPx": 3,
                "keyframes": [
                    {"id": "a", "sourceTime": 0.0, "property": "angle", "value": 0},
                    {"id": "b", "sourceTime": 0.5, "property": "angle", "value": 60},
                ],
            },
        ],
    },
    {
        "id": "analytic-gradient-linear",
        "masks": [
            {
                "kind": "gradient",
                "id": "m",
                "shape": "linear",
                "startX": 10,
                "startY": 10,
                "endX": 86,
                "endY": 62,
                "curve": "smooth",
            }
        ],
    },
    {
        "id": "analytic-gradient-radial-effect",
        "effects": [{"id": "grade", "type": "color_grade", "params": {"exposure": 1.2}}],
        "masks": [
            {
                "kind": "gradient",
                "id": "m",
                "shape": "radial",
                "target": {"kind": "effect", "effectId": "grade"},
                "startX": 48,
                "startY": 36,
                "endX": 88,
                "endY": 36,
                "curve": "gaussian",
            }
        ],
    },
    *[
        {
            "id": f"layer-{channel}",
            "extraTracks": [{"id": "top", "type": "video", "clips": [_MATTE_SOURCE]}],
            "masks": [
                {
                    "kind": "layer",
                    "id": "m",
                    "source": {"kind": "clip", "clipId": "matte"},
                    "channel": channel,
                }
            ],
        }
        for channel in ("alpha", "luma", "inverted-alpha", "inverted-luma")
    ],
    {
        "id": "layer-track-finesse-stacked",
        "extraTracks": [{"id": "top", "type": "video", "clips": [_MATTE_SOURCE]}],
        "masks": [
            _rect("r", width=80, height=60),
            {
                "kind": "layer",
                "id": "m",
                "mode": "intersect",
                "source": {"kind": "track", "trackId": "top"},
                "channel": "luma",
                "finesse": {"blurPx": 4, "shrinkGrowPx": -1},
            },
        ],
    },
]


#: MK9.1: the picture shrunk and moved, so a frame-space mask (fixed to the output frame) and the
#: same numbers in source space cut different parts of it.
_MOVED = [
    {"id": "s", "time": 0.0, "property": "scale", "value": 0.6},
    {"id": "x", "time": 0.0, "property": "x", "value": 14},
]


def _edge(kind: str, **params: float) -> dict[str, Any]:
    return {"id": f"c1__edge_{kind}", "type": "edge_style", "params": {"kind": kind, **params}}


CASES += [
    {
        "id": "frame-space-on-moved-clip",
        "keyframes": _MOVED,
        "masks": [_rect("m", space="frame", cx=30, cy=36, width=40, height=80, featherOuterPx=3)],
    },
    {
        "id": "source-space-on-moved-clip",
        "keyframes": _MOVED,
        "masks": [_rect("m", cx=30, cy=36, width=40, height=80, featherOuterPx=3)],
    },
    {
        "id": "frame-space-gradient-with-source-ellipse",
        "keyframes": _MOVED,
        "masks": [
            _ellipse("e"),
            {
                "kind": "gradient",
                "id": "g",
                "space": "frame",
                "mode": "intersect",
                "shape": "linear",
                "startX": 0,
                "startY": 0,
                "endX": 96,
                "endY": 0,
                "curve": "linear",
            },
        ],
    },
    # MK9.2: each edge style around a drawn shape, and all three around a track matte's cut-out
    # (a raster alpha, as a background removal's is).
    {
        "id": "edge-stroke-ellipse",
        "effects": [_edge("stroke", widthPx=4, red=255, green=255, blue=255)],
        "masks": [_ellipse("m", rx=24, ry=16)],
    },
    {
        "id": "edge-glow-ellipse",
        "effects": [_edge("glow", radiusPx=10, red=0, green=240, blue=255, opacity=0.9)],
        "masks": [_ellipse("m", rx=24, ry=16)],
    },
    {
        "id": "edge-shadow-ellipse",
        "effects": [_edge("shadow", offsetXPx=6, offsetYPx=5, softnessPx=4, opacity=0.8)],
        "masks": [_ellipse("m", rx=24, ry=16)],
    },
    {
        "id": "edge-all-over-track-matte",
        "extraTracks": [{"id": "top", "type": "video", "clips": [_MATTE_SOURCE]}],
        "effects": [
            _edge("shadow", offsetXPx=4, offsetYPx=4, softnessPx=2),
            _edge("glow", radiusPx=6, red=255, green=200, blue=0),
            _edge("stroke", widthPx=2),
        ],
        "masks": [
            {"kind": "layer", "id": "m", "source": {"kind": "clip", "clipId": "matte"}},
        ],
    },
]


def source_frames() -> list[np.ndarray]:
    """The picture: colour gradients, a checkerboard, and a bar that moves one step per frame.

    Synthesised in numpy rather than taken from ffmpeg's ``testsrc2``, whose pixels differ
    between ffmpeg releases (measured: 7.1 and 8.1 disagree), which moved the golden on CI.
    """
    ys, xs = np.mgrid[0:HEIGHT, 0:WIDTH]
    checker = ((xs // 8 + ys // 8) % 2) * 40
    frames = []
    for frame in range(FRAMES):
        bar = (np.abs(xs - (6 + 5 * frame)) < 4) * 90
        red = np.clip(40 + xs * 2 + checker + bar, 0, 255)
        green = np.clip(30 + ys * 3 + checker, 0, 255)
        blue = np.clip(200 - xs - ys + bar, 0, 255)
        frames.append(np.stack([red, green, blue], axis=-1).astype(np.uint8))
    return frames


def make_source(directory: Path) -> Path:
    """Write the lossless source (PNG frames in Matroska) into ``directory``."""
    out = directory / "src.mkv"
    write_source(out, source_frames(), fps=str(FPS))
    return out


def case_project(case: dict[str, Any]) -> Project:
    clip: dict[str, Any] = {
        "id": "c1",
        "assetId": "a1",
        "trackId": "v",
        "start": 0.0,
        "end": SECONDS,
        "sourceStart": 0.0,
        "sourceEnd": SECONDS,
        "effects": case.get("effects", []),
        "masks": case["masks"],
    }
    for field in ("crop", "speed", "keyframes"):
        if field in case:
            clip[field] = case[field]
    return Project.model_validate(
        {
            "id": "mask-golden",
            "name": "mask golden",
            "fps": FPS,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": [
                {
                    "id": "a1",
                    "path": "src.mkv",
                    "kind": "video",
                    "media": {"width": WIDTH, "height": HEIGHT},
                }
            ],
            # `tracks[0]` is the front: a layer case's matte source sits above the clip.
            "timeline": {
                "tracks": [
                    *case.get("extraTracks", []),
                    {"id": "v", "type": "video", "clips": [clip]},
                ]
            },
        }
    )


def block_means(frame: np.ndarray) -> list[list[float]]:
    """Per-block channel means, rounded to 0.01, blocks left-to-right then top-to-bottom."""
    rows, cols = BLOCKS[1], BLOCKS[0]
    bh, bw = frame.shape[0] // rows, frame.shape[1] // cols
    return [
        [
            round(float(frame[r * bh : (r + 1) * bh, c * bw : (c + 1) * bw, ch].mean()), 2)
            for ch in range(3)
        ]
        for r in range(rows)
        for c in range(cols)
    ]


def render_case(case: dict[str, Any], root: Path) -> list[list[list[float]]]:
    project = case_project(case)
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], root)
    composite = compile_timeline(project, index, frame_target(WIDTH, HEIGHT, FPS))
    try:
        return [block_means(np.asarray(composite.get_frame(t), dtype=np.float64)) for t in SAMPLES]
    finally:
        close_clip_tree(composite)


def render_all() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="fp-mask-golden-") as tmp:
        root = Path(tmp)
        make_source(root)
        return {
            "source": {"synthesised": "numpy", "frames": FRAMES, "codec": "png rgb24"},
            "samples": list(SAMPLES),
            "blocks": list(BLOCKS),
            "tolerance": 1.0,
            "cases": {case["id"]: render_case(case, root) for case in CASES},
        }


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    document = render_all()
    GOLDEN.write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
    _log.info("wrote %s (%d cases)", GOLDEN.name, len(document["cases"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
