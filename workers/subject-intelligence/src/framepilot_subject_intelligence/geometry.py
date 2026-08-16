"""Pure geometry and mask encoding.

Dependency free on purpose: every rule that decides what the host receives —
clamping, normalization, run-length encoding — is testable without a CV stack.
"""

from __future__ import annotations

from collections.abc import Sequence

from .protocol import NormalizedBox, NormalizedPoint

PixelBox = tuple[float, float, float, float]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def normalize_box(box: PixelBox, width: int, height: int) -> NormalizedBox:
    """Convert a pixel box to a normalized box that is guaranteed inside the frame.

    Detectors routinely return boxes that hang slightly off the edge of the
    picture. The protocol requires ``x + width <= 1``, so the box is clipped to
    the frame rather than rejected: a face at the edge of frame is a real face.
    """
    x, y, w, h = box
    left = clamp(x / width, 0.0, 1.0)
    top = clamp(y / height, 0.0, 1.0)
    right = clamp((x + w) / width, 0.0, 1.0)
    bottom = clamp((y + h) / height, 0.0, 1.0)
    return NormalizedBox(
        x=left,
        y=top,
        width=max(right - left, 0.0),
        height=max(bottom - top, 0.0),
    )


def to_pixel_box(box: NormalizedBox, width: int, height: int) -> PixelBox:
    return (box.x * width, box.y * height, box.width * width, box.height * height)


def contains(box: PixelBox, point: tuple[float, float]) -> bool:
    x, y, w, h = box
    return x <= point[0] <= x + w and y <= point[1] <= y + h


def point_in_pixels(point: NormalizedPoint, width: int, height: int) -> tuple[float, float]:
    return (point.x * width, point.y * height)


def encode_run_lengths(values: Sequence[int]) -> tuple[int, ...]:
    """Row-major binary run lengths, always beginning with the zero run.

    "Beginning with the zero run" is why a mask whose very first pixel is
    foreground starts with a literal ``0``: without it the decoder cannot tell
    which value a run belongs to, and the mask would come back inverted.
    """
    counts: list[int] = []
    expected = 0
    run = 0
    for value in values:
        current = 1 if value else 0
        if current == expected:
            run += 1
            continue
        counts.append(run)
        expected = current
        run = 1
    counts.append(run)
    return tuple(counts)


def decode_run_lengths(counts: Sequence[int], total: int) -> tuple[int, ...]:
    """Inverse of :func:`encode_run_lengths`, used by tests to prove the round trip."""
    values: list[int] = []
    value = 0
    for count in counts:
        values.extend([value] * count)
        value = 1 - value
    if len(values) != total:
        raise ValueError(f"run lengths cover {len(values)} pixels, expected {total}.")
    return tuple(values)
