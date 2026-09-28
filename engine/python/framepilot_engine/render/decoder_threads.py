"""A decoder-thread cap for the ffmpeg readers of preview and evidence compositions.

WHY: a MoviePy reader is an ffmpeg process that stays alive between frames, and the
composition caches keep up to a dozen compositions' readers alive at once. ffmpeg's default
thread count (one frame thread per core) made each reader of the run-3 media (1080p H.264,
26 Mb/s) peak at 431 MB decoding at full size and 217 MB at the review's 960 px; some twenty
of them made up most of the sidecar's footprint when the run's memory watchdog killed it.
Decoded frames do not depend on the thread count (H.264 decoding is exact): five run-3 clips
at eight instants each, seeks included, were identical at auto, four and two threads, and
the tests pin it on a B-frame source.

The value (``compiler.PREVIEW_DECODER_THREADS``) is four, not two. Measured over those reads:
four threads gave 259 / 118 MB per reader (full / 960 px) for 1.3x / 1.6x the get_frame time;
two gave 198 / 89 MB for 2.1x / 2.6x, which a model would pay on every look. Part of the
slowdown is a fixed restart: MoviePy starts an uncapped decoder while opening a clip, and
:func:`cap_decoder_threads` stops it so the first frame asked for starts a capped one.

The export does not use the cap. It decodes every frame of every clip once and sequentially,
which is exactly what frame threads speed up, and it holds no cache of readers.
"""

from __future__ import annotations

import subprocess as sp
from typing import Any

from moviepy.config import FFMPEG_BINARY
from moviepy.tools import cross_platform_popen_params, ffmpeg_escape_filename
from moviepy.video.io.ffmpeg_reader import FFMPEG_VideoReader

# The value lives in the compiler, which its callers import without loading MoviePy.
from framepilot_engine.render.compiler import PREVIEW_DECODER_THREADS


class ThreadCappedVideoReader(FFMPEG_VideoReader):  # type: ignore[misc]
    """MoviePy's reader with ``-threads`` on its input; otherwise the same command, byte for byte.

    Built by :func:`cap_decoder_threads` from a reader MoviePy already opened, rather than
    constructed: ``VideoFileClip`` names its reader class directly, and re-probing the file to
    make another would cost an ffmpeg start per clip.
    """

    decoder_threads: int = PREVIEW_DECODER_THREADS

    def initialize(self, start_time: float = 0) -> None:
        """MoviePy 2.1's ``FFMPEG_VideoReader.initialize`` with ``-threads`` before the input.

        Kept in step with upstream by ``test_the_capped_command_is_moviepys_plus_threads``.
        """
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
        # Started lazily at the first frame asked for (MoviePy's own lazy start prints to
        # stdout, which the sidecar must not do).
        if not self.proc:
            self.initialize(t)
            return self.last_read
        return super().get_frame(t)


def cap_decoder_threads(clip: Any, threads: int | None) -> Any:
    """Make ``clip``'s MoviePy reader decode with ``threads`` threads from its next frame on.

    ``None`` leaves the clip alone (the export). Only MoviePy's own reader is converted; the
    variable-frame-rate reader takes the cap itself
    (:func:`~framepilot_engine.render.pts_reader.use_pts_reader`). The process MoviePy started
    while opening the clip is stopped now, not left running uncapped; the next ``get_frame``
    starts a capped one at the frame it asks for.
    """
    if threads is None:
        return clip
    reader: Any = getattr(clip, "reader", None)
    if type(reader) is not FFMPEG_VideoReader:
        return clip
    reader.close(delete_lastread=False)
    reader.__class__ = ThreadCappedVideoReader
    reader.decoder_threads = max(1, int(threads))
    return clip
