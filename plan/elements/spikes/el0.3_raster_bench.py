"""EL0.3 spike: time the shape rasteriser and the preview raster route.

Run from ``engine/python``: ``uv run python ../../plan/elements/spikes/el0.3_raster_bench.py``.
Prints one Markdown row per preset: median ms for the raster at 1080p and 4K, and for the whole
``POST /preview/text-raster`` call at 1080p (in process, through FastAPI's TestClient).
"""

from __future__ import annotations

import statistics
import sys
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

from fastapi.testclient import TestClient

from framepilot_engine.config import Settings
from framepilot_engine.render.shape_catalog import featured_shape_preset_ids, preset_shape_params
from framepilot_engine.render.shape_raster import rasterize_shape
from framepilot_engine.service import create_app

RUNS = 15
EXTRA = [
    "star-5/white",
    "speech-bubble/white",
    "curved-arrow/red",
    "icon/check",
    "numbered-circle/red-1",
]


def median_ms(call: Callable[[], object]) -> float:
    call()  # warm-up: fonts, icon outlines, the app's first request
    times = []
    for _ in range(RUNS):
        start = time.perf_counter()
        call()
        times.append((time.perf_counter() - start) * 1000)
    return statistics.median(times)


def main() -> None:
    client = TestClient(create_app(Settings(projects_root=Path(tempfile.mkdtemp()))))
    for preset_id in [*featured_shape_preset_ids(), *EXTRA]:
        params = preset_shape_params(preset_id)
        assert params is not None
        body = {"kind": "shape", "params": params, "frame_width": 1920, "frame_height": 1080}
        hd = median_ms(lambda p=params: rasterize_shape(p, 1920, 1080))
        uhd = median_ms(lambda p=params: rasterize_shape(p, 3840, 2160))
        route = median_ms(lambda b=body: client.post("/preview/text-raster", json=b))
        sys.stdout.write(f"| `{preset_id}` | {hd:.1f} | {uhd:.1f} | {route:.1f} |\n")


if __name__ == "__main__":
    main()
