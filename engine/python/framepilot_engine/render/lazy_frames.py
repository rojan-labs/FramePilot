"""Picture clips that learn their size when it is read, not by rendering frame 0 while building.

WHY: MoviePy learns a transformed clip's size by rendering that clip's frame 0 — in
``VideoClip.with_updated_frame_function`` (behind every ``transform``, ``time_transform``,
``subclipped``, ``image_transform``, resize and rotate) and in ``VideoClip(frame_function=...)``.
The compiler stacks a dozen such stages on a layer, and each rendered the whole chain beneath it
at t=0: the reader's decode at the clip's in-point, the colour grade, a transition's pass, the
mask, the effect layers over the composited frame. None of those frames is used — a grab reads
one other instant, a scope a handful — and each nested stage renders them again. A profiled scope
spent 3.5 s of its 5.7 s compile there, 1.2 s of it in one directional-blur transition pass
(AL38).

**Same sizes, by construction.** A size is still MoviePy's size; only WHEN it is computed moves:

* a time map (``subclipped``, ``time_transform``, speed and reverse effects) and the compiler's
  own pixel stages (:func:`same_size_transform`: grade, blur, keys, edge styles, transitions,
  effect layers) return frames of their input's size, so their clip takes its input's size,
  exactly as MoviePy's frame 0 would have measured it;
* every other stage (crop, resize, rotate) gets MoviePy's own formula — frame 0's shape — run the
  first time something reads the size, on the same frame function. A frame is a function of
  time, so that is the value MoviePy's eager render found.

Only clips of the classes below are lazy: the compiler's video sources
(:class:`~framepilot_engine.render.video_reader.ProbedVideoFileClip`), the pictures and masks it
builds from frame functions (:class:`FrameClip`), and every copy MoviePy makes of either. A still
stays an ``ImageClip`` until a stage turns it into a moving picture, as MoviePy does.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import numpy as np
from moviepy.video.VideoClip import ImageClip, VideoClip

FrameFunction = Callable[[float], np.ndarray]


class _PendingSize:
    """A clip size nobody has read yet, and how MoviePy would compute it."""

    __slots__ = ("_resolve", "_value")

    def __init__(self, resolve: Callable[[], Any]) -> None:
        self._resolve: Callable[[], Any] | None = resolve
        self._value: Any = None

    def value(self) -> Any:
        if self._resolve is not None:
            self._value = self._resolve()
            self._resolve = None
        return self._value


def _first_frame_size(frame_function: FrameFunction) -> _PendingSize:
    """MoviePy's ``self.size = self.get_frame(0).shape[:2][::-1]``, run when first read."""
    return _PendingSize(lambda: frame_function(0).shape[:2][::-1])


class LazySize:
    """A mixin for a MoviePy ``VideoClip`` subclass: sizes are computed when read (see module).

    It must come before ``VideoClip`` in the bases, so its methods replace MoviePy's.
    """

    @property
    def size(self) -> Any:
        value = self.__dict__.get("_frame_size")
        return value.value() if isinstance(value, _PendingSize) else value

    @size.setter
    def size(self, value: Any) -> None:
        self.__dict__["_frame_size"] = value

    def with_updated_frame_function(self, frame_function: FrameFunction) -> Any:
        """MoviePy's outplace ``with_updated_frame_function``, measuring frame 0 only if read."""
        new_clip = self.copy()  # type: ignore[attr-defined]
        new_clip.frame_function = frame_function
        new_clip.__dict__["_frame_size"] = _first_frame_size(frame_function)
        return new_clip

    def time_transform(
        self,
        time_func: Callable[[float], float],
        apply_to: str | Sequence[str] | None = None,
        keep_duration: bool = False,
    ) -> Any:
        """MoviePy's ``Clip.time_transform``: a time map keeps the size it maps."""
        return same_size_transform(
            self,
            lambda get_frame, t: get_frame(time_func(t)),
            apply_to=[] if apply_to is None else apply_to,
            keep_duration=keep_duration,
        )


class FrameClip(LazySize, VideoClip):  # type: ignore[misc]
    """``VideoClip(frame_function=..., is_mask=...)`` that renders no frame to learn its size.

    :param size: The frame size, when the caller knows it — a concrete ``(width, height)`` or
        another lazy clip's :func:`size_of` — else MoviePy's frame-0 measure, run when read.
    """

    def __init__(
        self, frame_function: FrameFunction, *, size: Any = None, is_mask: bool = False
    ) -> None:
        VideoClip.__init__(self, is_mask=is_mask)
        self.frame_function = frame_function
        measured = size if size is not None else _first_frame_size(frame_function)
        self.__dict__["_frame_size"] = measured


def size_of(clip: Any) -> Any:
    """``clip``'s size to hand to another clip, without computing a size nobody has read yet."""
    if isinstance(clip, LazySize):
        return clip.__dict__.get("_frame_size")
    return clip.size


def same_size_transform(
    clip: Any,
    func: Callable[[FrameFunction, float], np.ndarray],
    *,
    apply_to: str | Sequence[str] | None = None,
    keep_duration: bool = True,
) -> Any:
    """``clip.transform(func, apply_to, keep_duration)`` for a ``func`` that keeps frame size.

    MoviePy's ``Clip.transform`` line for line, except that the new clip takes ``clip``'s size
    instead of rendering its frame 0 to measure it. ``func`` must return frames of the size it is
    given (every compiler stage that calls this does); a mask or audio in ``apply_to`` goes
    through the same map. A still becomes a moving picture, as MoviePy's ``ImageClip.transform``
    makes it.
    """
    attributes = [apply_to] if isinstance(apply_to, str) else list(apply_to or [])
    new_clip = clip.copy()
    get_frame = clip.get_frame
    new_clip.frame_function = lambda t: func(get_frame, t)
    if isinstance(clip, ImageClip):
        # MoviePy's ImageClip.transform: the result is no longer an ImageClip (it may animate).
        size = new_clip.__dict__.pop("size")
        new_clip.__class__ = FrameClip
        new_clip.__dict__["_frame_size"] = size
    if not keep_duration:
        new_clip.duration = None
        new_clip.end = None
    for attribute in attributes:
        value = getattr(new_clip, attribute, None)
        if value is None:
            continue
        if isinstance(value, VideoClip):
            value = same_size_transform(value, func, keep_duration=keep_duration)
        else:
            value = value.transform(func, keep_duration=keep_duration)
        setattr(new_clip, attribute, value)
    return new_clip


__all__ = ["FrameClip", "LazySize", "same_size_transform", "size_of"]
