"""ffprobe/ffmpeg with the engine's frame identity and colour, plus the LGPL-only tool gate.

Frame identity (plan 03 "Frame identity"; ``render/pts_reader.py``): a clip's frames are the
first video stream's packet timestamps with discarded (``D``) packets dropped, sorted into
presentation order. Frame ``i`` of a decode with ``-fps_mode passthrough`` is the frame with
the ``i``-th pts. ``frames.json`` stores exactly those pts, so the host's own ffprobe listing,
the engine and this worker agree to the tick.

Colour: the export decodes with ffmpeg's default autorotate and ``rgb24`` through swscale with
``bicubic`` flags, scaling only when the display size differs from the storage size (anamorphic
sources). This module issues the same command, so a matte's pixels line up with the picture
the export composites it over. Output is DISPLAY space: pixel aspect ratio applied, quarter
turns applied, each side ``floor(x + 0.5)`` (BR2.6).

Tools: the pack ships an LGPL-only ffmpeg/ffprobe in ``<pack root>/bin``. PyAV was rejected
because every wheel checked bundles libx264/libx265. :func:`assess_ffmpeg_build` refuses a
GPL or nonfree build; a developer may override that for local runs only, and the override is
recorded in report.json.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from typing import IO, Any, Final

from .backend import MediaUnreadableError, ToolUnavailableError, VideoInfo

_log = logging.getLogger(__name__)

ENV_FFMPEG: Final = "FRAMEPILOT_SMART_MASK_FFMPEG"
ENV_FFPROBE: Final = "FRAMEPILOT_SMART_MASK_FFPROBE"
#: Local development only: accept a GPL ffmpeg (e.g. Homebrew). Never set in a pack.
ENV_ALLOW_UNAPPROVED: Final = "FRAMEPILOT_SMART_MASK_ALLOW_UNAPPROVED_FFMPEG"
ENV_PACK_ROOT: Final = "FRAMEPILOT_CAPABILITY_PACK_ROOT"
PROBE_TIMEOUT_SECONDS: Final = 120
#: Configure flags that make an FFmpeg build GPL or non-redistributable.
FORBIDDEN_CONFIGURE_FLAGS: Final = (
    "--enable-gpl",
    "--enable-nonfree",
    "--enable-libx264",
    "--enable-libx265",
    "--enable-libxvid",
    "--enable-libfdk-aac",
    "--enable-librubberband",
    "--enable-libvidstab",
    "--enable-frei0r",
)
_ROTATION_KEYS: Final = ("rotation",)


@dataclass(frozen=True, slots=True)
class FfmpegBuildVerdict:
    approved: bool
    licence: str
    reasons: tuple[str, ...]


def assess_ffmpeg_build(version_output: str, licence_output: str) -> FfmpegBuildVerdict:
    """Decide from ``ffmpeg -version`` and ``ffmpeg -L`` whether a build is LGPL-only."""
    reasons: list[str] = []
    configuration = ""
    for text_line in version_output.splitlines():
        if text_line.startswith("configuration:"):
            configuration = text_line
    if not configuration:
        reasons.append("the build does not report its configuration")
    for flag in FORBIDDEN_CONFIGURE_FLAGS:
        if re.search(rf"(^|\s){re.escape(flag)}(\s|$)", configuration):
            reasons.append(f"configured with {flag}")
    lowered = licence_output.lower()
    if "lesser general public license" in lowered:
        licence = "LGPL-3.0-or-later" if "version 3" in lowered else "LGPL-2.1-or-later"
    elif "general public license" in lowered:
        licence = "GPL"
        reasons.append("ffmpeg -L reports the GNU General Public License")
    elif "nonfree" in lowered or "unredistributable" in lowered:
        licence = "nonfree"
        reasons.append("ffmpeg -L reports a non-redistributable build")
    else:
        licence = "unknown"
        reasons.append("ffmpeg -L does not state a licence")
    return FfmpegBuildVerdict(approved=not reasons, licence=licence, reasons=tuple(reasons))


def _executable(name: str) -> str:
    return f"{name}.exe" if sys.platform == "win32" else name


def locate_tool(name: str, environment: Mapping[str, str] | None = None) -> tuple[Path, str]:
    """``(path, origin)``: explicit override, then the pack's ``bin/``, then PATH (dev only)."""
    env = os.environ if environment is None else environment
    override = env.get(ENV_FFMPEG if name == "ffmpeg" else ENV_FFPROBE, "")
    if override:
        return Path(override), "override"
    root = env.get(ENV_PACK_ROOT, "")
    if root:
        bundled = Path(root) / "bin" / _executable(name)
        if bundled.is_file():
            return bundled, "pack"
    found = shutil.which(name)
    if found:
        return Path(found), "path"
    raise ToolUnavailableError(f"{name} is not installed with this pack.")


@dataclass(frozen=True, slots=True)
class ToolReport:
    """Recorded in report.json: which ffmpeg made the pixels, and whether it was approved."""

    ffmpeg: str
    origin: str
    licence: str
    approved: bool
    reasons: tuple[str, ...]


def _run(argv: list[str], timeout: float) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            argv, capture_output=True, check=False, timeout=timeout, stdin=subprocess.DEVNULL
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ToolUnavailableError(
            f"{Path(argv[0]).name} could not run: {type(error).__name__}."
        ) from error


def verify_tools(environment: Mapping[str, str] | None = None) -> tuple[Path, Path, ToolReport]:
    """Locate ffmpeg/ffprobe and refuse an unapproved build unless a dev override is set."""
    env = os.environ if environment is None else environment
    ffmpeg, origin = locate_tool("ffmpeg", env)
    ffprobe, _ = locate_tool("ffprobe", env)
    version = _run([str(ffmpeg), "-hide_banner", "-version"], 30)
    licence = _run([str(ffmpeg), "-hide_banner", "-L"], 30)
    if version.returncode != 0:
        raise ToolUnavailableError("ffmpeg did not report its version.")
    verdict = assess_ffmpeg_build(
        version.stdout.decode("utf-8", "replace"), licence.stdout.decode("utf-8", "replace")
    )
    first_line = (
        version.stdout.decode("utf-8", "replace").splitlines()[0] if version.stdout else "ffmpeg"
    )
    report = ToolReport(
        first_line[:120], origin, verdict.licence, verdict.approved, verdict.reasons
    )
    if not verdict.approved:
        allowed = env.get(ENV_ALLOW_UNAPPROVED, "") == "1" and origin != "pack"
        if not allowed:
            raise ToolUnavailableError(
                "the ffmpeg in this pack is not an approved LGPL-only build: "
                + "; ".join(verdict.reasons)
            )
        _log.warning(
            "using an unapproved ffmpeg build for local development: %s", "; ".join(verdict.reasons)
        )
    return ffmpeg, ffprobe, report


# --- probing -------------------------------------------------------------------------------


def _parse_ratio(value: Any, default: tuple[int, int]) -> tuple[int, int]:
    if not isinstance(value, str) or (":" not in value and "/" not in value):
        return default
    left, _, right = value.replace("/", ":").partition(":")
    try:
        numerator, denominator = int(left), int(right)
    except ValueError:
        return default
    if numerator <= 0 or denominator <= 0:
        return default
    return (numerator, denominator)


def _rotation(stream: dict[str, Any]) -> int:
    """Quarter-turn that autorotate applies, as 0/90/180/270."""
    degrees = 0.0
    for side in stream.get("side_data_list") or []:
        if isinstance(side, dict) and "rotation" in side:
            try:
                degrees = float(side["rotation"])
            except (TypeError, ValueError):
                degrees = 0.0
    tags = stream.get("tags") or {}
    if not degrees and isinstance(tags, dict) and "rotate" in tags:
        try:
            degrees = -float(tags["rotate"])
        except (TypeError, ValueError):
            degrees = 0.0
    return round(-degrees / 90.0) % 4 * 90


def parse_probe(stream_json: bytes, packets_json: bytes) -> VideoInfo:
    """Build :class:`VideoInfo` from two ffprobe JSON documents (pure, unit-tested)."""
    try:
        header = json.loads(stream_json or b"{}")
        packets = json.loads(packets_json or b"{}")
    except ValueError as error:
        raise MediaUnreadableError("ffprobe returned unreadable output.") from error
    streams = header.get("streams") or []
    if not streams:
        raise MediaUnreadableError("The media has no video stream.")
    stream = streams[0]
    try:
        width, height = int(stream["width"]), int(stream["height"])
    except (KeyError, TypeError, ValueError) as error:
        raise MediaUnreadableError("The video stream has no size.") from error
    time_base = _parse_ratio(stream.get("time_base"), (0, 0))
    if time_base == (0, 0) or width <= 0 or height <= 0:
        raise MediaUnreadableError("The video stream has no time base or size.")
    start_time = float((header.get("format") or {}).get("start_time") or 0.0)
    pts: list[int] = []
    for packet in packets.get("packets") or []:
        flags = str(packet.get("flags") or "")
        value = packet.get("pts")
        if "D" in flags or value is None or value == "N/A":
            continue
        pts.append(int(value))
    if not pts:
        raise MediaUnreadableError("The video stream has no timestamped frames.")
    pts.sort()
    if any(later == earlier for earlier, later in pairwise(pts)):
        raise MediaUnreadableError("The video stream repeats a frame timestamp.")
    return VideoInfo(
        width=width,
        height=height,
        sample_aspect=_parse_ratio(stream.get("sample_aspect_ratio"), (1, 1)),
        rotation=_rotation(stream),
        time_base=time_base,
        pts=tuple(pts),
        start_time=start_time,
    )


def frames_document(info: VideoInfo, first_frame: int, count: int) -> dict[str, Any]:
    """The ``frames.json`` document ``render/mattes.py::parse_frames`` and the host verify."""
    if first_frame < 0 or count < 1 or first_frame + count > len(info.pts):
        raise MediaUnreadableError("The requested frames are outside the media's decoded frames.")
    return {
        "version": 1,
        "timeBase": [info.time_base[0], info.time_base[1]],
        "originPts": info.pts[0],
        "firstFrame": first_frame,
        "pts": list(info.pts[first_frame : first_frame + count]),
    }


def encode_frames_json(document: dict[str, Any]) -> bytes:
    """Compact JSON: the host bounds frames.json at 18 bytes per frame + 4 KB (BR4.12)."""
    return json.dumps(document, separators=(",", ":"), sort_keys=True, allow_nan=False).encode(
        "utf-8"
    )


def seek_seconds(info: VideoInfo, first_frame: int) -> float | None:
    """Input ``-ss`` that lands exactly on ``first_frame``: halfway after the previous frame.

    ``-ss`` counts from the container start time, so that is subtracted (engine rule).
    """
    if first_frame <= 0:
        return None
    base = Fraction(info.time_base[0], info.time_base[1])
    midpoint = Fraction(info.pts[first_frame - 1] + info.pts[first_frame], 2) * base
    return max(float(midpoint) - info.start_time, 0.0)


def decode_argv(ffmpeg: str, path: str, info: VideoInfo, first_frame: int, count: int) -> list[str]:
    """The decode command: engine colour, passthrough frames, display size."""
    argv = [ffmpeg, "-nostdin", "-v", "error"]
    seek = seek_seconds(info, first_frame)
    if seek is not None:
        argv += ["-ss", repr(seek)]
    argv += ["-i", path, "-map", "0:v:0", "-fps_mode", "passthrough", "-frames:v", str(count)]
    width, height = info.display_size
    upright = (info.height, info.width) if info.rotation in (90, 270) else (info.width, info.height)
    if (width, height) != upright:
        argv += ["-vf", f"scale={width}:{height}", "-sws_flags", "bicubic"]
    argv += ["-an", "-sn", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    return argv


class FfmpegTools:
    """The real :class:`~framepilot_smart_mask.backend.MediaTools`."""

    def __init__(self, ffmpeg: Path, ffprobe: Path, report: ToolReport) -> None:
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.report = report

    def probe(self, path: str) -> VideoInfo:
        common = [str(self.ffprobe), "-v", "error", "-select_streams", "v:0", "-of", "json"]
        header = _run(
            [
                *common,
                "-show_entries",
                "stream=width,height,sample_aspect_ratio,time_base:stream_side_data=rotation:stream_tags=rotate:format=start_time",
                path,
            ],
            PROBE_TIMEOUT_SECONDS,
        )
        packets = _run(
            [*common, "-show_entries", "packet=pts,flags", path], PROBE_TIMEOUT_SECONDS * 10
        )
        if header.returncode != 0 or packets.returncode != 0:
            raise MediaUnreadableError("ffprobe could not read the media.")
        return parse_probe(header.stdout, packets.stdout)

    def frames(self, path: str, info: VideoInfo, first_frame: int, count: int) -> Iterator[Any]:
        import numpy as np

        width, height = info.display_size
        frame_bytes = width * height * 3
        process = subprocess.Popen(
            decode_argv(str(self.ffmpeg), path, info, first_frame, count),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        stdout: IO[bytes] | None = process.stdout
        try:
            assert stdout is not None
            for _ in range(count):
                data = _read_exact(stdout, frame_bytes)
                if data is None:
                    raise MediaUnreadableError(
                        "The media ended before every requested frame decoded."
                    )
                yield np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
        finally:
            if process.poll() is None:
                process.kill()
            if stdout is not None:
                stdout.close()
            process.wait()


def _read_exact(stream: IO[bytes], size: int) -> bytes | None:
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


__all__ = [
    "ENV_ALLOW_UNAPPROVED",
    "FORBIDDEN_CONFIGURE_FLAGS",
    "FfmpegBuildVerdict",
    "FfmpegTools",
    "ToolReport",
    "assess_ffmpeg_build",
    "decode_argv",
    "encode_frames_json",
    "frames_document",
    "locate_tool",
    "parse_probe",
    "seek_seconds",
    "verify_tools",
]
