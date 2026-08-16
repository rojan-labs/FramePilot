"""Pure geometry helpers shared by the three trackers.

Everything here is dependency-free float math so the deterministic behaviour can
be unit tested without NumPy or OpenCV, and so the pixel/normalized boundary
lives in exactly one place.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Final

from .protocol import NormalizedBox, NormalizedPoint

Point = tuple[float, float]
Matrix3x3 = tuple[
    tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]
]

#: Smallest normalized box edge the protocol will accept without rounding to zero.
MIN_BOX_EDGE: Final = 1e-6


def clamp(value: float, minimum: float, maximum: float) -> float:
    return minimum if value < minimum else maximum if value > maximum else value


def clamp_unit(value: float) -> float:
    return clamp(value, 0.0, 1.0)


def to_pixels(point: NormalizedPoint, width: int, height: int) -> Point:
    return (point.x * width, point.y * height)


def box_to_pixels(box: NormalizedBox, width: int, height: int) -> tuple[float, float, float, float]:
    return (box.x * width, box.y * height, box.width * width, box.height * height)


def normalize_box(
    x: float, y: float, box_width: float, box_height: float, width: int, height: int
) -> NormalizedBox:
    """Convert a pixel box to a normalized box that is guaranteed inside the frame.

    Clamping (rather than rejecting) is deliberate: a tracked subject legitimately
    touches the frame edge, and the protocol requires in-frame geometry. The
    *confidence* of a clipped measurement is unaffected — honesty about the
    measurement lives in confidence/occlusion, not in silent geometry rejection.
    """
    left = clamp_unit(x / width)
    top = clamp_unit(y / height)
    right = clamp_unit((x + box_width) / width)
    bottom = clamp_unit((y + box_height) / height)
    normalized_width = max(right - left, MIN_BOX_EDGE)
    normalized_height = max(bottom - top, MIN_BOX_EDGE)
    left = min(left, 1.0 - normalized_width)
    top = min(top, 1.0 - normalized_height)
    return NormalizedBox(x=left, y=top, width=normalized_width, height=normalized_height)


def point_to_box(point: Point, patch_pixels: float, width: int, height: int) -> NormalizedBox:
    """Represent a tracked point as the protocol's box: its measurement patch.

    Protocol v1 carries only boxes, so a point track reports the square patch the
    flow estimate was measured over, centred on the point. The host reads the box
    centre as the point.
    """
    half = patch_pixels / 2.0
    return normalize_box(
        point[0] - half, point[1] - half, patch_pixels, patch_pixels, width, height
    )


def bounding_box(points: Sequence[Point], width: int, height: int) -> NormalizedBox:
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    left, top = min(xs), min(ys)
    return normalize_box(left, top, max(xs) - left, max(ys) - top, width, height)


def distance(first: Point, second: Point) -> float:
    return math.hypot(first[0] - second[0], first[1] - second[1])


def apply_homography(matrix: Matrix3x3, point: Point) -> Point | None:
    """Project one point through a 3x3 homography, refusing a degenerate result."""
    x, y = point
    denominator = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2]
    if abs(denominator) < 1e-9:
        return None
    projected_x = (matrix[0][0] * x + matrix[0][1] * y + matrix[0][2]) / denominator
    projected_y = (matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]) / denominator
    if any(value != value or abs(value) > 1e9 for value in (projected_x, projected_y)):
        return None
    return (projected_x, projected_y)
