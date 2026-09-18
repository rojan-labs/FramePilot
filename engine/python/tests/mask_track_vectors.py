"""Write the transform-track parity vectors (MK7.1) into ``tests/fixtures/mask-track``.

A tracked mask is drawn twice — once by the export (``render/tracks.py``) and once by the monitor
(``packages/editor-core/src/mask-track.ts``) — and plan 10 requires the two to agree bit for bit,
because the transform moves the path's control points and every later step of the rasteriser is
already pinned byte-exact. These vectors are the pin:

* ``transforms.json``: track documents (one per method, including a degenerate frame and a
  point-cloud) queried at source instants that fall on a frame, between two frames, exactly
  halfway, and outside the tracked range at both ends. ``expected.sha256`` is the SHA-256 of the
  warped coordinates as float64 little-endian, so a single ulp of difference fails.

Run after a deliberate change::

    pnpm mask-track:vectors

``test_mask_track_vectors.py`` fails when the stored vectors no longer match the engine, and
``apps/web-editor/src/preview/masks/mask-track.test.ts`` fails when TypeScript disagrees.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import sys
from itertools import pairwise
from pathlib import Path
from typing import Any

from framepilot_engine.render.tracks import parse_track, warp_point

_log = logging.getLogger(__name__)

REPO = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO / "tests" / "fixtures" / "mask-track"

#: Points every track is queried at: an origin, an off-centre point, a negative coordinate and a
#: far corner, so translation, scale, rotation and the perspective divide all show up.
PROBE_POINTS = ((0.0, 0.0), (137.25, 88.5), (-40.0, 12.0), (1919.0, 1079.0))


def _rotation(degrees: float, scale: float, dx: float, dy: float) -> list[float]:
    radians = degrees * math.pi / 180.0
    cos = math.cos(radians) * scale
    sin = math.sin(radians) * scale
    return [cos, -sin, dx, sin, cos, dy, 0.0, 0.0, 1.0]


def _identity() -> list[float]:
    return [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]


def _translation(dx: float, dy: float) -> list[float]:
    return [1.0, 0.0, dx, 0.0, 1.0, dy, 0.0, 0.0, 1.0]


def _position_track() -> dict[str, Any]:
    transforms = [
        *_identity(),
        *_translation(12.5, -7.25),
        *_translation(25.0, -14.5),
        *_translation(37.5, -21.75),
    ]
    return {
        "version": 1,
        "method": "position",
        "timeBase": [1, 30000],
        "originPts": 0,
        "firstFrame": 24,
        "pts": [24024, 25025, 26026, 27027],
        "transforms": transforms,
        "confidence": [1.0, 0.95, 0.4, 0.05],
    }


def _similarity_track() -> dict[str, Any]:
    return {
        "version": 1,
        "method": "position-scale-rotation",
        "timeBase": [1, 24],
        "originPts": 12,
        "firstFrame": 0,
        "pts": [12, 13, 14],
        "transforms": [
            *_identity(),
            *_rotation(11.25, 1.125, 4.0, -9.0),
            *_rotation(22.5, 1.25, 8.0, -18.0),
        ],
        "confidence": [1.0, 0.8, 0.6],
    }


def _perspective_track() -> dict[str, Any]:
    return {
        "version": 1,
        "method": "perspective",
        "timeBase": [1, 1000],
        "originPts": 0,
        "firstFrame": 0,
        "pts": [0, 1000, 2000],
        "transforms": [
            *_identity(),
            # A real plane turning away: the third row is what makes this a homography.
            1.02,
            0.031,
            -6.5,
            -0.017,
            0.994,
            3.25,
            0.000_12,
            -0.000_045,
            1.0,
            # A degenerate frame: the denominator crosses zero, so points hold where they are.
            1.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ],
        "confidence": [1.0, 0.7, 0.0],
    }


def _shape_track() -> dict[str, Any]:
    reference = [0.0, 0.0, 100.0, 0.0, 100.0, 80.0, 0.0, 80.0]
    frames = [
        *reference,
        0.5,
        1.5,
        101.25,
        -0.75,
        99.0,
        81.5,
        -1.25,
        79.25,
        1.0,
        3.0,
        102.5,
        -1.5,
        98.0,
        83.0,
        -2.5,
        78.5,
    ]
    return {
        "version": 1,
        "method": "point-cloud",
        "timeBase": [1, 30],
        "originPts": 0,
        "firstFrame": 5,
        "pts": [5, 6, 7],
        "transforms": [*_identity(), *_translation(0.5, 0.5), *_translation(1.0, 1.0)],
        "confidence": [1.0, 0.9, 0.85],
        "points": {"count": 4, "reference": reference, "frames": frames},
    }


TRACKS: dict[str, Any] = {
    "position": _position_track(),
    "similarity": _similarity_track(),
    "perspective": _perspective_track(),
    "shape": _shape_track(),
}


def _query_times(document: dict[str, Any]) -> list[float]:
    """Instants that exercise every branch of the frame lookup."""
    numerator, denominator = document["timeBase"]
    origin = document["originPts"]
    pts = document["pts"]

    def seconds(ticks: float) -> float:
        return float((ticks - origin) * numerator / denominator)

    times = [seconds(pts[0] - 10)]  # before the tracked range
    for value in pts:
        times.append(seconds(value))
    for left, right in pairwise(pts):
        times.append(seconds(left + (right - left) * 0.25))
        times.append(seconds((left + right) / 2))  # the tie: the earlier frame wins
        times.append(seconds(left + (right - left) * 0.75))
    times.append(seconds(pts[-1] + 10))  # after the tracked range
    return times


def _document() -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    for name, raw in TRACKS.items():
        artifact = parse_track(raw)
        for index, time in enumerate(_query_times(raw)):
            frame = _nearest(artifact, time)
            warped: list[float] = []
            matrix = artifact.transforms[frame * 9 : frame * 9 + 9]
            for x, y in PROBE_POINTS:
                px, py = warp_point(matrix, x, y)
                warped.extend((px, py))
            if artifact.points is not None:
                count = artifact.points.count
                for vertex in range(count + 1):  # one past the end: an untracked vertex
                    dx, dy = _delta(artifact, frame, vertex)
                    warped.extend((dx, dy))
            cases.append(
                {
                    "id": f"{name}/q{index}",
                    "track": name,
                    "sourceSeconds": time,
                    "frameIndex": frame,
                    "confidence": artifact.confidence[frame],
                    "expected": {"sha256": _digest(warped), "count": len(warped)},
                }
            )
    return {
        "version": 1,
        "note": (
            "Transform-track parity (MK7.1). tracks[name] is a track.json document; each case "
            "queries it at sourceSeconds, expecting the engine's frame index, its confidence, and "
            "the sha256 of the warped probe coordinates as float64 little-endian: the four "
            "PROBE_POINTS through the frame transform, then (for a point-cloud track) the "
            "per-vertex delta of every vertex and one vertex past the end."
        ),
        "probePoints": [list(point) for point in PROBE_POINTS],
        "tracks": TRACKS,
        "cases": cases,
    }


def _nearest(artifact: Any, seconds: float) -> int:
    from framepilot_engine.render.tracks import frame_index_at

    return frame_index_at(artifact, seconds)


def _delta(artifact: Any, index: int, vertex: int) -> tuple[float, float]:
    from framepilot_engine.render.tracks import point_delta

    return point_delta(artifact, index, vertex)


def _digest(values: list[float]) -> str:
    import numpy as np

    digest: str = hashlib.sha256(np.asarray(values, dtype="<f8").tobytes()).hexdigest()
    return digest


def serialize(doc: dict[str, Any]) -> str:
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


DOCUMENTS = {"transforms": _document}


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
