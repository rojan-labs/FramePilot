"""Stage 11: lossless masters, small previews, and window segments joined without re-encoding.

* ``matte.mkv``: FFV1 level 3, ``gray``, intra-only (one packet per frame, which is how the host
  and the engine count frames), slice CRCs on.
* ``foreground.mkv``: FFV1 ``bgr0`` (FFV1's lossless 8-bit RGB layout; it has no 8-bit ``gbrp``;
  the engine decodes it to rgb24).
* ``preview.webm`` / ``foreground.preview.webm``: VP9 at ``previewHeight`` (even width), no
  alt-ref or lag, so every input frame is exactly one packet.

Frames carry no timestamps the pipeline relies on: frame ``i`` of every file is matte frame ``i``
and its pts is ``frames.json`` ``pts[i]`` (``render/mattes.py``).

Each processing window is encoded as its own segment under the worker-private ``windows/``
directory as soon as it is finished (progressive output, resume); the declared files are made
at the end by stream-copy concatenation, which is bit-exact for FFV1 and VP9 packets.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import IO, Any, Final

import numpy as np
import numpy.typing as npt

from .backend import ToolUnavailableError
from .protocol import ProtocolError

KINDS: Final = ("matte", "foreground", "preview", "foreground_preview")
#: Container frame rate for the raw input. Irrelevant to identity (frames are counted).
RAW_RATE: Final = "30"
VP9_ARGS: Final = (
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-b:v", "0", "-crf", "34", "-deadline", "good",
    "-cpu-used", "5", "-row-mt", "1", "-auto-alt-ref", "0", "-lag-in-frames", "0", "-g", "240",
)  # fmt: skip
ENCODE_TIMEOUT_SECONDS: Final = 24 * 3600


def preview_size(width: int, height: int, preview_height: int) -> tuple[int, int]:
    """Even-sided preview no taller than the source, keeping the aspect ratio."""
    target_h = min(preview_height, height)
    target_h -= target_h % 2
    target_h = max(target_h, 2)
    target_w = max(round(width * target_h / height / 2) * 2, 2)
    return target_w, target_h


def encode_argv(
    ffmpeg: str, destination: str, kind: str, width: int, height: int, preview_height: int
) -> list[str]:
    if kind not in KINDS:
        raise ProtocolError("internal_error", f"unknown encode kind {kind!r}")
    source_format = "gray" if kind in ("matte", "preview") else "rgb24"
    argv = [
        ffmpeg, "-nostdin", "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", source_format, "-s", f"{width}x{height}",
        "-framerate", RAW_RATE, "-i", "-",
        "-map", "0:v:0", "-fps_mode", "passthrough",
    ]  # fmt: skip
    if kind == "matte":
        argv += ["-c:v", "ffv1", "-level", "3", "-g", "1", "-slicecrc", "1", "-pix_fmt", "gray"]
    elif kind == "foreground":
        argv += ["-c:v", "ffv1", "-level", "3", "-g", "1", "-slicecrc", "1", "-pix_fmt", "bgr0"]
    else:
        preview_w, preview_h = preview_size(width, height, preview_height)
        argv += ["-vf", f"scale={preview_w}:{preview_h}:flags=area", *VP9_ARGS]
    # bitexact: no random segment UID or encoder string, so identical frames give identical bytes
    # (a resumed job equals an uninterrupted one; a cache key over file digests is stable).
    argv += ["-fflags", "+bitexact", "-flags:v", "+bitexact"]
    argv += ["-f", "matroska" if kind in ("matte", "foreground") else "webm", destination]
    return argv


def encode_stream(
    ffmpeg: str,
    destination: str,
    kind: str,
    width: int,
    height: int,
    frames: Iterator[bytes],
    preview_height: int,
) -> int:
    """Pipe raw frames into ffmpeg; returns the number of frames written."""
    process = subprocess.Popen(
        encode_argv(ffmpeg, destination, kind, width, height, preview_height),
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    stdin: IO[bytes] | None = process.stdin
    assert stdin is not None
    written = 0
    try:
        for frame in frames:
            stdin.write(frame)
            written += 1
        stdin.close()
    except BrokenPipeError:
        pass
    except BaseException:
        process.kill()
        process.wait()
        raise
    stderr = process.stderr.read() if process.stderr is not None else b""
    code = process.wait(timeout=ENCODE_TIMEOUT_SECONDS)
    if code != 0:
        text = stderr.decode("utf-8", "replace").lower()
        if "no space" in text or "permission denied" in text or "read-only" in text:
            raise ProtocolError(
                "output_unwritable",
                "The matte could not be written: the disk is full or not writable.",
                retryable=True,
            )
        raise ProtocolError("internal_error", f"ffmpeg could not encode the {kind} stream.")
    return written


def concat_segments(
    ffmpeg: str, destination: str, segments: list[str], list_directory: Path
) -> None:
    """Join segments of one kind by stream copy, in order."""
    if not segments:
        raise ProtocolError("internal_error", "there are no segments to join.")
    listing = list_directory / f"concat-{Path(destination).stem}.txt"
    lines = []
    for segment in segments:
        escaped = str(Path(segment).resolve()).replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    listing.write_text("\n".join(lines) + "\n", encoding="utf-8")
    muxer = "webm" if destination.endswith(".webm") else "matroska"
    completed = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
         "-map", "0:v:0", "-c", "copy", "-fps_mode", "passthrough", "-fflags", "+bitexact",
         "-f", muxer, destination],
        capture_output=True, check=False, timeout=ENCODE_TIMEOUT_SECONDS, stdin=subprocess.DEVNULL,
    )  # fmt: skip
    listing.unlink(missing_ok=True)
    if completed.returncode != 0:
        raise ProtocolError("internal_error", "ffmpeg could not join the matte segments.")


def packet_count(ffprobe: str, path: str) -> int:
    completed = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-count_packets",
         "-show_entries", "stream=nb_read_packets,width,height,pix_fmt", "-of", "json", path],
        capture_output=True, check=False, timeout=600, stdin=subprocess.DEVNULL,
    )  # fmt: skip
    if completed.returncode != 0:
        raise ToolUnavailableError("ffprobe could not read an encoded matte stream.")
    streams: list[dict[str, Any]] = json.loads(completed.stdout or b"{}").get("streams") or []
    return int(streams[0].get("nb_read_packets") or 0) if streams else 0


def decode_gray_frames(
    ffmpeg: str, path: str, width: int, height: int
) -> Iterator[npt.NDArray[np.uint8]]:
    """Decode an FFV1 gray matte (e.g. a previous artifact) frame by frame."""
    process = subprocess.Popen(
        [ffmpeg, "-nostdin", "-v", "error", "-i", path, "-map", "0:v:0", "-fps_mode", "passthrough",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )  # fmt: skip
    stdout = process.stdout
    assert stdout is not None
    size = width * height
    try:
        while True:
            data = stdout.read(size)
            if len(data) < size:
                return
            yield np.frombuffer(data, np.uint8).reshape(height, width)
    finally:
        if process.poll() is None:
            process.kill()
        stdout.close()
        process.wait()


__all__ = [
    "KINDS",
    "concat_segments",
    "decode_gray_frames",
    "encode_argv",
    "encode_stream",
    "packet_count",
    "preview_size",
]
