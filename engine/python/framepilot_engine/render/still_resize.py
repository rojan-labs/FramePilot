"""MoviePy's ``Resize`` for a still's layer: the same resize, done again only when it would differ.

WHY: a sticker, a photo, a title or a shape is one picture for its whole clip, but MoviePy
resizes a layer's frame (and its mask) again on every frame it composites, whether the scale is
constant (``Resize``'s ``image_transform`` path) or keyframed (its per-frame ``transform`` path).
Twenty 318 px stickers drawn 400 px high on a 4K export spent about 3.5 ms a frame each doing it,
on an M1 Pro; a sticker with no transform, fitted to the frame, is a 2160 px LANCZOS resize per
frame.

**Same pixels, by construction.** ``Resize.resizer`` is a pure function of its input pixels and
the whole-pixel target size (a LANCZOS resize through Pillow). :class:`ReusingResize` keeps the
last input it was given, a copy, and returns a copy of the last output when the next input is
equal to it, element for element, at the same whole-pixel size; anything else is resized afresh.
A still that fades, blurs or animates its scale still resizes whenever its picture or size
changes. Only stills use it: a video's frames differ every frame, so comparing them would be pure
cost.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from moviepy.video.fx.Resize import Resize


class ReusingResize(Resize):  # type: ignore[misc]
    """``moviepy.video.fx.Resize``, reusing its last result for an identical input and size.

    MoviePy applies a private copy of an effect to each clip (``Effect.copy``), and the mask is
    resized by its own instance, so each keeps the one entry for its own picture.
    """

    def apply(self, clip: Any) -> Any:
        self._last: tuple[np.ndarray, list[int], np.ndarray] | None = None
        resized = super().apply(clip)
        # MoviePy resizes the mask with a plain `Resize` of the same size; the same, reusing.
        if self.apply_to_mask and clip.mask is not None:
            resized.mask = clip.mask.with_effects(
                [ReusingResize(self.new_size, apply_to_mask=False)]
            )
        return resized

    def resizer(self, pic: np.ndarray, new_size: Any) -> np.ndarray:
        size = list(map(int, new_size))
        last = self._last
        if (
            last is not None
            and last[1] == size
            and last[0].shape == pic.shape
            and last[0].dtype == pic.dtype
            and np.array_equal(last[0], pic)
        ):
            return last[2].copy()
        resized: np.ndarray = super().resizer(pic, new_size)
        self._last = (pic.copy(), size, resized)
        return resized.copy()


__all__ = ["ReusingResize"]
