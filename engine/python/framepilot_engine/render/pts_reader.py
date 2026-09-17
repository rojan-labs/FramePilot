"""Frame-exact decoding of variable-frame-rate video by presentation time (BR2.5).

WHY: MoviePy's ffmpeg reader pipes ``image2pipe`` output, which ffmpeg resamples to a constant
rate (duplicating and dropping frames by its own rounding), and then indexes that stream by
``int(fps * t)``. On constant-rate footage that IS the source frame at ``t``. On
variable-frame-rate footage (phones, screen recordings) it is not: the frame shown at ``t``
depends on ffmpeg's resampling and even on where the reader last seeked, so the export drew a
neighbouring frame and a matte could never be proven to belong to the picture.

This module fixes that for VFR sources only:

* :func:`video_timing` lists a file's video packet timestamps once (demux, no decode; cached by
  path, size and modification time) and says whether the frame step is constant (every step
  within one tick of the others).
* A constant-rate source keeps MoviePy's reader untouched, so every existing export stays
  byte-identical.
* A variable-rate source gets :class:`PtsVideoReader`: ffmpeg decodes with
  ``-fps_mode passthrough`` (every decoded frame once, none invented), and the frame at source
  second ``t`` is the last frame whose pts is at or before ``t`` (measured from the first frame,
  MoviePy's clock zero). Seeks land on an exact frame by seeking halfway between it and the
  previous one. Scaling and pixel format are MoviePy's own (``scale`` + ``bicubic``, rgb24).
"""

from __future__ import annotations

import bisect
import logging
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import IO, Any

import numpy as np
import numpy.typing as npt

from framepilot_engine.media.ffmpeg import find_ffmpeg, find_ffprobe
from framepilot_engine.media.untrusted import untrusted_input_options
from framepilot_engine.subprocess_safety import validate_safe_argv

_log = logging.getLogger(__name__)

#: A forward jump up to this many frames reads through instead of reseeking (MoviePy uses 100).
FORWARD_READ_THROUGH = 100
#: Slack when comparing a requested time with a frame's pts, seconds (well under any tick).
PTS_EPSILON = 1e-6


class VideoTimingError(RuntimeError):
    """The file's video timestamps could not be listed."""


@dataclass(frozen=True)
class VideoTiming:
    """Presentation timestamps of every decoded video frame, in decode-output order."""

    time_base: Fraction
    pts: tuple[int, ...]
    start_time: float

    @property
    def count(self) -> int:
        return len(self.pts)

    @property
    def constant_rate(self) -> bool:
        """Every frame step within one tick of the others (container rounding allowed)."""
        if self.count < 3:
            return True
        steps = np.diff(np.asarray(self.pts, dtype=np.int64))
        return int(steps.max()) - int(steps.min()) <= 1

    def relative_seconds(self) -> list[float]:
        """Each frame's pts in seconds from the first frame (the asset clock)."""
        first = self.pts[0]
        return [float((value - first) * self.time_base) for value in self.pts]


_TIMINGS: dict[tuple[str, int, int], VideoTiming] = {}


def video_timing(path: str | Path) -> VideoTiming:
    """The video stream's frame timestamps, cached by path, size and modification time.

    Packets the demuxer marks discarded (``D``: edit-list pre-roll) never become frames, so
    they are left out. B-frame reordering is undone by sorting: the decoder outputs frames in
    presentation order.

    :raises VideoTimingError: ffprobe failed or the file has no video packets.
    """
    resolved = Path(path)
    stat = resolved.stat()
    cache_key = (str(resolved), stat.st_size, stat.st_mtime_ns)
    cached = _TIMINGS.get(cache_key)
    if cached is not None:
        return cached
    probe = find_ffprobe()
    header = subprocess.run(
        validate_safe_argv(
            [
                probe,
                "-v",
                "error",
                *untrusted_input_options(),
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=time_base:format=start_time",
                "-of",
                "default=nw=1",
                str(resolved),
            ]
        ),
        capture_output=True,
        check=False,
        timeout=60,
    )
    packets = subprocess.run(
        validate_safe_argv(
            [
                probe,
                "-v",
                "error",
                *untrusted_input_options(),
                "-select_streams",
                "v:0",
                "-show_entries",
                "packet=pts,flags",
                "-of",
                "csv=p=0",
                str(resolved),
            ]
        ),
        capture_output=True,
        check=False,
        timeout=600,
    )
    if header.returncode != 0 or packets.returncode != 0:
        raise VideoTimingError(f"Could not list the video timestamps of {resolved.name}.")
    fields = dict(line.split("=", 1) for line in header.stdout.decode().splitlines() if "=" in line)
    try:
        num, den = (int(part) for part in fields["time_base"].split("/"))
        start = float(fields.get("start_time") or 0.0)
    except (KeyError, ValueError) as exc:
        raise VideoTimingError(f"{resolved.name} has no readable video time base.") from exc
    values: list[int] = []
    for line in packets.stdout.decode().splitlines():
        pts_text, _, flags = line.partition(",")
        if not pts_text or pts_text == "N/A" or "D" in flags:
            continue
        values.append(int(pts_text))
    if not values:
        raise VideoTimingError(f"{resolved.name} has no video frames with timestamps.")
    values.sort()
    timing = VideoTiming(time_base=Fraction(num, den), pts=tuple(values), start_time=start)
    _TIMINGS[cache_key] = timing
    _log.debug(
        "video timing %s: %d frames, %s rate",
        resolved.name,
        timing.count,
        "constant" if timing.constant_rate else "variable",
    )
    return timing


class PtsVideoReader:
    """A drop-in for MoviePy's ``FFMPEG_VideoReader`` that picks frames by pts.

    Implements what ``VideoFileClip`` and ``close_clip_tree`` use: ``get_frame``, ``close``,
    ``proc``, ``size``, ``fps``, ``duration`` and ``last_read``.
    """

    def __init__(
        self,
        filename: str,
        timing: VideoTiming,
        size: tuple[int, int],
        fps: float,
        duration: float,
        resize_algo: str = "bicubic",
    ) -> None:
        self.filename = filename
        self.timing = timing
        self.size = (int(size[0]), int(size[1]))
        self.fps = fps
        self.duration = duration
        self.resize_algo = resize_algo
        self.depth = 3
        self.proc: subprocess.Popen[bytes] | None = None
        self.pos = -1
        self.last_read: npt.NDArray[np.uint8] | None = None
        self._seconds = timing.relative_seconds()
        self.decoder_starts = 0

    def frame_index(self, t: float) -> int:
        """The decode-order frame shown at source second ``t``: last pts at or before it."""
        index = bisect.bisect_right(self._seconds, float(t) + PTS_EPSILON) - 1
        return min(max(index, 0), self.timing.count - 1)

    def _seek_seconds(self, index: int) -> float | None:
        if index == 0:
            return None
        tb = self.timing.time_base
        middle = (self.timing.pts[index - 1] + self.timing.pts[index]) * tb / 2
        return max(float(middle) - self.timing.start_time, 0.0)

    def _open(self, index: int) -> None:
        self.close()
        argv = [find_ffmpeg(), "-nostdin"]
        seek = self._seek_seconds(index)
        if seek is not None:
            argv += ["-ss", f"{seek:.9f}"]
        argv += [
            "-i",
            self.filename,
            "-loglevel",
            "error",
            "-map",
            "0:v:0",
            "-fps_mode",
            "passthrough",
            "-f",
            "image2pipe",
            "-vf",
            f"scale={self.size[0]}:{self.size[1]}",
            "-sws_flags",
            self.resize_algo,
            "-pix_fmt",
            "rgb24",
            "-vcodec",
            "rawvideo",
            "-",
        ]
        self.proc = subprocess.Popen(
            validate_safe_argv(argv),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
        )
        self.decoder_starts += 1
        self.pos = index - 1

    def _read(self) -> npt.NDArray[np.uint8] | None:
        proc = self.proc
        if proc is None or proc.stdout is None:
            return None
        stdout: IO[bytes] = proc.stdout
        width, height = self.size
        data = stdout.read(self.depth * width * height)
        if len(data) != self.depth * width * height:
            return None
        self.pos += 1
        frame = np.frombuffer(data, dtype=np.uint8).reshape((height, width, self.depth))
        self.last_read = frame
        return frame

    def get_frame(self, t: float) -> Any:
        """The frame at source second ``t`` (the last frame past the end, as MoviePy does)."""
        index = self.frame_index(t)
        if index == self.pos and self.last_read is not None:
            return self.last_read
        if self.proc is None or index < self.pos or index > self.pos + FORWARD_READ_THROUGH:
            self._open(index)
        while self.pos < index:
            if self._read() is None:
                break
        if self.last_read is None:
            raise VideoTimingError(f"Could not decode a frame of {Path(self.filename).name}.")
        return self.last_read

    def close(self, delete_lastread: bool = False) -> None:
        proc = self.proc
        self.proc = None
        if proc is not None:
            if proc.poll() is None:
                proc.kill()
            if proc.stdout is not None:
                proc.stdout.close()
            proc.wait()
        if delete_lastread:
            self.last_read = None


def use_pts_reader(clip: Any, path: str) -> Any:
    """Swap a ``VideoFileClip``'s reader for :class:`PtsVideoReader` when the source is VFR.

    Constant-rate sources are returned untouched (byte-identical exports).
    """
    timing = video_timing(path)
    if timing.constant_rate:
        return clip
    original = clip.reader
    replacement = PtsVideoReader(
        path, timing, tuple(original.size), float(original.fps), float(original.duration)
    )
    original.close()
    clip.reader = replacement
    _log.info("ACT decode: %s is variable frame rate; reading frames by pts", Path(path).name)
    return clip


def reader_frame_index(clip: Any, source_time: float | None, fps: float) -> int | None:
    """The decode-order frame a compiled source clip shows at ``source_time``.

    The one rule the picture and a matte share: pts for a :class:`PtsVideoReader`, MoviePy's
    ``int(fps * t + 1e-5)`` otherwise.
    """
    if source_time is None:
        return None
    reader = getattr(clip, "reader", None)
    if isinstance(reader, PtsVideoReader):
        return reader.frame_index(source_time)
    return int(fps * source_time + 0.00001)
