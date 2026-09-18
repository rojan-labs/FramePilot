"""Colour-chart vectors for the ``key`` mask gate (MK6.3, plan 06).

The gate: *engine vs preview keyed alpha within 1/255 on colour charts in BT.601/709, full and
limited range*. This writes the engine's side of it — the alpha ``render/key_mask.py`` produces
for a fixed set of masks over a fixed set of colours — and the preview is measured against it
twice: on the CPU by ``preview/masks/key-mask.test.ts`` (the twin the eyedropper uses) and on a
real GPU by the ``mask-key-parity`` Playwright spec (the shader the monitor runs).

WHY THE FOUR ENCODINGS, when a keyer only ever sees RGB: because the RGB it sees is what the
decode produced, and BT.601 vs BT.709 and full vs limited range put different numbers there for
the same light. Each chart patch is therefore taken to YUV in that encoding, quantised to 8 bits
as a decoded frame is, and brought back to RGB — so the colours keyed here are colours that
actually come out of a decoder, including the ones limited range cannot represent.

Regenerate with ``pnpm key-mask:vectors``. Every number here is generated deterministically in
numpy — never from ``testsrc``, whose output differs between FFmpeg versions and has moved a
golden on CI before.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sys
from pathlib import Path
from typing import Any

import numpy as np

from framepilot_engine.render.mask_stack import key_mask_alpha
from framepilot_engine.timeline.models import KeyMask

_log = logging.getLogger(__name__)

REPO = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO / "tests" / "fixtures" / "mask-key"

#: Luma coefficients per matrix, as the standards define them.
MATRICES = {
    "bt601": (0.299, 0.587, 0.114),
    "bt709": (0.2126, 0.7152, 0.0722),
}

#: A 36-patch chart: primaries and secondaries, a grey ramp, skin tones, and a green/blue-screen
#: sweep (the colours a key is actually pointed at, including badly lit corners of a backing).
CHART: list[tuple[int, int, int]] = [
    (255, 0, 0),
    (0, 255, 0),
    (0, 0, 255),
    (255, 255, 0),
    (0, 255, 255),
    (255, 0, 255),
    (255, 255, 255),
    (0, 0, 0),
    (128, 128, 128),
    (16, 16, 16),
    (235, 235, 235),
    (64, 64, 64),
    (192, 192, 192),
    (32, 32, 32),
    (96, 96, 96),
    (222, 170, 135),
    (180, 120, 90),
    (120, 80, 60),
    (245, 210, 190),
    (90, 60, 45),
    (60, 40, 30),
    (0, 177, 64),
    (30, 190, 90),
    (10, 140, 50),
    (60, 200, 110),
    (0, 120, 40),
    (20, 90, 35),
    (0, 71, 187),
    (40, 110, 210),
    (20, 60, 150),
    (80, 140, 230),
    (0, 40, 110),
    (30, 80, 170),
    (200, 230, 210),
    (140, 170, 150),
    (70, 100, 80),
]


def _rgb_through(rgb: tuple[int, int, int], matrix: str, full: bool) -> tuple[int, int, int]:
    """One patch as it comes back out of a decoder in this matrix and range.

    Forward: RGB -> Y'CbCr with the matrix's luma coefficients, scaled into the range and rounded
    to 8 bits, exactly as an encoder writes it. Back: the inverse, clamped to 8 bits. Limited
    range therefore loses the codes outside 16..235 / 16..240, which is the point.
    """
    kr, kg, kb = MATRICES[matrix]
    red, green, blue = (value / 255.0 for value in rgb)
    y = kr * red + kg * green + kb * blue
    cb = (blue - y) / (2.0 * (1.0 - kb))
    cr = (red - y) / (2.0 * (1.0 - kr))
    if full:
        y8 = round(y * 255.0)
        cb8 = round(cb * 255.0 + 128.0)
        cr8 = round(cr * 255.0 + 128.0)
        y_back = y8 / 255.0
        cb_back = (cb8 - 128.0) / 255.0
        cr_back = (cr8 - 128.0) / 255.0
    else:
        y8 = round(y * 219.0 + 16.0)
        cb8 = round(cb * 224.0 + 128.0)
        cr8 = round(cr * 224.0 + 128.0)
        y_back = (y8 - 16.0) / 219.0
        cb_back = (cb8 - 128.0) / 224.0
        cr_back = (cr8 - 128.0) / 224.0
    red_back = y_back + 2.0 * (1.0 - kr) * cr_back
    blue_back = y_back + 2.0 * (1.0 - kb) * cb_back
    green_back = (y_back - kr * red_back - kb * blue_back) / kg
    return tuple(  # type: ignore[return-value]
        int(min(255, max(0, round(value * 255.0)))) for value in (red_back, green_back, blue_back)
    )


#: The masks the chart is keyed with: one per model, plus the controls that shape an edge.
MASKS: list[dict[str, Any]] = [
    {
        "id": "hsl-green",
        "kind": "key",
        "model": "hsl",
        "ranges": [
            {"channel": "hue", "low": 0.25, "high": 0.45, "softness": 0.08},
            {"channel": "saturation", "low": 0.3, "high": 1.0, "softness": 0.12},
        ],
    },
    {
        "id": "hsl-wrapping-red",
        "kind": "key",
        "model": "hsl",
        "ranges": [{"channel": "hue", "low": 0.94, "high": 0.06, "softness": 0.05}],
    },
    {
        "id": "hsl-shadow-kept",
        "kind": "key",
        "model": "hsl",
        "shadowRetention": 0.35,
        "ranges": [
            {"channel": "hue", "low": 0.25, "high": 0.45, "softness": 0.08},
            {"channel": "saturation", "low": 0.2, "high": 1.0, "softness": 0.2},
        ],
    },
    {
        "id": "rgb-blue-screen",
        "kind": "key",
        "model": "rgb",
        "ranges": [
            {"channel": "red", "low": 0.0, "high": 0.35, "softness": 0.1},
            {"channel": "green", "low": 0.0, "high": 0.55, "softness": 0.1},
            {"channel": "blue", "low": 0.45, "high": 1.0, "softness": 0.15},
        ],
    },
    {
        "id": "luma-highlights",
        "kind": "key",
        "model": "luma",
        "ranges": [{"channel": "luma", "low": 0.72, "high": 1.0, "softness": 0.3}],
    },
    {
        "id": "3d-sampled-backing",
        "kind": "key",
        "model": "3d",
        "softness": 0.22,
        "samples3d": [[0.0, 0.694, 0.251], [0.118, 0.745, 0.353]],
    },
    {
        "id": "hsl-cleaned-and-inverted",
        "kind": "key",
        "model": "hsl",
        "invert": True,
        "opacity": 0.8,
        "finesse": {"cleanBlack": 0.15, "cleanWhite": 0.85},
        "ranges": [
            {"channel": "hue", "low": 0.25, "high": 0.45, "softness": 0.14},
            {"channel": "saturation", "low": 0.15, "high": 1.0, "softness": 0.25},
        ],
    },
]


def encodings() -> list[dict[str, Any]]:
    """Every (matrix, range) chart: the patches as a decoder hands them over."""
    charts = []
    for matrix in ("bt601", "bt709"):
        for full in (True, False):
            colours = [_rgb_through(patch, matrix, full) for patch in CHART]
            charts.append(
                {
                    "matrix": matrix,
                    "range": "full" if full else "limited",
                    "colours": [list(colour) for colour in colours],
                }
            )
    return charts


#: How many ranges and samples one preview pass carries (``MAX_KEY_RANGES``/``MAX_KEY_SAMPLES``
#: in ``preview/masks/key-mask.ts``); the packed arrays below are that long, so the GPU harness
#: can upload them without knowing the mask schema.
MAX_RANGES = 8
MAX_SAMPLES = 8

#: The channel order the shader indexes by (``KEY_CHANNELS``).
CHANNELS = ("hue", "saturation", "luma", "red", "green", "blue")


def packed_uniforms(mask: Any) -> dict[str, Any]:
    """``keyUniforms`` in Python: the numbers the preview's shader reads.

    Emitted with the vectors so the Playwright harness that runs the real shader needs no mask
    schema at all, and so the TypeScript packer can be asserted against them.
    """
    extra = max(float(mask.softness), 0.0)
    ranges = [0.0] * (MAX_RANGES * 4)
    used = list(mask.ranges)[:MAX_RANGES]
    for index, entry in enumerate(used):
        ranges[index * 4] = float(entry.low)
        ranges[index * 4 + 1] = float(entry.high)
        ranges[index * 4 + 2] = max(float(entry.softness), 0.0) + extra
        ranges[index * 4 + 3] = float(CHANNELS.index(str(entry.channel)))
    samples = [0.0] * (MAX_SAMPLES * 4)
    picked = list(mask.samples3d)[:MAX_SAMPLES]
    for index, sample in enumerate(picked):
        samples[index * 4] = float(sample[0])
        samples[index * 4 + 1] = float(sample[1])
        samples[index * 4 + 2] = float(sample[2])
    sampled = str(mask.model) == "3d"
    opacity = float(mask.opacity)
    return {
        "sampled": 1 if sampled else 0,
        "rangeCount": 0 if sampled else len(used),
        "ranges": ranges,
        "sampleCount": len(picked) if sampled else 0,
        "samples": samples,
        "tolerance": max(float(mask.softness), 0.0),
        "shadowRetention": max(float(mask.shadow_retention), 0.0),
        "cleanBlack": float(mask.finesse.clean_black),
        "cleanWhite": float(mask.finesse.clean_white),
        "invert": 1.0 if mask.invert else 0.0,
        "opacity": 0.0 if opacity <= 0.0 else 1.0 if opacity >= 1.0 else opacity,
        "inOutRatio": float(mask.finesse.in_out_ratio),
    }


def document() -> dict[str, Any]:
    """The vectors: per mask, per encoding, the keyed alpha of every patch as a byte."""
    charts = encodings()
    cases = []
    for raw in MASKS:
        mask = KeyMask.model_validate(raw)
        per_chart = []
        for chart in charts:
            picture = np.array([chart["colours"]], dtype=np.uint8)
            # The LAYER's alpha: qualifier, clean levels, invert, opacity — what the stack
            # combines, and therefore what a 1/255 gate has to be measured on.
            alpha = key_mask_alpha(mask, picture, 0.0)[0]
            # Stored as the byte the stack quantises to, which is what both sides are compared
            # on: a 1/255 gate is a gate on these numbers.
            per_chart.append(
                {
                    "matrix": chart["matrix"],
                    "range": chart["range"],
                    "alpha8": [int(value) for value in np.rint(alpha * 255.0).astype(np.int64)],
                }
            )
        cases.append({"mask": raw, "uniforms": packed_uniforms(mask), "expected": per_chart})
    return {
        "area": "mask-key",
        "spec": "engine/python/tests/key_mask_vectors.py; render/key_mask.py",
        "gate": "engine vs preview keyed alpha <= 1/255 (plan 06)",
        "charts": charts,
        "cases": cases,
    }


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    path = FIXTURE_DIR / "charts.json"
    text = json.dumps(document(), indent=1, ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8")
    _log.info(
        "wrote %s (%d masks x %d charts, sha256 %s)",
        path.name,
        len(MASKS),
        4,
        hashlib.sha256(text.encode()).hexdigest()[:12],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
