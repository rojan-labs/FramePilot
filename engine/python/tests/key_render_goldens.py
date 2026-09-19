"""Green-screen render goldens for the ``key`` mask (MK6.3, plan 07).

Each case compiles a real timeline over a synthetic green-screen shot and records the composited
frame, so the whole chain is under test: the qualifier reading the clip's own picture, the finesse
group cleaning its edge, despill correcting the spill, and the stack attaching the alpha the
compositor then composites over the background.

WHY A SYNTHETIC SHOT: the fixture is numpy written losslessly (PNG frames in Matroska, RGB, no
YUV step) at the output size, so nothing resizes and no codec or generator version can move a
pixel. FFmpeg's ``testsrc`` is deliberately not used — its output differs between releases and
has moved a golden on CI before.

WHAT THE SHOT CONTAINS, because a key that only works on a flat green rectangle proves nothing:

* a backing lit unevenly, brighter in one corner and falling off to a darker green;
* a subject with a soft edge, in colours a hue qualifier must NOT take (skin, hair, a blue prop);
* green spill along the subject's edge, which despill has to remove without touching the prop;
* a shadow the subject casts on the backing, which shadow retention has to keep;
* a speck of backing inside the subject and a speck of subject on the backing, for morphology.

Regenerate after a deliberate render change::

    pnpm key-render:goldens

``test_key_render_golden.py`` compares against ``tests/fixtures/golden/key_render.json``.
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

GOLDEN = Path(__file__).parent / "fixtures" / "golden" / "key_render.json"
WIDTH, HEIGHT, FPS = 96, 72, 30
SECONDS = 0.4
SAMPLES = (0.1, 0.3)
BLOCKS = (8, 6)
FRAMES = round(SECONDS * FPS)

#: The backing's nominal colour: a real chroma-key green, not pure 0/255/0.
BACKING = (18, 176, 82)


def source_frames() -> list[np.ndarray]:
    """The green-screen shot described in the module docstring, one step of motion per frame."""
    ys, xs = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float64)
    frames: list[np.ndarray] = []
    for frame in range(FRAMES):
        # A backing lit from the top left, falling off across the frame.
        falloff = 1.0 - 0.45 * ((xs / WIDTH) * 0.6 + (ys / HEIGHT) * 0.4)
        red = BACKING[0] * falloff
        green = BACKING[1] * falloff
        blue = BACKING[2] * falloff

        # The subject: an ellipse that drifts right by one pixel per frame.
        centre_x = 34.0 + frame
        radius_x, radius_y = 20.0, 26.0
        distance = np.hypot((xs - centre_x) / radius_x, (ys - 40.0) / radius_y)
        inside = np.clip((1.08 - distance) / 0.16, 0.0, 1.0)

        # Its colours: skin over the upper half, a blue prop over the lower.
        prop = (ys > 46.0).astype(np.float64)
        subject_r = 222.0 * (1.0 - prop) + 44.0 * prop
        subject_g = 170.0 * (1.0 - prop) + 78.0 * prop
        subject_b = 135.0 * (1.0 - prop) + 196.0 * prop

        red = red + (subject_r - red) * inside
        green = green + (subject_g - green) * inside
        blue = blue + (subject_b - blue) * inside

        # Spill: the backing's green bleeding onto the subject's rim.
        rim = np.clip(1.0 - np.abs(distance - 1.0) / 0.35, 0.0, 1.0) * inside
        green = green + 70.0 * rim

        # A shadow the subject casts down and right on the backing.
        shadow = np.clip(
            1.0 - np.hypot((xs - centre_x - 16.0) / 22.0, (ys - 52.0) / 26.0), 0.0, 1.0
        )
        shadow = shadow * (1.0 - inside) * 0.55
        red = red * (1.0 - shadow)
        green = green * (1.0 - shadow)
        blue = blue * (1.0 - shadow)

        picture = np.stack([red, green, blue], axis=-1)
        # A speck of backing inside the subject, and a speck of subject on the backing.
        picture[38:40, int(centre_x) : int(centre_x) + 2] = BACKING
        picture[10:12, 78:80] = (222, 170, 135)
        frames.append(np.clip(np.rint(picture), 0, 255).astype(np.uint8))
    return frames


def make_source(directory: Path) -> Path:
    """Write the lossless source (PNG frames in Matroska) into ``directory``."""
    out = directory / "src.mkv"
    write_source(out, source_frames(), fps=str(FPS))
    return out


def _key(mask_id: str, **extra: Any) -> dict[str, Any]:
    """A hue+saturation qualifier aimed at the backing, with the given fields on top."""
    return {
        "id": mask_id,
        "kind": "key",
        "model": "hsl",
        "ranges": [
            {"channel": "hue", "low": 0.3, "high": 0.47, "softness": 0.06},
            {"channel": "saturation", "low": 0.35, "high": 1.0, "softness": 0.2},
        ],
        **extra,
    }


CASES: list[dict[str, Any]] = [
    {
        "id": "select-the-backing",
        "description": "the qualifier alone: the backing is the mask, the subject is not",
        "masks": [_key("k")],
    },
    {
        "id": "cut-the-subject-out",
        "description": "the same key inverted, which is how a green screen is pulled",
        "masks": [_key("k", invert=True)],
    },
    {
        "id": "cut-out-with-despill",
        "description": "the green rim comes off the subject; the blue prop is untouched",
        "masks": [_key("k", invert=True, despill="green")],
    },
    {
        "id": "cut-out-keeping-the-shadow",
        "description": "shadow retention pulls the cast shadow back out of the key",
        "masks": [_key("k", invert=True, shadowRetention=0.3)],
    },
    {
        "id": "cut-out-finessed",
        "description": "morphology deletes both specks, then the edge is shrunk and softened",
        "masks": [
            _key(
                "k",
                invert=True,
                finesse={
                    "morphOpenPx": 2.0,
                    "morphClosePx": 2.0,
                    "shrinkGrowPx": -1.0,
                    "blurPx": 2.0,
                },
            )
        ],
    },
    {
        "id": "cut-out-cleaned",
        "description": "clean black and white crush the haze either side of a wide soft edge",
        # A wide qualifier softness on purpose: clean levels are a control over HAZE, and a
        # tight key has none to crush, which would make the case a golden of nothing.
        "masks": [
            {
                "id": "k",
                "kind": "key",
                "model": "hsl",
                "invert": True,
                "finesse": {"cleanBlack": 0.35, "cleanWhite": 0.65},
                "ranges": [
                    {"channel": "hue", "low": 0.3, "high": 0.47, "softness": 0.2},
                    {"channel": "saturation", "low": 0.35, "high": 1.0, "softness": 0.45},
                ],
            }
        ],
    },
    {
        "id": "cut-out-hazy",
        "description": "the same wide qualifier without the levels, so the pair measures them",
        "masks": [
            {
                "id": "k",
                "kind": "key",
                "model": "hsl",
                "invert": True,
                "ranges": [
                    {"channel": "hue", "low": 0.3, "high": 0.47, "softness": 0.2},
                    {"channel": "saturation", "low": 0.35, "high": 1.0, "softness": 0.45},
                ],
            }
        ],
    },
    {
        "id": "sampled-backing",
        "description": "the 3d model on two sampled backing colours, inverted",
        "masks": [
            {
                "id": "k",
                "kind": "key",
                "model": "3d",
                "invert": True,
                "softness": 0.2,
                "samples3d": [[0.07, 0.69, 0.32], [0.05, 0.5, 0.23]],
            }
        ],
    },
    {
        "id": "grade-limited-to-the-backing",
        "description": "a key limiting an effect: the grade lands on the backing only",
        "effects": [
            {
                "id": "grade",
                "type": "color_grade",
                "params": {"saturation": -1.0, "exposure": 0.5},
                "keyframes": [],
            }
        ],
        "masks": [_key("k", target={"kind": "effect", "effectId": "grade"})],
    },
    {
        "id": "key-under-a-shape",
        "description": "a key intersected with a rectangle: only the backing inside it is cut",
        "masks": [
            _key("k", invert=True),
            {
                "id": "r",
                "kind": "rectangle",
                "mode": "intersect",
                "cx": 48.0,
                "cy": 36.0,
                "width": 70.0,
                "height": 54.0,
                "featherOuterPx": 4.0,
            },
        ],
    },
]


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
    return Project.model_validate(
        {
            "id": "key-golden",
            "name": "key golden",
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
    with tempfile.TemporaryDirectory(prefix="fp-key-golden-") as tmp:
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
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
    _log.info("wrote %s (%d cases)", GOLDEN.name, len(document["cases"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
