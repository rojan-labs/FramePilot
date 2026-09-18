"""ffmpeg/ffprobe input options for media the engine does not control (BR4.12 M3).

WHY one place: every probe or decode of user or pack media must refuse indirection. Only the
``file`` protocol (no network), and only real media containers (no HLS playlist or ffconcat file
renamed to ``.mp4`` that makes ffmpeg open another file on our behalf). A decode also bounds the
picture a lying header may make the decoder allocate, and the threads it may start.
"""

from __future__ import annotations

#: Demuxers a camera file, image or matte may use.
FORMAT_WHITELIST = (
    "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mpeg,flv,mxf,ogg,asf,dv,ivf,gif,"
    "image2,png_pipe,jpeg_pipe,webp_pipe,tiff_pipe,bmp_pipe"
)
#: Largest picture a decoder may allocate (8K x 8K), so a lying header cannot exhaust memory.
MAX_PIXELS = 8192 * 8192
#: Decoder and filter threads per ffmpeg call.
DECODE_THREADS = 2


def untrusted_input_options() -> list[str]:
    """Protocol and demuxer whitelists to place before ``-i``."""
    return ["-protocol_whitelist", "file", "-format_whitelist", FORMAT_WHITELIST]


def bounded_decode_input_options(forced_format: str | None = None) -> list[str]:
    """:func:`untrusted_input_options` plus ``-max_pixels`` and bounded threads, to place
    before ``-i``; ``forced_format`` pins the demuxer when the container is part of a contract
    (a matte artifact is always Matroska)."""
    forced = ["-f", forced_format] if forced_format else []
    return [
        *untrusted_input_options(),
        "-max_pixels",
        str(MAX_PIXELS),
        "-threads",
        str(DECODE_THREADS),
        *forced,
    ]
