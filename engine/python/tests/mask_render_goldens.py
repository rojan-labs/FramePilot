"""Render goldens for the v22 mask stack (MK2.4): every shape kind, mode and target.

Each case compiles a real timeline (``compile_timeline``: speed stage, grade, mask stack,
compositing) over a deterministic lossless ``testsrc2`` source at the output size, so no
resize runs, and records each sampled frame as 8x6 block means per channel. Block means,
compared to within one level, are stable across numpy/ffmpeg builds yet catch a mask that
moved, grew, lost its feather, combined wrongly or limited the wrong effect.

Regenerate after a deliberate render change::

    pnpm mask-render:goldens

``test_mask_render_golden.py`` compares against ``tests/fixtures/golden/mask_render.json``.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from framepilot_engine.media.assets import index_assets
from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.render.compiler import compile_timeline
from framepilot_engine.render.presets import frame_target
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Project

_log = logging.getLogger(__name__)

GOLDEN = Path(__file__).parent / "fixtures" / "golden" / "mask_render.json"
WIDTH, HEIGHT, FPS = 96, 72, 30
SECONDS = 0.5
SAMPLES = (0.1, 0.4)
BLOCKS = (8, 6)
LAVFI = f"testsrc2=s={WIDTH}x{HEIGHT}:r={FPS}:d={SECONDS}"


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


def make_source(directory: Path) -> Path:
    """The lossless RGB ``testsrc2`` source (PNG frames: no YUV conversion on decode)."""
    out = directory / "src.mov"
    subprocess.run(
        [
            find_ffmpeg(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            LAVFI,
            "-c:v",
            "png",
            "-pix_fmt",
            "rgb24",
            str(out),
        ],
        check=True,
        capture_output=True,
    )
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
    for field in ("crop", "speed"):
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
                    "path": "src.mov",
                    "kind": "video",
                    "media": {"width": WIDTH, "height": HEIGHT},
                }
            ],
            "timeline": {"tracks": [{"id": "v", "type": "video", "clips": [clip]}]},
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
            "source": {"lavfi": LAVFI, "codec": "png rgb24"},
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
