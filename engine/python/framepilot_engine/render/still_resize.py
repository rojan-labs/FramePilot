"""MoviePy's ``Resize`` for a still's layer: the same resize, done again only when it would differ.

WHY: a sticker, a photo, a title or a shape is one picture for its whole clip, but MoviePy
resizes a layer's frame (and its mask) again on every frame it composites when the scale is
keyframed (``Resize``'s per-frame ``transform`` path), and a time-varying mask (a fade) on every
frame at any scale. A constant resize of an ``ImageClip`` already runs once, in MoviePy's own
``ImageClip.image_transform``. Twenty 318 px stickers drawn 400 px high on a 4K export spent about
3.5 ms a frame each resizing their picture and alpha, on an M1 Pro.

**Same pixels, by construction.** ``Resize.resizer`` is a pure function of its input pixels and
the whole-pixel target size (a LANCZOS resize through Pillow). :class:`ReusingResize` keeps the
last input it was given, a copy, and returns a copy of the last output when the next input is
equal to it, element for element, at the same whole-pixel size; anything else is resized afresh.
A still that fades, blurs or animates its scale still resizes whenever its picture or size
changes. Only stills use it: a video's frames differ every frame, so comparing them would be pure
cost. The entry lives in the process's reuse budget (``render/reuse_budget.py``), which drops the
least recently used entries when they outgrow it; a dropped entry only means a fresh resize.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from moviepy.video.fx.Resize import Resize

from framepilot_engine.render.reuse_budget import ReuseSlot


class ReusingResize(Resize):  # type: ignore[misc]
    """``moviepy.video.fx.Resize``, reusing its last result for an identical input and size.

    MoviePy applies a private copy of an effect to each clip (``Effect.copy``), and the mask is
    resized by its own instance, so each keeps the one entry for its own picture, in its own slot
    of the shared budget.
    """

    def apply(self, clip: Any) -> Any:
        self._slot = ReuseSlot()
        resized = super().apply(clip)
        # MoviePy resizes the mask with a plain `Resize` of the same size; the same, reusing.
        if self.apply_to_mask and clip.mask is not None:
            resized.mask = clip.mask.with_effects(
                [ReusingResize(self.new_size, apply_to_mask=False)]
            )
        return resized

    def resizer(self, pic: np.ndarray, new_size: Any) -> np.ndarray:
        size = list(map(int, new_size))
        last: tuple[np.ndarray, list[int], np.ndarray] | None = self._slot.get()
        if (
            last is not None
            and last[1] == size
            and last[0].shape == pic.shape
            and last[0].dtype == pic.dtype
            and np.array_equal(last[0], pic)
        ):
            return last[2].copy()
        resized: np.ndarray = super().resizer(pic, new_size)
        nbytes = pic.nbytes + resized.nbytes
        if self._slot.keeps(nbytes):
            self._slot.put((pic.copy(), size, resized), nbytes)
        else:
            self._slot.clear()
        return resized.copy()


__all__ = ["ReusingResize"]
