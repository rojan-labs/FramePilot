"""Write the transform-track parity vectors (MK7.1) into ``tests/fixtures/mask-track``.

A tracked mask is drawn twice — once by the export (``render/tracks.py``) and once by the monitor
(``packages/editor-core/src/mask-track.ts``) — and plan 10 requires the two to agree bit for bit,
because the transform moves the path's control points and every later step of the rasteriser is
already pinned byte-exact. These vectors are the pin:

* ``transforms.json``: track documents (one per method, including a degenerate frame and a
  point-cloud) queried at source instants that fall on a frame, between two frames, exactly
  halfway, and outside the tracked range at both ends. ``expected.sha256`` is the SHA-256 of the
  warped coordinates as float64 little-endian, so a single ulp of difference fails.
* ``corrected.json`` (MK7.7): a tracked mask an editor CORRECTED on one frame — the correction
  stored relative to the tracked motion as hold keyframes around the corrected stretch, exactly
  the shape ``correct_tracked_mask`` writes — drawn as ``T(t) · G(t)`` by
  ``render.mask_stack.tracked_mask_path_at``, before, on, inside and after the stretch. The
  expected digest is of every control point of the drawn path (vertex, in-tangent, out-tangent).

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

from pydantic import TypeAdapter

from framepilot_engine.render.mask_stack import tracked_mask_path_at
from framepilot_engine.render.tracks import parse_track, warp_point
from framepilot_engine.timeline.models import MaskLayer

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


# --- corrected tracked masks (MK7.7) ----------------------------------------------------------


def _span(document: dict[str, Any]) -> tuple[float, float]:
    numerator, denominator = document["timeBase"]
    origin = document["originPts"]
    first, last = document["pts"][0], document["pts"][-1]
    return (
        float((first - origin) * numerator / denominator),
        float((last - origin) * numerator / denominator),
    )


def _path_points(vertices: list[tuple[float, float, float, float, float, float]]) -> list[float]:
    return [value for vertex in vertices for value in vertex]


#: A curved quad: the tangents are what a perspective track has to bend, not just carry.
_OUTLINE = [
    (100.0, 100.0, -12.0, 4.0, 18.0, -3.0),
    (300.0, 110.0, -9.0, -6.0, 7.0, 15.0),
    (310.0, 290.0, 11.0, -8.0, -14.0, 5.0),
    (95.0, 305.0, 6.0, 13.0, -5.0, -16.0),
]
#: The same outline where the editor put it on the corrected frame, relative to the track.
_CORRECTED = [(x + 9.5, y - 4.25, ix, iy, ox, oy) for x, y, ix, iy, ox, oy in _OUTLINE]
_LATER = [(x - 3.0, y + 7.5, ix, iy, ox, oy) for x, y, ix, iy, ox, oy in _OUTLINE]


def _corrected_path(mask_id: str, span: tuple[float, float]) -> dict[str, Any]:
    """A path mask as ``correct_tracked_mask`` leaves it: the old animation held up to the frame
    before the stretch, the correction held across it, the old animation again after it."""
    t0, t1 = span

    def at(fraction: float) -> float:
        return t0 + (t1 - t0) * fraction

    types = [0, 1, 2, 0]

    def keyframe(key: str, time: float, easing: str, outline: list[Any]) -> dict[str, Any]:
        return {
            "id": key,
            "sourceTime": time,
            "easing": easing,
            "points": _path_points(outline),
            "vertexTypes": types,
        }

    return {
        "kind": "path",
        "id": mask_id,
        "pathKeyframes": [
            keyframe("k0", at(0.0), "linear", _OUTLINE),
            keyframe("before", at(0.3), "hold", _OUTLINE),
            keyframe("start", at(0.4), "hold", _CORRECTED),
            keyframe("end", at(0.8), "linear", _OUTLINE),
            keyframe("later", at(1.0), "ease-in-out", _LATER),
        ],
    }


def _corrected_rectangle(span: tuple[float, float]) -> dict[str, Any]:
    """A rectangle corrected under a similarity track: its scalars keyed the same way."""
    t0, t1 = span

    def at(fraction: float) -> float:
        return t0 + (t1 - t0) * fraction

    def keys(name: str, old: float, corrected: float) -> list[dict[str, Any]]:
        return [
            {
                "id": f"{name}-b",
                "sourceTime": at(0.3),
                "property": name,
                "value": old,
                "easing": "hold",
            },
            {
                "id": f"{name}-s",
                "sourceTime": at(0.4),
                "property": name,
                "value": corrected,
                "easing": "hold",
            },
            {
                "id": f"{name}-e",
                "sourceTime": at(0.8),
                "property": name,
                "value": old,
                "easing": "linear",
            },
        ]

    return {
        "kind": "rectangle",
        "id": "corrected-rectangle",
        "cx": 640.0,
        "cy": 360.0,
        "width": 300.0,
        "height": 180.0,
        "rotation": 10.0,
        "roundness": 0.25,
        "keyframes": [
            *keys("cx", 640.0, 655.5),
            *keys("cy", 360.0, 348.25),
            *keys("width", 300.0, 290.0),
            *keys("rotation", 10.0, 3.5),
        ],
    }


def _corrected_cases() -> list[tuple[str, dict[str, Any], str]]:
    return [
        (
            "path-perspective",
            _corrected_path("corrected-path", _span(TRACKS["perspective"])),
            "perspective",
        ),
        ("rectangle-similarity", _corrected_rectangle(_span(TRACKS["similarity"])), "similarity"),
        ("path-shape", _corrected_path("corrected-shape", _span(TRACKS["shape"])), "shape"),
    ]


#: Where along the track's span each case is drawn: before the correction's hold, on it, on the
#: corrected keyframe, inside the stretch, on its end, and past the track at both sides.
_FRACTIONS = (-0.1, 0.0, 0.2, 0.3, 0.35, 0.4, 0.5, 0.79, 0.8, 0.9, 1.0, 1.1)


def _corrected_document() -> dict[str, Any]:
    adapter: TypeAdapter[Any] = TypeAdapter(MaskLayer)
    masks: dict[str, Any] = {}
    cases: list[dict[str, Any]] = []
    for name, raw_mask, track_name in _corrected_cases():
        masks[name] = raw_mask
        mask = adapter.validate_python(raw_mask)
        track = parse_track(TRACKS[track_name])
        t0, t1 = _span(TRACKS[track_name])
        for index, fraction in enumerate(_FRACTIONS):
            time = t0 + (t1 - t0) * fraction
            path = tracked_mask_path_at(mask, track, time)
            drawn = [
                value
                for vertex in path.vertices
                for value in (
                    vertex.x,
                    vertex.y,
                    vertex.in_x,
                    vertex.in_y,
                    vertex.out_x,
                    vertex.out_y,
                )
            ]
            cases.append(
                {
                    "id": f"{name}/q{index}",
                    "mask": name,
                    "track": track_name,
                    "sourceSeconds": time,
                    "expected": {"sha256": _digest(drawn), "count": len(drawn)},
                }
            )
    return {
        "version": 1,
        "note": (
            "Corrected tracked masks (MK7.7). masks[name] is a mask as correct_tracked_mask "
            "leaves it (hold keyframes around the corrected stretch); tracks are "
            "transforms.json's. Each case draws the mask at sourceSeconds as T(t) . G(t) "
            "(render.mask_stack.tracked_mask_path_at) and expects the sha256 of every control "
            "point of the drawn path — x, y, inX, inY, outX, outY per vertex — as float64 "
            "little-endian."
        ),
        "masks": masks,
        "tracks": {name: TRACKS[name] for _, _, name in _corrected_cases()},
        "cases": cases,
    }


def serialize(doc: dict[str, Any]) -> str:
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


DOCUMENTS = {"transforms": _document, "corrected": _corrected_document}


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
