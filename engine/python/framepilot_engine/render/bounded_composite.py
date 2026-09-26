"""MoviePy's composite, with each transparent layer blended over only the pixels it covers.

WHY: MoviePy 2's ``VideoClip.compose_on`` places a layer that has transparency by allocating a
fully transparent canvas the size of the WHOLE frame, pasting the layer into it, and running
Pillow's ``alpha_composite`` over every pixel of the frame. A 400 px sticker on a 4K export paid
for 8.3 million pixels, twice (the canvas fill and the blend): about 5 ms a layer on an M1 Pro,
the largest single cost of 20 element layers (plan/elements 05 section 7 budgets them at 1.3x the
export without them).

**Same pixels, by construction.** Outside the layer's rectangle that canvas is ``(0, 0, 0, 0)``,
and Pillow's ``alpha_composite`` copies the destination pixel unchanged wherever the source alpha
is 0 (``libImaging/AlphaComposite.c``). Inside it, each output pixel depends on nothing but its
own destination and source pixels. So blending the frame's crop under the layer with the same
``alpha_composite`` and pasting it back gives every pixel MoviePy's composite gives, and
``test_element_layer_export.py`` compares the two bit for bit. Everything else (the frame and mask
fetch, the mask-size fix-up, the position, the opaque-paste path) is MoviePy's own code, kept
line for line.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from moviepy import CompositeVideoClip
from moviepy.tools import compute_position
from PIL import Image


def _fit_mask_to_picture(mask: Image.Image, picture: Image.Image) -> Image.Image:
    """MoviePy's fix-up for a mask of another size: crop it, or pad it with 0, from the corner."""
    if mask.size == picture.size:
        return mask
    if mask.width > picture.width or mask.height > picture.height:
        return mask.crop((0, 0, picture.width, picture.height))
    padded = Image.new("L", (picture.width, picture.height), 0)
    padded.paste(mask, (0, 0))
    return padded


def compose_layer_on(clip: Any, background: Image.Image, t: float) -> Image.Image:
    """``clip.compose_on(background, t)``, blending over only the frame region the clip covers.

    :param clip: The layer (a MoviePy ``VideoClip``): its frame, mask and position at ``t``.
    :param background: The frame so far. The opaque path pastes into it, as MoviePy's does, and
        the transparent path blends into it (MoviePy returns a new image there; the caller keeps
        only the returned one either way).
    :param t: The composite's time; the clip reads ``t - clip.start``.
    :returns: The frame with the layer on it.
    """
    ct = t - clip.start
    picture = Image.fromarray(clip.get_frame(ct).astype("uint8"))
    if clip.mask is not None:
        alpha = Image.fromarray((clip.mask.get_frame(ct) * 255).astype("uint8")).convert("L")
        picture = picture.convert("RGBA")
        picture.putalpha(_fit_mask_to_picture(alpha, picture))
    x, y = compute_position(picture.size, background.size, clip.pos(ct), clip.relative_pos)
    if picture.mode[-1] != "A" and background.mode[-1] != "A":
        background.paste(picture, (x, y))
        return background
    if background.mode[-1] != "A":
        background = background.convert("RGBA")
    if picture.mode[-1] != "A":
        picture = picture.convert("RGBA")
    left, top = max(x, 0), max(y, 0)
    right = min(x + picture.width, background.width)
    bottom = min(y + picture.height, background.height)
    if right <= left or bottom <= top:
        # Wholly off the frame: MoviePy's canvas would be transparent everywhere.
        return background
    covered = picture.crop((left - x, top - y, right - x, bottom - y))
    region = (left, top, right, bottom)
    background.paste(Image.alpha_composite(background.crop(region), covered), region)
    return background


class BoundedCompositeVideoClip(CompositeVideoClip):  # type: ignore[misc]
    """``moviepy.CompositeVideoClip`` whose layers compose through :func:`compose_layer_on`.

    Construction, layer order, the mask composite and the background are MoviePy's. The frame
    function below is MoviePy 2's ``CompositeVideoClip.frame_function`` with one call changed.
    """

    def frame_function(self, t: float) -> np.ndarray:
        if self.is_mask:
            return super().frame_function(t)  # type: ignore[no-any-return]
        bg_t = t - self.bg.start
        background = Image.fromarray(self.bg.get_frame(bg_t).astype("uint8"))
        if self.bg.mask:
            bgm_t = t - self.bg.mask.start
            bg_mask = (self.bg.mask.get_frame(bgm_t) * 255).astype("uint8")
            bg_alpha = _fit_mask_to_picture(Image.fromarray(bg_mask).convert("L"), background)
            background = background.convert("RGBA")
            background.putalpha(bg_alpha)
        current = background
        for clip in self.playing_clips(t):
            current = compose_layer_on(clip, current, t)
        frame = np.array(current)
        if frame.shape[2] == 4:
            return frame[:, :, :3]
        return frame


__all__ = ["BoundedCompositeVideoClip", "compose_layer_on"]
