"""Perceptual frame hashing for golden-media tests (plan 2.3).

WHY: a golden-media test must assert that a render still produces the *expected
picture*, but an exact byte/pixel hash is too brittle — ffmpeg/codec versions
differ across machines. A perceptual **average hash** (aHash) of a downscaled
grayscale frame is stable to that noise while still catching real regressions
(wrong frame, black output, mis-scaled content). The committed golden stores
aHashes; tests compare with a small **Hamming-distance** tolerance.

These functions are pure (numpy + Pillow), so they are unit-testable without any
render.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

# aHash grid size: 8x8 -> a 64-bit hash. Standard for perceptual hashing.
_HASH_SIDE = 8


def average_hash(frame: np.ndarray, *, side: int = _HASH_SIDE) -> int:
    """Compute the perceptual average hash (aHash) of an RGB ``frame``.

    The frame is converted to grayscale, downscaled to ``side`` by ``side``, and
    each pixel becomes one bit: 1 if it is ≥ the mean, else 0. The bits are
    packed MSB-first into an integer.

    :param frame: An ``(H, W, 3)`` (or ``(H, W)``) array of pixel values.
    :param side: Downscale grid side length (hash has ``side*side`` bits).
    :returns: The aHash as an integer.
    """
    image = Image.fromarray(np.asarray(frame, dtype=np.uint8)).convert("L")
    small = np.asarray(image.resize((side, side), Image.Resampling.BILINEAR), dtype=np.float64)
    mean = small.mean()
    bits = (small >= mean).flatten()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value


def hamming_distance(a: int, b: int) -> int:
    """Number of differing bits between two hashes (bit-count of XOR).

    :param a: First hash.
    :param b: Second hash.
    :returns: The Hamming distance (0 = identical).
    """
    return int(a ^ b).bit_count()
