"""How the compiler opens a video source: one probe, one reader, no frame before one is asked for.

WHY one open. MoviePy's ``VideoFileClip`` probes the file (``ffmpeg -i``) and then starts a decoder
and reads frame 0 before it returns. The compiler used to open every source twice — once to learn
its size, again at the decode size the composite needs — and then stopped the second decoder to
restart it with capped threads (below). Every reader of every grab, scope and export therefore
paid two probes and two uncapped first-frame decodes it threw away, each an all-cores ffmpeg
burst: about 0.5 s a reader, measured on the captured travel reel (AL38). Here the probe is made
once (and remembered per file), the decode size is worked out from it, and the reader is built
from it without starting a decoder; the first ``get_frame`` starts one, capped from its first
frame.

WHY the export still reads frame 0 first. An eager MoviePy reader held frame 0 as ``last_read``:
its next seek either skipped forward to a frame within 100 of it or restarted ffmpeg at the new
time, and a read that came up short fell back to that frame. The export's reader (no thread cap)
reproduces that exactly — it starts at frame 0 whenever MoviePy would have skipped forward from
there — so the frames it produces are the ones the eager reader produced. A capped preview reader
starts at the first instant asked for, which is what the capped reader already did after it
stopped MoviePy's decoder.

WHY a decoder-thread cap for preview and evidence readers. A MoviePy reader is an ffmpeg process
that stays alive between frames, and the composition caches keep up to a dozen compositions'
readers alive at once. ffmpeg's default thread count (one frame thread per core) made each reader
of the run-3 media (1080p H.264, 26 Mb/s) peak at 431 MB decoding at full size and 217 MB at the
review's 960 px; some twenty of them made up most of the sidecar's footprint when the run's memory
watchdog killed it. Decoded frames do not depend on the thread count (H.264 decoding is exact):
five run-3 clips at eight instants each, seeks included, were identical at auto, four and two
threads, and the tests pin it on a B-frame source.

The value (``compiler.PREVIEW_DECODER_THREADS``) is four, not two. Measured over those reads:
four threads gave 259 / 118 MB per reader (full / 960 px) for 1.3x / 1.6x the get_frame time;
two gave 198 / 89 MB for 2.1x / 2.6x, which a model would pay on every look.

The export does not use the cap. It decodes every frame of every clip once and sequentially,
which is exactly what frame threads speed up, and it holds no cache of readers.
"""

from __future__ import annotations

import copy
import subprocess as sp
import threading
from pathlib import Path
from typing import Any

from moviepy.audio.io.AudioFileClip import AudioFileClip
from moviepy.config import FFMPEG_BINARY
from moviepy.tools import cross_platform_popen_params, ffmpeg_escape_filename
from moviepy.video.io.ffmpeg_reader import FFMPEG_VideoReader, ffmpeg_parse_infos
from moviepy.video.io.VideoFileClip import VideoFileClip
from moviepy.video.VideoClip import VideoClip

#: Frames MoviePy's reader reads through rather than restarting ffmpeg (``get_frame``'s window).
_SKIP_WINDOW_FRAMES = 100

#: Probes remembered per process. A probe is a few hundred bytes; a project has tens of sources.
_PROBE_CACHE_LIMIT = 512

_PROBES: dict[tuple[str, int, int], dict[str, Any]] = {}
_PROBES_LOCK = threading.Lock()


def probe_video(path: str | Path) -> dict[str, Any]:
    """MoviePy's own probe of ``path`` (``ffmpeg -i``), made once per file version.

    The reader's frame arithmetic (fps, duration, frame count) must be MoviePy's, parsed from
    ffmpeg's banner exactly as ``VideoFileClip`` parses it, so this is MoviePy's
    ``ffmpeg_parse_infos`` with ``VideoFileClip``'s arguments rather than the asset's ffprobe
    metadata (whose fps is the exact rational, not MoviePy's rounded one). Cached by path, size
    and modification time, like :func:`~framepilot_engine.render.pts_reader.video_timing`.

    :returns: A private copy of the probe; the caller may keep it.
    :raises OSError: ffmpeg cannot read the file (MoviePy's own error).
    """
    resolved = Path(path)
    stat = resolved.stat()
    key = (str(resolved), stat.st_size, stat.st_mtime_ns)
    with _PROBES_LOCK:
        cached = _PROBES.get(key)
    if cached is None:
        cached = ffmpeg_parse_infos(
            str(resolved), check_duration=True, fps_source="fps", decode_file=False
        )
        with _PROBES_LOCK:
            if len(_PROBES) >= _PROBE_CACHE_LIMIT:
                _PROBES.pop(next(iter(_PROBES)))
            _PROBES[key] = cached
    return copy.deepcopy(cached)


def stored_size(infos: dict[str, Any]) -> tuple[int, int]:
    """The frame size MoviePy's reader decodes at natively: the probe's, turned upright.

    ffmpeg autorotates a quarter-turned source, so MoviePy swaps width and height (``reader.size``
    with no target resolution).
    """
    width, height = infos.get("video_size", (1, 1))
    if abs(infos.get("video_rotation", 0)) in (90, 270):
        return int(height), int(width)
    return int(width), int(height)


class ProbedVideoReader(FFMPEG_VideoReader):  # type: ignore[misc]
    """MoviePy's reader, built from a probe already made, that starts ffmpeg at the first frame.

    ``decoder_threads`` puts ``-threads`` on the input (preview and evidence readers); ``None``
    runs MoviePy's command unchanged (the export). Kept in step with upstream by
    ``test_the_probed_reader_is_moviepys_reader`` and ``test_the_capped_command_is_moviepys_plus
    _threads``.
    """

    def __init__(
        self,
        filename: str,
        infos: dict[str, Any],
        *,
        target_resolution: tuple[int | None, int | None] | None = None,
        decoder_threads: int | None = None,
        pixel_format: str = "rgb24",
        resize_algo: str = "bicubic",
    ) -> None:
        # MoviePy 2.1's FFMPEG_VideoReader.__init__, attribute for attribute, without its probe
        # (``infos`` is it) and without its ``self.initialize()`` (the first frame is lazy).
        self.filename = filename
        self.proc: Any = None
        self.fps = infos.get("video_fps", 1.0)
        self.size = infos.get("video_size", (1, 1))
        self.rotation = abs(infos.get("video_rotation", 0))
        if self.rotation in [90, 270]:
            self.size = [self.size[1], self.size[0]]
        if target_resolution:
            if None in target_resolution:
                ratio = 1.0
                for idx, target in enumerate(target_resolution):
                    if target:
                        ratio = target / self.size[idx]
                self.size = (int(self.size[0] * ratio), int(self.size[1] * ratio))
            else:
                self.size = target_resolution
        self.resize_algo = resize_algo
        self.duration = infos.get("video_duration", 0.0)
        self.ffmpeg_duration = infos.get("duration", 0.0)
        self.n_frames = infos.get("video_n_frames", 0)
        self.bitrate = infos.get("video_bitrate", 0)
        self.infos = infos
        self.pixel_format = pixel_format
        self.depth = 4 if pixel_format[-1] == "a" else 3
        width, height = self.size
        self.bufsize = self.depth * width * height + 100
        self.decoder_threads = None if decoder_threads is None else max(1, int(decoder_threads))
        self.pos = 0
        self.started = False

    def initialize(self, start_time: float = 0) -> None:
        """MoviePy 2.1's ``FFMPEG_VideoReader.initialize``, with ``-threads`` when capped."""
        if self.decoder_threads is None:
            super().initialize(start_time)
            return
        self.close(delete_lastread=False)
        self.pos = self.get_frame_number(start_time)
        # MoviePy's seek rule, unchanged: the frame displayed at t, not the first after it.
        start_time = self.pos * (1 / self.fps) - 0.00001 if self.pos != 0 else 0.0
        if start_time != 0:
            offset = min(1, start_time)
            i_arg = [
                "-ss",
                f"{start_time - offset:.6f}",
                "-i",
                ffmpeg_escape_filename(self.filename),
                "-ss",
                f"{offset:.6f}",
            ]
        else:
            i_arg = ["-i", ffmpeg_escape_filename(self.filename)]
        if self.depth == 4:
            codec_name = self.infos.get("video_codec_name")
            if codec_name == "vp9":
                i_arg = ["-c:v", "libvpx-vp9", *i_arg]
            elif codec_name == "vp8":
                i_arg = ["-c:v", "libvpx", *i_arg]
        cmd = [
            FFMPEG_BINARY,
            "-threads",
            str(int(self.decoder_threads)),
            *i_arg,
            "-loglevel",
            "error",
            "-f",
            "image2pipe",
            "-vf",
            f"scale={int(self.size[0])}:{int(self.size[1])}",
            "-sws_flags",
            self.resize_algo,
            "-pix_fmt",
            self.pixel_format,
            "-vcodec",
            "rawvideo",
            "-",
        ]
        popen_params = cross_platform_popen_params(
            {"bufsize": self.bufsize, "stdout": sp.PIPE, "stderr": sp.PIPE, "stdin": sp.DEVNULL}
        )
        self.proc = sp.Popen(cmd, **popen_params)
        self.last_read = self.read_frame()

    def get_frame(self, t: float) -> Any:
        if self.proc:
            return super().get_frame(t)
        if not self.started and self.decoder_threads is None:
            self.started = True
            # The export's reader: where MoviePy's eager reader (at frame 0) would have read
            # forward, start at frame 0 and read forward the same way.
            target = self.get_frame_number(t) + 1
            if 1 <= target <= 1 + _SKIP_WINDOW_FRAMES:
                self._start(0.0)
                return super().get_frame(t)
        # MoviePy restarts ffmpeg at `t` here too (it also prints, which the sidecar must not).
        self.started = True
        self._start(t)
        return self.last_read

    def _start(self, t: float) -> None:
        """Start ffmpeg at ``t``, with MoviePy's fallback for a read that comes up short.

        MoviePy answers a short read with the last frame it read and raises only when it has
        none. Its eager reader always had frame 0 by then, so a first read past the decodable
        end gave frame 0; this reader reads frame 0 first in that case and gives the same.
        """
        try:
            self.initialize(t)
        except OSError:
            if hasattr(self, "last_read") or t == 0:
                raise
            self.initialize(0.0)
            self.initialize(t)


class ProbedVideoFileClip(VideoFileClip):  # type: ignore[misc]
    """``VideoFileClip`` over a :class:`ProbedVideoReader`: no probe, no frame read, when built.

    :param filename: The source.
    :param infos: Its probe (:func:`probe_video`).
    :param target_resolution: The decode size, as ``VideoFileClip`` takes it (``None``: native).
    :param audio: Open the source's sound too (``VideoFileClip``'s default); a picture-only
        composite passes ``False``.
    :param decoder_threads: ffmpeg decoder threads (``None``: ffmpeg's default, the export's).
    """

    def __init__(
        self,
        filename: str | Path,
        *,
        infos: dict[str, Any],
        target_resolution: tuple[int | None, int | None] | None = None,
        audio: bool = True,
        decoder_threads: int | None = None,
    ) -> None:
        # MoviePy 2.1's VideoFileClip.__init__ with its defaults (no mask, rgb24, bicubic, audio
        # at 44.1 kHz), reading through the probed reader.
        filename = str(filename)
        VideoClip.__init__(self, is_mask=False)
        self.reader = ProbedVideoReader(
            filename, infos, target_resolution=target_resolution, decoder_threads=decoder_threads
        )
        self.duration = self.reader.duration
        self.end = self.reader.duration
        self.fps = self.reader.fps
        self.size = self.reader.size
        self.rotation = self.reader.rotation
        self.filename = filename
        self.frame_function = lambda t: self.reader.get_frame(t)
        if audio and self.reader.infos["audio_found"]:
            self.audio = AudioFileClip(filename, buffersize=200000, fps=44100, nbytes=2)


__all__ = ["ProbedVideoFileClip", "ProbedVideoReader", "probe_video", "stored_size"]
