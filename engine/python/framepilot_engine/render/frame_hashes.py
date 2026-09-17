"""Decoded-frame hashes for background-removal verification (BR4.13, plan 03).

WHY in the engine: the desktop host must prove that a locked matte frame did not change and
that a relinked source still decodes to the same pictures. Both need DECODED pixels, and a
packaged desktop build ships ffprobe only; the engine already carries ffmpeg. The desktop asks
this module through two narrow sidecar routes and fails closed when the sidecar is down.

Hashes are ``ffmpeg -f framehash -hash sha256`` of the decoded frame (rawvideo), so they equal
``sha256`` of the raw pixel bytes in the requested pixel format. Paths only ever travel as their
own ``-i`` argument; the ``select`` expression is built from integers.

The inputs are untrusted media (BR4.12 M3), so every ffmpeg call is hardened: only the ``file``
protocol (no HLS/concat indirection to other files or the network), a pixel-count bound, bounded
decoder and filter threads, the Matroska demuxer forced for ``matte.mkv``, and one deadline for the
whole request rather than per decode.

* :func:`frame_hashes_by_pts` seeks to each exact source pts (``-copyts``, half a tick before) and
  returns ``None`` for a frame that does not come back with that pts, so "changed" is never
  confused with "not found".
* :func:`frame_hashes_by_index` hashes frames by decode-order index (artifact files, FFV1).
* :func:`compare_locked_frames` answers "is matte frame ``i`` bit-identical to this expected hash /
  to frame ``j`` of the previous artifact", so the hashes of the previous artifact never leave
  the engine.
"""

from __future__ import annotations

import logging
import re
import subprocess
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from framepilot_engine.media.ffmpeg import find_ffmpeg, find_ffprobe
from framepilot_engine.media.untrusted import FORMAT_WHITELIST
from framepilot_engine.render.pts_reader import video_timing
from framepilot_engine.subprocess_safety import validate_safe_argv

_log = logging.getLogger(__name__)

#: Most frames one call may name; matches the desktop inspector's batch bound.
MAX_FRAMES_PER_CALL = 256
#: Per-decode wall-clock bound, seconds (also capped by the request deadline).
DECODE_TIMEOUT_SECONDS = 120
#: Largest picture a decoder may allocate (8K x 8K), so a lying header cannot exhaust memory.
MAX_PIXELS = 8192 * 8192
#: Decoder and filter threads per ffmpeg call.
DECODE_THREADS = 2
#: Largest pts or index accepted (well inside int64 and float precision).
MAX_ABS_PTS = 2**52

PixelFormat = Literal["native", "gray", "rgb24"]

_HASH_ROW = re.compile(r"^\s*\d+,\s*-?\d+,\s*(-?\d+),\s*-?\d+,\s*\d+,\s*([0-9a-f]{64})\s*$")


class FrameHashError(RuntimeError):
    """ffmpeg could not decode the requested frames."""


class FrameHashDeadline(FrameHashError):
    """The request's total deadline passed before every frame was decoded."""


def _pixel_args(pixel_format: PixelFormat) -> list[str]:
    return [] if pixel_format == "native" else ["-pix_fmt", pixel_format]


def _input_args(path: Path) -> list[str]:
    """Hardened input options for untrusted media; the path is its own argument."""
    forced = ["-f", "matroska"] if path.name == "matte.mkv" else []
    return [
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        FORMAT_WHITELIST,
        "-max_pixels",
        str(MAX_PIXELS),
        "-threads",
        str(DECODE_THREADS),
        *forced,
    ]


def _remaining(deadline: float | None) -> float:
    if deadline is None:
        return DECODE_TIMEOUT_SECONDS
    left = deadline - time.monotonic()
    if left <= 0:
        raise FrameHashDeadline("The frame check ran out of time.")
    return min(DECODE_TIMEOUT_SECONDS, left)


def _run(argv: list[str], deadline: float | None, name: str) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(argv, capture_output=True, check=False, timeout=_remaining(deadline))
    except subprocess.TimeoutExpired as exc:
        raise FrameHashDeadline(f"Decoding {name} ran out of time.") from exc


def _assert_allowed_container(path: Path, deadline: float | None) -> None:
    """Refuse a file whose container is not on :data:`FORMAT_WHITELIST` before any other probe."""
    argv = validate_safe_argv(
        [
            find_ffprobe(),
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            FORMAT_WHITELIST,
            "-show_entries",
            "format=format_name",
            "-of",
            "csv=p=0",
            "-i",
            str(path),
        ]
    )
    if _run(argv, deadline, path.name).returncode != 0:
        raise FrameHashError(f"{path.name} is not a media container FramePilot checks.")


def _parse_rows(stdout: bytes) -> list[tuple[int, str]]:
    rows: list[tuple[int, str]] = []
    for line in stdout.decode("utf-8", "replace").splitlines():
        if line.startswith("#"):
            continue
        match = _HASH_ROW.match(line)
        if match is not None:
            rows.append((int(match.group(1)), match.group(2)))
    return rows


def frame_hashes_by_index(
    path: Path,
    indexes: Sequence[int],
    pixel_format: PixelFormat = "gray",
    *,
    deadline: float | None = None,
) -> list[str]:
    """sha256 of decoded frames ``indexes`` (decode-output order), in request order.

    :raises ValueError: More than :data:`MAX_FRAMES_PER_CALL`, or an index out of bounds.
    :raises FrameHashError: A frame is missing, ffmpeg failed or the deadline passed.
    """
    if len(indexes) > MAX_FRAMES_PER_CALL or any(i < 0 or i > MAX_ABS_PTS for i in indexes):
        raise ValueError("frame indexes must be at most 256 non-negative bounded integers")
    if not indexes:
        return []
    wanted = sorted({int(i) for i in indexes})
    select = "select=" + "+".join(f"eq(n\\,{i})" for i in wanted)
    argv = validate_safe_argv(
        [
            find_ffmpeg(),
            "-nostdin",
            "-v",
            "error",
            *_input_args(path),
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-vf",
            select,
            "-filter_threads",
            "1",
            "-fps_mode",
            "passthrough",
            *_pixel_args(pixel_format),
            "-f",
            "framehash",
            "-hash",
            "sha256",
            "-",
        ]
    )
    completed = _run(argv, deadline, path.name)
    rows = _parse_rows(completed.stdout)
    if completed.returncode != 0 or len(rows) != len(wanted):
        raise FrameHashError(f"Could not decode the requested frames of {path.name}.")
    by_index = {index: rows[position][1] for position, index in enumerate(wanted)}
    return [by_index[int(i)] for i in indexes]


def frame_hashes_by_pts(
    path: Path,
    pts: Sequence[int],
    pixel_format: PixelFormat = "native",
    *,
    deadline: float | None = None,
) -> list[str | None]:
    """sha256 of the decoded frame at each exact source pts; ``None`` where it is not that frame.

    :raises ValueError: More than :data:`MAX_FRAMES_PER_CALL` values, or a pts out of bounds.
    :raises FrameHashError: The file's timestamps cannot be listed, or the deadline passed.
    """
    if len(pts) > MAX_FRAMES_PER_CALL or any(abs(int(p)) > MAX_ABS_PTS for p in pts):
        raise ValueError("at most 256 bounded pts per call")
    _assert_allowed_container(path, deadline)
    try:
        time_base = video_timing(path).time_base
    except Exception as exc:  # VideoTimingError, OSError
        raise FrameHashError(f"Could not list the video timestamps of {path.name}.") from exc
    ffmpeg = find_ffmpeg()
    out: list[str | None] = []
    for target in pts:
        seconds = float((int(target) - 0.5) * time_base)
        argv = validate_safe_argv(
            [
                ffmpeg,
                "-nostdin",
                "-v",
                "error",
                *_input_args(path),
                "-copyts",
                "-ss",
                f"{seconds:.9f}",
                "-i",
                str(path),
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-fps_mode",
                "passthrough",
                "-enc_time_base",
                f"{time_base.numerator}/{time_base.denominator}",
                *_pixel_args(pixel_format),
                "-f",
                "framehash",
                "-hash",
                "sha256",
                "-",
            ]
        )
        completed = _run(argv, deadline, path.name)
        rows = _parse_rows(completed.stdout)
        if completed.returncode != 0 or not rows or rows[0][0] != int(target):
            out.append(None)
            continue
        out.append(rows[0][1])
    return out


@dataclass(frozen=True)
class LockedFrameComparison:
    """Per-check verdicts, in request order."""

    expected: list[bool]
    carried: list[bool]


def compare_locked_frames(
    matte: Path,
    expected: Sequence[tuple[int, str]],
    previous: Path | None = None,
    carried: Sequence[tuple[int, int]] = (),
    *,
    deadline: float | None = None,
) -> LockedFrameComparison:
    """Whether matte frames are bit-identical (8-bit gray) to expected hashes and a previous matte.

    :param expected: ``(index, sha256 of the locked input's 8-bit pixels)`` pairs.
    :param carried: ``(index in matte, index in previous)`` pairs; needs ``previous``.
    :raises FrameHashError: A frame cannot be decoded, or the deadline passed (callers fail closed).
    """
    if carried and previous is None:
        raise ValueError("carried frames need a previous matte")
    indexes = [index for index, _ in expected] + [index for index, _ in carried]
    actual: list[str] = []
    for start in range(0, len(indexes), MAX_FRAMES_PER_CALL):
        actual += frame_hashes_by_index(
            matte, indexes[start : start + MAX_FRAMES_PER_CALL], "gray", deadline=deadline
        )
    before: list[str] = []
    if carried and previous is not None:
        previous_indexes = [index for _, index in carried]
        for start in range(0, len(previous_indexes), MAX_FRAMES_PER_CALL):
            before += frame_hashes_by_index(
                previous,
                previous_indexes[start : start + MAX_FRAMES_PER_CALL],
                "gray",
                deadline=deadline,
            )
    expected_ok = [actual[i] == sha for i, (_, sha) in enumerate(expected)]
    carried_ok = [actual[len(expected) + i] == before[i] for i in range(len(carried))]
    if not all(expected_ok) or not all(carried_ok):
        _log.info(
            "locked frame comparison: %d/%d expected, %d/%d carried unchanged",
            sum(expected_ok),
            len(expected_ok),
            sum(carried_ok),
            len(carried_ok),
        )
    return LockedFrameComparison(expected=expected_ok, carried=carried_ok)
