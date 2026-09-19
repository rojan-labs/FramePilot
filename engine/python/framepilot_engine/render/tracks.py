"""The transform-track artifact in the export: reading it, and moving mask geometry with it.

The Python twin of ``packages/editor-core/src/mask-track.ts`` (MK7.1, plan 10 "Tracking"). A
tracked mask stores only ``{key, sha256}``; the per-frame 3x3 transforms live in the
project-owned, digest-pinned file ``<project>/.framepilot-derived/tracks/<key>/track.json``,
exactly as mattes live in ``.framepilot-derived/mattes/<key>/``.

The transform is applied to the mask's control points **before** they are flattened (plan 10,
rasteriser rule 5). Warping the rasterised image instead would soften the edge the whole mask
stack exists to keep exact, and would not match the preview.

Everything here is float64 and runs in a fixed order — an integer index lookup, then nine
multiplies, two adds and one divide per point — so the export and the monitor produce the same
bits. ``tests/fixtures/mask-track/`` pins the two implementations against each other.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from typing import Any, TypeGuard

from framepilot_engine.render.mattes import file_sha256
from framepilot_engine.safety import PathTraversalError, resolve_within

#: Directory tracks live in, relative to the project file's folder.
TRACKS_DIR = ".framepilot-derived/tracks"
#: The one artifact file a track is made of.
TRACK_FILE = "track.json"
#: The only artifact version this build reads.
TRACK_ARTIFACT_VERSION = 1
#: Largest ``track.json`` the export reads; an honest one is ~120 bytes per frame.
TRACK_MAX_BYTES = 64 * 1024 * 1024
#: Most frames one track may cover (~5.5 h at 60 fps).
_MAX_FRAMES = 1_200_000
#: Most tracked points a shape track may carry.
TRACK_MAX_POINTS = 512
#: Values the export does arithmetic on must fit float64's exact integers with room to spare.
_VALUE_BOUND = 2**52

_METHODS = frozenset({"position", "position-scale-rotation", "perspective", "point-cloud"})

#: The identity transform: the mask sits where its own animation puts it.
IDENTITY: tuple[float, ...] = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)


class TrackRefusal(ValueError):
    """The export will not render a tracked mask. Carries a typed code and one remedy."""

    def __init__(self, code: str, mask_id: str, clip_id: str) -> None:
        super().__init__(f"Mask {mask_id!r} on clip {clip_id!r}: {TRACK_REMEDIES[code]}")
        self.code = code
        self.mask_id = mask_id
        self.clip_id = clip_id


#: One sentence per refusal code, with the remedy and no varying magnitude (the guard-key rule).
TRACK_REMEDIES: dict[str, str] = {
    "track_missing": "its tracking data is missing — track the mask again.",
    "track_digest_mismatch": (
        "its tracking data was changed outside FramePilot — track the mask again."
    ),
    "track_unreadable": "its tracking data is damaged — track the mask again.",
    "track_method_mismatch": (
        "its tracking data was measured with a different method — track the mask again."
    ),
}


@dataclass(frozen=True)
class TrackPoints:
    """Per-vertex positions of a ``point-cloud`` track, in display-corrected source pixels."""

    count: int
    reference: tuple[float, ...]
    frames: tuple[float, ...]


@dataclass(frozen=True)
class TrackArtifact:
    """A parsed, bounds-checked ``track.json``."""

    method: str
    time_base: Fraction
    origin_pts: int
    first_frame: int
    pts: tuple[int, ...]
    transforms: tuple[float, ...]
    confidence: tuple[float, ...]
    points: TrackPoints | None = None

    @property
    def count(self) -> int:
        return len(self.pts)

    def source_seconds(self, index: int) -> float:
        """Asset source seconds of tracked frame ``index``."""
        return float((self.pts[index] - self.origin_pts) * self.time_base)


def _is_int(value: Any) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and abs(value) <= _VALUE_BOUND


def _numbers(value: Any, what: str) -> tuple[float, ...]:
    if not isinstance(value, list):
        raise ValueError(f"track.json {what} must be a list of numbers.")
    out: list[float] = []
    for entry in value:
        if isinstance(entry, bool) or not isinstance(entry, (int, float)):
            raise ValueError(f"track.json {what} must be a list of finite numbers.")
        number = float(entry)
        if not math.isfinite(number):
            raise ValueError(f"track.json {what} must be a list of finite numbers.")
        out.append(number)
    return tuple(out)


def parse_track(document: Any) -> TrackArtifact:
    """Validate a ``track.json`` document.

    A project folder is not a trusted input (BR4.12), so every bound is checked before anything
    is indexed: a wrong length, a non-increasing pts or an out-of-range value refuses here rather
    than rendering a wrong frame.

    :raises ValueError: For any malformed document.
    """
    if not isinstance(document, dict):
        raise ValueError("track.json must be an object.")
    if document.get("version") != TRACK_ARTIFACT_VERSION:
        raise ValueError("track.json was written by a different version of FramePilot.")
    method = document.get("method")
    if not isinstance(method, str) or method not in _METHODS:
        raise ValueError("track.json names a tracking method this version does not know.")
    time_base = document.get("timeBase")
    if (
        not isinstance(time_base, list)
        or len(time_base) != 2
        or not all(_is_int(value) for value in time_base)
        or time_base[0] <= 0
        or time_base[1] <= 0
    ):
        raise ValueError("track.json timeBase must be two positive integers.")
    origin = document.get("originPts")
    first = document.get("firstFrame")
    if not _is_int(origin):
        raise ValueError("track.json originPts must be an integer.")
    if not _is_int(first) or first < 0:
        raise ValueError("track.json firstFrame must be a non-negative integer.")
    pts = document.get("pts")
    if (
        not isinstance(pts, list)
        or not pts
        or len(pts) > _MAX_FRAMES
        or not all(_is_int(value) for value in pts)
    ):
        raise ValueError("track.json pts must be a non-empty list of integers.")
    if any(b <= a for a, b in pairwise(pts)):
        raise ValueError("track.json pts must be strictly increasing.")
    count = len(pts)
    transforms = _numbers(document.get("transforms"), "transforms")
    if len(transforms) != count * 9:
        raise ValueError("track.json must hold one 3x3 transform for every tracked frame.")
    confidence = _numbers(document.get("confidence"), "confidence")
    if len(confidence) != count:
        raise ValueError("track.json must hold one confidence for every tracked frame.")
    if any(value < 0.0 or value > 1.0 for value in confidence):
        raise ValueError("track.json confidence must be between 0 and 1.")
    return TrackArtifact(
        method=method,
        time_base=Fraction(int(time_base[0]), int(time_base[1])),
        origin_pts=int(origin),
        first_frame=int(first),
        pts=tuple(int(value) for value in pts),
        transforms=transforms,
        confidence=confidence,
        points=_parse_points(document.get("points"), method, count),
    )


def _parse_points(value: Any, method: str, frames: int) -> TrackPoints | None:
    if value is None:
        if method == "point-cloud":
            raise ValueError("track.json for a shape track must hold its tracked points.")
        return None
    if not isinstance(value, dict):
        raise ValueError("track.json points must be an object.")
    count = value.get("count")
    if not _is_int(count) or count <= 0 or count > TRACK_MAX_POINTS:
        raise ValueError("track.json points count is out of range.")
    reference = _numbers(value.get("reference"), "points reference")
    positions = _numbers(value.get("frames"), "points frames")
    if len(reference) != count * 2:
        raise ValueError("track.json must hold one reference position for every tracked point.")
    if len(positions) != count * 2 * frames:
        raise ValueError("track.json must hold every tracked point on every tracked frame.")
    return TrackPoints(count=int(count), reference=reference, frames=positions)


def read_track_file(path: Path) -> TrackArtifact:
    """Read and parse ``track.json`` with bounds for an untrusted artifact.

    :raises ValueError: Over :data:`TRACK_MAX_BYTES`, not strict UTF-8 JSON (a BOM is refused),
        nested too deeply to parse, or not a valid track document.
    """
    if path.stat().st_size > TRACK_MAX_BYTES:
        raise ValueError("track.json is larger than any track needs.")
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError("track.json must not start with a byte-order mark.")
    try:
        document = json.loads(raw.decode("utf-8"))
    except RecursionError as exc:
        raise ValueError("track.json is nested too deeply.") from exc
    except UnicodeDecodeError as exc:
        raise ValueError("track.json is not UTF-8.") from exc
    return parse_track(document)


def track_directory(base_dir: Path, key: str) -> Path | None:
    """The track's directory inside the project, or ``None`` for a malformed or escaping key."""
    if len(key) != 64 or any(character not in "0123456789abcdef" for character in key):
        return None
    try:
        return resolve_within(base_dir, f"{TRACKS_DIR}/{key}")
    except PathTraversalError:
        return None


def prepare_track(mask: Any, clip: Any, base_dir: Path) -> TrackArtifact:
    """Check and read a tracked mask's artifact before anything renders.

    Order matters and mirrors :func:`~framepilot_engine.render.mattes.prepare_matte`: a missing
    file is refused before its digest is asked about, and the digest is checked before the
    document is parsed, so a tampered file never reaches the parser.

    :raises TrackRefusal: The artifact is missing, changed, damaged, or was measured with a
        different method than the mask asks for.
    """
    tracking = mask.tracking
    directory = track_directory(base_dir, str(tracking.artifact.key))
    path = directory / TRACK_FILE if directory is not None else None
    if path is None or not path.is_file():
        raise TrackRefusal("track_missing", str(mask.id), str(clip.id))
    if file_sha256(path) != str(tracking.artifact.sha256):
        raise TrackRefusal("track_digest_mismatch", str(mask.id), str(clip.id))
    try:
        artifact = read_track_file(path)
    except (ValueError, OSError) as exc:
        raise TrackRefusal("track_unreadable", str(mask.id), str(clip.id)) from exc
    if artifact.method != str(getattr(tracking.method, "value", tracking.method)):
        raise TrackRefusal("track_method_mismatch", str(mask.id), str(clip.id))
    return artifact


# --- Reading a transform ------------------------------------------------------------------


def frame_index_at(artifact: TrackArtifact, source_seconds: float) -> int:
    """The tracked frame that answers asset source second ``source_seconds``.

    Outside the tracked range the nearest end holds, as a keyframe holds before the first and
    after the last: a mask must not jump back to untracked geometry because the picture ran one
    frame past what was tracked. Inside it the nearest pts wins, ties to the earlier frame.
    """
    ticks = (
        artifact.origin_pts
        + (source_seconds * artifact.time_base.denominator) / artifact.time_base.numerator
    )
    pts = artifact.pts
    if ticks <= pts[0]:
        return 0
    last = len(pts) - 1
    if ticks >= pts[last]:
        return last
    low, high = 0, last
    while high - low > 1:
        middle = (low + high) // 2
        if pts[middle] <= ticks:
            low = middle
        else:
            high = middle
    return low if ticks - pts[low] <= pts[high] - ticks else high


def matrix_at(artifact: TrackArtifact, index: int) -> tuple[float, ...]:
    """The nine numbers of tracked frame ``index``."""
    base = index * 9
    return artifact.transforms[base : base + 9]


def transform_at(artifact: TrackArtifact, source_seconds: float) -> tuple[float, ...]:
    """The transform at an asset source instant."""
    return matrix_at(artifact, frame_index_at(artifact, source_seconds))


def warp_point(matrix: tuple[float, ...], x: float, y: float) -> tuple[float, float]:
    """Project one point through a 3x3.

    A near-zero denominator would mirror the point through the plane's horizon, which is never a
    real measurement of a mask that stayed in frame; the point is left where it was, so a
    degenerate frame shows the untracked mask instead of a fold.
    """
    w = matrix[6] * x + matrix[7] * y + matrix[8]
    if not (w > 1e-9) and not (w < -1e-9):
        return (x, y)
    px = (matrix[0] * x + matrix[1] * y + matrix[2]) / w
    py = (matrix[3] * x + matrix[4] * y + matrix[5]) / w
    if not math.isfinite(px) or not math.isfinite(py):
        return (x, y)
    return (px, py)


def point_delta(artifact: TrackArtifact, index: int, vertex: int) -> tuple[float, float]:
    """The displacement a ``point-cloud`` track puts on vertex ``vertex``.

    ``(0, 0)`` for a track without points or a vertex it never followed, so a mask whose vertex
    count changed after tracking degrades to its own animation rather than tearing.
    """
    points = artifact.points
    if points is None or vertex < 0 or vertex >= points.count:
        return (0.0, 0.0)
    base = (index * points.count + vertex) * 2
    return (
        points.frames[base] - points.reference[vertex * 2],
        points.frames[base + 1] - points.reference[vertex * 2 + 1],
    )


def warp_path(artifact: TrackArtifact, path: Any, source_seconds: float) -> Any:
    """Move a Bezier path's control points by the track, BEFORE it is flattened.

    Tangents are stored as offsets from their vertex, so each one is warped at its absolute
    position and turned back into an offset: a perspective track has to bend the tangents, not
    just carry them along, or a tracked curve would flatten out as the plane turns.

    A ``point-cloud`` track moves vertex ``i`` — and both of its tangent ends — by its own
    measured displacement, which is exact for a non-rigid shape.

    :param path: A :class:`~framepilot_engine.render.mask_raster.BezierPath`.
    :returns: A path of the same type, same vertex count and same ``first_vertex``.
    """
    from framepilot_engine.render.mask_raster import BezierVertex

    index = frame_index_at(artifact, source_seconds)
    matrix = matrix_at(artifact, index)
    shape = artifact.method == "point-cloud" and artifact.points is not None
    vertices: list[Any] = []
    for order, vertex in enumerate(path.vertices):
        if shape:
            dx, dy = point_delta(artifact, index, order)
            vertices.append(
                BezierVertex(
                    x=vertex.x + dx,
                    y=vertex.y + dy,
                    in_x=vertex.in_x,
                    in_y=vertex.in_y,
                    out_x=vertex.out_x,
                    out_y=vertex.out_y,
                    feather=vertex.feather,
                )
            )
            continue
        px, py = warp_point(matrix, vertex.x, vertex.y)
        in_x, in_y = warp_point(matrix, vertex.x + vertex.in_x, vertex.y + vertex.in_y)
        out_x, out_y = warp_point(matrix, vertex.x + vertex.out_x, vertex.y + vertex.out_y)
        vertices.append(
            BezierVertex(
                x=px,
                y=py,
                in_x=in_x - px,
                in_y=in_y - py,
                out_x=out_x - px,
                out_y=out_y - py,
                feather=vertex.feather,
            )
        )
    return type(path)(vertices=tuple(vertices), first_vertex=path.first_vertex)
