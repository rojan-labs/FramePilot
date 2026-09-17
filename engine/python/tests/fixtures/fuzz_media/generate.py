"""Fuzzed-media corpus for the matte host and routes (BR4.12), generated at test time.

WHY generated: no binaries are committed. Every file is tiny (≤ 256 KB), made in well under a
second by ffmpeg or by writing bytes, and each breaks exactly one assumption a decoder, demuxer or
parser could trip over:

* media: truncated MP4 and MKV, a PNG declaring 60000x60000, corrupt FFV1 slices, negative and
  duplicate pts, zero video frames, a huge packet count, HLS and ffconcat files renamed to video
  extensions, and a playlist naming an external file (external data reference);
* ``frames.json``: over the byte bound (sparse, so it costs no disk), deep nesting, ``1e400``,
  non-integer values, a byte-order mark, out-of-range integers.

The desktop harness builds its own PNG set in TypeScript (``matte-fuzz.test.ts``).
"""

from __future__ import annotations

import json
import struct
import subprocess
import zlib
from collections.abc import Callable
from pathlib import Path

from framepilot_engine.media.ffmpeg import find_ffmpeg

MAX_CORPUS_FILE_BYTES = 256 * 1024


def _ffmpeg(*args: str) -> None:
    subprocess.run(
        [find_ffmpeg(), "-nostdin", "-v", "error", "-y", *args],
        check=True,
        capture_output=True,
        timeout=60,
    )


def _video(path: Path, *extra: str, codec: str = "ffv1", frames: int = 12) -> Path:
    _ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=64x36:rate=30",
        "-frames:v",
        str(frames),
        "-c:v",
        codec,
        *extra,
        str(path),
    )
    return path


def _truncate(path: Path, keep: float) -> Path:
    data = path.read_bytes()
    path.write_bytes(data[: max(16, int(len(data) * keep))])
    return path


def _png_chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def truncated_mp4(directory: Path) -> Path:
    return _truncate(_video(directory / "truncated.mp4", codec="mpeg4"), 0.4)


def truncated_mkv(directory: Path) -> Path:
    return _truncate(_video(directory / "truncated.mkv"), 0.5)


def huge_dimensions(directory: Path) -> Path:
    header = struct.pack(">IIBBBBB", 60_000, 60_000, 8, 0, 0, 0, 0)
    body = zlib.compress(b"\x00" * 64)
    path = directory / "huge.png"
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", body)
        + _png_chunk(b"IEND", b"")
    )
    return path


def corrupt_ffv1(directory: Path) -> Path:
    path = _video(directory / "matte.mkv", "-pix_fmt", "gray")
    data = bytearray(path.read_bytes())
    for offset in range(len(data) // 3, len(data) - 64, 97):
        data[offset] ^= 0xFF
    path.write_bytes(bytes(data))
    return path


def negative_pts(directory: Path) -> Path:
    return _video(directory / "negative.mkv", "-output_ts_offset", "-5")


def duplicate_pts(directory: Path) -> Path:
    return _video(
        directory / "duplicate.mkv",
        "-bsf:v",
        "setts=pts=trunc(N/2):dts=trunc(N/2)",
        "-f",
        "matroska",
    )


def zero_frames(directory: Path) -> Path:
    path = directory / "zero.mkv"
    _ffmpeg("-f", "lavfi", "-i", "anullsrc", "-t", "0.05", "-c:a", "pcm_s16le", str(path))
    return path


def many_packets(directory: Path) -> Path:
    path = directory / "many.mkv"
    _ffmpeg("-f", "lavfi", "-i", "color=size=2x2:rate=1000", "-t", "8", "-c:v", "ffv1", str(path))
    return path


def hls_renamed(directory: Path, target: Path) -> Path:
    path = directory / "playlist.mp4"
    path.write_text(
        f"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n{target}\n#EXT-X-ENDLIST\n",
        encoding="utf-8",
    )
    return path


def ffconcat_renamed(directory: Path, target: Path) -> Path:
    path = directory / "concat.mov"
    path.write_text(f"ffconcat version 1.0\nfile '{target}'\n", encoding="utf-8")
    return path


def external_reference(directory: Path) -> Path:
    """A playlist whose only segment is an external file outside the project (via file://)."""
    path = directory / "external.mkv"
    path.write_text(
        "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/hosts\n#EXT-X-ENDLIST\n",
        encoding="utf-8",
    )
    return path


def media_corpus(directory: Path) -> dict[str, Path]:
    """Every media case, keyed by name. ``directory`` must exist."""
    real = _video(directory / "real-target.mkv")
    builders: dict[str, Callable[[], Path]] = {
        "truncated_mp4": lambda: truncated_mp4(directory),
        "truncated_mkv": lambda: truncated_mkv(directory),
        "huge_dimensions": lambda: huge_dimensions(directory),
        "corrupt_ffv1": lambda: corrupt_ffv1(directory),
        "negative_pts": lambda: negative_pts(directory),
        "duplicate_pts": lambda: duplicate_pts(directory),
        "zero_frames": lambda: zero_frames(directory),
        "many_packets": lambda: many_packets(directory),
        "hls_renamed": lambda: hls_renamed(directory, real),
        "ffconcat_renamed": lambda: ffconcat_renamed(directory, real),
        "external_reference": lambda: external_reference(directory),
    }
    return {name: build() for name, build in builders.items()}


def frames_corpus(directory: Path) -> dict[str, Path]:
    """Every hostile ``frames.json``, each in its own folder named after the case."""

    def write(name: str, content: bytes | None = None, *, sparse_size: int | None = None) -> Path:
        folder = directory / name
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "frames.json"
        if sparse_size is not None:
            with path.open("wb") as handle:
                handle.truncate(sparse_size)
        else:
            path.write_bytes(content or b"")
        return path

    valid = {"version": 1, "timeBase": [1, 30], "originPts": 0, "firstFrame": 0, "pts": [0, 1]}
    return {
        "over_64mb": write("over_64mb", sparse_size=64 * 1024 * 1024 + 1),
        "deep_nesting": write("deep_nesting", b"[" * 200_000 + b"]" * 200_000),
        "float_overflow": write(
            "float_overflow", json.dumps({**valid, "pts": [0]}).replace("[0]", "[1e400]").encode()
        ),
        "non_integer": write("non_integer", json.dumps({**valid, "pts": [0, 1.5]}).encode()),
        "bom": write("bom", b"\xef\xbb\xbf" + json.dumps(valid).encode()),
        "huge_integer": write("huge_integer", json.dumps({**valid, "pts": [0, 10**30]}).encode()),
    }
