"""How every audio file the engine opens answers a request for samples (AL42).

WHY this exists. MoviePy 2.1's ``FFMPEG_AudioReader.get_frame`` has two ways to fail a read
that is perfectly well defined:

1. **It reads a boolean mask as timestamps.** When one request's in-file samples span more
   than half the reader's buffer, it splits the request and recurses on ``in_time[...]`` (the
   in-range MASK) instead of ``tt[...]`` (the times), so ``True`` is read as t = 1.0 s and
   ``False`` as t = 0.0 s. On a file shorter than 1 s every ``True`` is out of range and the
   read raises ``OSError: Accessing time t=1.00-1.00 seconds``; on a longer one it silently
   returns the samples at 0 s and 1 s. ``AudioFileClip`` caps the buffer at the file's own
   length, so a short sound (a whoosh, a hit) takes this path as soon as a request spans more
   than half of it. That is what crashed ``measure_loudness`` on harness run 17: the loudness
   window reads the mix in 32768-sample blocks, and a 0.45 s ``Swipe_Whoosh.mp3`` has a
   22051-sample buffer. The export reads in 2000-sample blocks, so it reached the same bug
   only on sounds under about 90 ms.
2. **It raises when no requested time is inside the file.** ``CompositeAudioClip`` asks a
   layer for the whole block whenever any instant of the block is inside the layer's
   ``[start, end]`` (the end INCLUSIVE), and the reader treats ``[0, duration)`` (the end
   EXCLUSIVE) as in the file. A block that begins exactly at a layer's end, or a layer that
   runs a little past its file (a clip's source out-point one frame past a sub-frame-length
   asset, or a processed stream stretched to its source's length), asks for nothing inside
   the file and raises. Past its end a file is silence, and silence is what it returns here.

The fix answers every request from pieces whose samples fit within half the buffer, so the
reader never splits one itself. Samples outside the file are zero. Nothing about a read that
already worked changes: the same reader and the same buffer return the same samples.
"""

from __future__ import annotations

from typing import Any, TypeVar

import numpy as np
import numpy.typing as npt

_Clip = TypeVar("_Clip")


def read_audio_samples(reader: Any, t: Any) -> Any:
    """Samples of ``reader`` at ``t``, and silence wherever ``t`` is outside the file.

    :param reader: An open ``FFMPEG_AudioReader`` (``AudioFileClip.reader``).
    :param t: One time in seconds, or an array of them, in any order.
    :returns: One frame of ``nchannels`` samples for a scalar ``t``; otherwise one row per
        requested time, zeros where the time is before 0 or at/after the file's duration.
    """
    duration = float(reader.duration)
    channels = int(reader.nchannels)
    if not isinstance(t, np.ndarray):
        if not 0.0 <= float(t) < duration:
            return np.zeros(channels)
        return reader.get_frame(t)

    times: npt.NDArray[np.float64] = np.asarray(t, dtype=np.float64)
    samples: npt.NDArray[np.float64] = np.zeros((len(times), channels))
    inside = np.flatnonzero((times >= 0.0) & (times < duration))
    if inside.size == 0:
        return samples
    # Sorted so a piece is a contiguous run of sample frames: a reversed clip asks backwards,
    # and the reader's buffering assumes ascending times.
    ordered = inside[np.argsort(times[inside], kind="stable")]
    frames = np.round(float(reader.fps) * times[ordered]).astype(np.int64)
    # Strictly under half the buffer, the reader's own split threshold, so it never splits.
    reach = max(1, int(reader.buffersize) // 2)
    begin = 0
    while begin < ordered.size:
        stop = int(np.searchsorted(frames, frames[begin] + reach, side="left"))
        piece = ordered[begin:stop]
        samples[piece] = reader.get_frame(times[piece])
        begin = stop
    return samples


def bound_audio_reads(clip: _Clip) -> _Clip:
    """Make an opened ``AudioFileClip`` answer every read through :func:`read_audio_samples`.

    Installed on the clip itself, so every clip derived from it afterwards (a subclip, a speed
    change, a gain) reads through it too.

    :param clip: An ``AudioFileClip`` whose ``reader`` is open.
    :returns: The same clip.
    """
    audio: Any = clip
    audio.frame_function = lambda t: read_audio_samples(audio.reader, t)
    return clip


__all__ = ["bound_audio_reads", "read_audio_samples"]
