"""Read a background-removal matte artifact for the export (BR2.1, plan 04, ADR 0178).

WHY: a ``matte`` mask is a raster alpha per SOURCE frame, delivered by the Smart Mask pack as
lossless FFV1 files in ``<project>/.framepilot-derived/mattes/<key>/``. A matte one frame off
its picture is a visible halo on every moving edge, so this module's contract is frame
identity, not "close enough":

* **Identity is a frame number, never an index computed from a time.** ``frames.json`` names
  the source frame of the first matte frame and the pts of every matte frame. The export looks
  a matte frame up by the SOURCE FRAME NUMBER its picture decodes (the frame plan's
  ``source.frame``); a caller holding a real pts looks it up by pts, exact to the tick. A frame
  the artifact does not hold is :class:`MatteFrameMissing`, never the nearest frame.
* **Digests before pixels.** Every file the export reads is hashed and compared with the digest
  the mask pinned in the project, before a reader opens (:func:`prepare_matte`).
* **Decode once, forward.** :class:`MatteReader` keeps one ``ffmpeg`` rawvideo pipe per file
  that only moves forward, so an export decodes each matte frame once, plus a small LRU so a
  frame grab or a reverse-speed clip does not restart a decoder per frame. It never holds more
  than the LRU's frames in memory.

``frames.json`` (written by the pack, BR3.2; verified by the host, BR4)::

    {"version": 1, "timeBase": [1, 15360], "originPts": 0, "firstFrame": 12,
     "pts": [6144, 6656, ...]}

``timeBase`` is the source stream's, ``originPts`` is the pts of the source's first decoded
frame (edit lists honoured: the asset's clock zero, where ``clip.sourceStart`` counts from),
``firstFrame`` is the decode-order number of the first matte frame, and ``pts[i]`` belongs to
source frame ``firstFrame + i``. Matte frame ``i`` of ``matte.mkv`` and ``foreground.mkv`` is
the ``i``-th decoded frame of each file.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import subprocess
from collections import OrderedDict
from dataclasses import dataclass
from enum import StrEnum
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from typing import IO, Any

import numpy as np
import numpy.typing as npt

from framepilot_engine.media.ffmpeg import find_export_ffmpeg, find_ffprobe
from framepilot_engine.render.pts_reader import VideoTiming
from framepilot_engine.safety import PathTraversalError, resolve_within
from framepilot_engine.subprocess_safety import validate_safe_argv

_log = logging.getLogger(__name__)

#: Project-relative home of every matte artifact (plan 03, MD-4: project-owned).
MATTES_DIR = ".framepilot-derived/mattes"
MATTE_FILE = "matte.mkv"
FOREGROUND_FILE = "foreground.mkv"
FRAMES_FILE = "frames.json"
FRAMES_VERSION = 1

#: Matte pixel formats the export reads, and the unsigned maximum each stores.
MATTE_PIXEL_FORMATS: dict[str, tuple[str, int]] = {
    "gray": ("gray", 255),
    "gray16le": ("gray16le", 65535),
}
#: Lossless RGB layouts FFV1 stores; each decodes to rgb24 without a colour-matrix step.
FOREGROUND_PIXEL_FORMATS = frozenset({"gbrp", "bgr0", "rgb24", "bgra", "rgba", "0rgb"})

#: Frames kept for random access. Export reads forward and hits the cursor, not the LRU.
DEFAULT_LRU_FRAMES = 8
#: A forward jump up to this many frames reads through instead of restarting the decoder.
FORWARD_READ_THROUGH = 48

_KEY = re.compile(r"^[0-9a-f]{64}$")


class MatteStatus(StrEnum):
    """How a refusal is shown on the clip (plan 05): BROKEN needs a re-run, STALE an update."""

    BROKEN = "broken"
    STALE = "stale"


class MatteRefusalCode(StrEnum):
    """Stable codes for a matte the export will not draw. The text never varies by magnitude."""

    MISSING = "matte_missing"
    DIGEST_MISMATCH = "matte_digest_mismatch"
    UNREADABLE = "matte_unreadable"
    UNSUPPORTED_PIXEL_FORMAT = "matte_unsupported_pixel_format"
    SIZE_MISMATCH = "matte_size_mismatch"
    OUT_OF_COVERAGE = "matte_out_of_coverage"
    FRAME_MISALIGNED = "matte_frame_misaligned"
    MEDIA_CHANGED = "matte_media_changed"


#: The one sentence the editor reads for each code: what happened and what to do.
MATTE_REMEDIES: dict[MatteRefusalCode, tuple[MatteStatus, str]] = {
    MatteRefusalCode.MISSING: (
        MatteStatus.BROKEN,
        "Background removal data is missing — run Remove background again.",
    ),
    MatteRefusalCode.DIGEST_MISMATCH: (
        MatteStatus.BROKEN,
        "Background removal data was changed outside FramePilot — run Remove background again.",
    ),
    MatteRefusalCode.UNREADABLE: (
        MatteStatus.BROKEN,
        "Background removal data is damaged — run Remove background again.",
    ),
    MatteRefusalCode.UNSUPPORTED_PIXEL_FORMAT: (
        MatteStatus.BROKEN,
        "Background removal data uses a format this version cannot read — "
        "update FramePilot or run Remove background again.",
    ),
    MatteRefusalCode.SIZE_MISMATCH: (
        MatteStatus.STALE,
        "Media changed since background removal ran — run Remove background again.",
    ),
    MatteRefusalCode.OUT_OF_COVERAGE: (
        MatteStatus.STALE,
        "Background removal does not cover the clip's whole range — "
        "update the background removal for the new range.",
    ),
    MatteRefusalCode.FRAME_MISALIGNED: (
        MatteStatus.STALE,
        "Background removal frames do not line up with the media — run Remove background again.",
    ),
    # Relinked or replaced media that decodes to different frames (BR4.14). Same sentence as a
    # size change: to the editor both are "the media changed".
    MatteRefusalCode.MEDIA_CHANGED: (
        MatteStatus.STALE,
        "Media changed since background removal ran — run Remove background again.",
    ),
}


class MatteRefusal(ValueError):
    """The export will not draw this matte. ``str()`` leads with the remedy (the one line shown)."""

    def __init__(self, code: MatteRefusalCode, mask_id: str, clip_id: str) -> None:
        status, remedy = MATTE_REMEDIES[code]
        self.code = code
        self.status = status
        self.remedy = remedy
        self.mask_id = mask_id
        self.clip_id = clip_id
        super().__init__(f"{remedy} (mask {mask_id!r} on clip {clip_id!r}, {code.value})")


class MatteFrameMissing(LookupError):
    """A source frame or pts the artifact does not hold. Never answered with a nearest frame."""


# --- frames.json --------------------------------------------------------------------------


@dataclass(frozen=True)
class MatteFrames:
    """The parsed ``frames.json``: which source frame and pts each matte frame is."""

    time_base: Fraction
    origin_pts: int
    first_frame: int
    pts: tuple[int, ...]

    @property
    def count(self) -> int:
        return len(self.pts)

    def index_for_source_frame(self, frame: int) -> int:
        """The matte frame holding decode-order source frame ``frame``.

        :raises MatteFrameMissing: The artifact does not hold that frame.
        """
        index = frame - self.first_frame
        if index < 0 or index >= self.count:
            raise MatteFrameMissing(
                f"Source frame {frame} is outside the matte's frames "
                f"[{self.first_frame}, {self.first_frame + self.count})."
            )
        return index

    def index_for_pts(self, pts: int) -> int:
        """The matte frame whose pts is exactly ``pts`` (source stream ticks).

        :raises MatteFrameMissing: No matte frame has that pts.
        """
        index = int(np.searchsorted(np.asarray(self.pts, dtype=np.int64), pts))
        if index < self.count and self.pts[index] == pts:
            return index
        raise MatteFrameMissing(f"No matte frame has pts {pts}.")

    def index_for_source_seconds(self, seconds: float) -> int:
        """The matte frame at asset source second ``seconds``, exact to half a tick.

        For a caller that holds a frame's real presentation time as seconds (float) rather than
        ticks; anything further than half a tick from every matte pts is missing.
        """
        ticks = float(self.origin_pts) + seconds / float(self.time_base)
        nearest = round(ticks)
        if abs(ticks - nearest) > 0.5 + 1e-9:  # pragma: no cover - round() is within 0.5
            raise MatteFrameMissing(f"No matte frame at source second {seconds!r}.")
        return self.index_for_pts(nearest)

    def source_seconds(self, index: int) -> float:
        """Asset source seconds of matte frame ``index``."""
        return float((self.pts[index] - self.origin_pts) * self.time_base)


#: Largest ``frames.json`` the export reads (BR4.12 L4); an honest one is ~18 bytes per frame.
FRAMES_MAX_BYTES = 64 * 1024 * 1024


def read_frames_file(path: Path) -> MatteFrames:
    """Read and parse ``frames.json`` with bounds for untrusted artifacts (BR4.12 fuzz corpus).

    :raises ValueError: Over :data:`FRAMES_MAX_BYTES`, not strict UTF-8 JSON (a BOM is refused),
        nested too deeply to parse, or not a valid frames document.
    """
    if path.stat().st_size > FRAMES_MAX_BYTES:
        raise ValueError("frames.json is larger than any matte needs.")
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError("frames.json must not start with a byte-order mark.")
    try:
        document = json.loads(raw.decode("utf-8"))
    except RecursionError as exc:
        raise ValueError("frames.json is nested too deeply.") from exc
    except UnicodeDecodeError as exc:
        raise ValueError("frames.json is not UTF-8.") from exc
    return parse_frames(document)


def parse_frames(document: Any) -> MatteFrames:
    """Validate a ``frames.json`` document.

    :raises ValueError: Wrong version, shape, or pts that are not strictly increasing.
    """
    if not isinstance(document, dict) or document.get("version") != FRAMES_VERSION:
        raise ValueError("frames.json must be an object with version 1.")
    time_base = document.get("timeBase")
    pts = document.get("pts")
    origin = document.get("originPts")
    first = document.get("firstFrame")
    if (
        not isinstance(time_base, list)
        or len(time_base) != 2
        or not all(isinstance(v, int) and not isinstance(v, bool) for v in time_base)
        or time_base[0] <= 0
        or time_base[1] <= 0
    ):
        raise ValueError("frames.json timeBase must be two positive integers.")
    if not isinstance(origin, int) or isinstance(origin, bool):
        raise ValueError("frames.json originPts must be an integer.")
    if not isinstance(first, int) or isinstance(first, bool) or first < 0:
        raise ValueError("frames.json firstFrame must be a non-negative integer.")
    if (
        not isinstance(pts, list)
        or not pts
        or not all(isinstance(v, int) and not isinstance(v, bool) for v in pts)
    ):
        raise ValueError("frames.json pts must be a non-empty list of integers.")
    if any(b <= a for a, b in pairwise(pts)):
        raise ValueError("frames.json pts must be strictly increasing.")
    # Values the export does arithmetic on must fit int64 with room to spare (BR4.12 fuzz corpus).
    bound = 2**52
    if (
        any(abs(v) > bound for v in (*time_base, origin, first))
        or abs(pts[0]) > bound
        or abs(pts[-1]) > bound
    ):
        raise ValueError("frames.json values are out of range.")
    return MatteFrames(
        time_base=Fraction(time_base[0], time_base[1]),
        origin_pts=origin,
        first_frame=first,
        pts=tuple(pts),
    )


# --- Artifact checks ----------------------------------------------------------------------

#: ``(path, size, mtime_ns) -> sha256`` so re-exporting a project does not re-hash its mattes.
_DIGESTS: dict[tuple[str, int, int], str] = {}


def file_sha256(path: Path) -> str:
    """The file's sha256 hex digest, cached by path, size and modification time."""
    stat = path.stat()
    cache_key = (str(path), stat.st_size, stat.st_mtime_ns)
    cached = _DIGESTS.get(cache_key)
    if cached is not None:
        return cached
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    value = digest.hexdigest()
    _DIGESTS[cache_key] = value
    return value


@dataclass(frozen=True)
class StreamInfo:
    """What ``ffprobe`` reports about the first video stream of an artifact file."""

    width: int
    height: int
    pixel_format: str
    frame_count: int


def probe_stream(path: Path) -> StreamInfo:
    """Size, pixel format and packet count (FFV1 is intra-only: one packet per frame).

    :raises ValueError: The file has no readable video stream.
    """
    argv = validate_safe_argv(
        [
            find_ffprobe(),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=width,height,pix_fmt,nb_read_packets",
            "-of",
            "json",
            str(path),
        ]
    )
    completed = subprocess.run(argv, capture_output=True, check=False, timeout=60)
    if completed.returncode != 0:
        raise ValueError(f"ffprobe could not read {path.name}.")
    streams = json.loads(completed.stdout or b"{}").get("streams") or []
    if not streams:
        raise ValueError(f"{path.name} has no video stream.")
    stream = streams[0]
    return StreamInfo(
        width=int(stream["width"]),
        height=int(stream["height"]),
        pixel_format=str(stream["pix_fmt"]),
        frame_count=int(stream.get("nb_read_packets") or 0),
    )


@dataclass(frozen=True)
class PreparedMatte:
    """An artifact that passed every pre-render check, ready for a :class:`MatteReader`."""

    mask_id: str
    clip_id: str
    directory: Path
    frames: MatteFrames
    width: int
    height: int
    matte_pixel_format: str
    matte_maximum: int
    has_foreground: bool


def matte_display_size(media: Any) -> tuple[int, int] | None:
    """The size a matte artifact for ``media`` is written at: its DISPLAY size (BR2.6).

    Pixel aspect ratio applied and a quarter-turn rotation turned (``AssetMedia.display_size``,
    MK1.9), each side the nearest integer with halves rounding up (``floor(x + 0.5)``, the same
    rule as ``editor-core``). ``None`` for media that was never measured.
    """
    display = media.display_size() if media is not None else None
    if display is None:
        return None
    return (math.floor(display[0] + 0.5), math.floor(display[1] + 0.5))


def artifact_directory(base_dir: Path, key: str) -> Path | None:
    """The artifact's directory inside the project, or ``None`` for a malformed or escaping key."""
    if not _KEY.fullmatch(key):
        return None
    try:
        return resolve_within(base_dir, f"{MATTES_DIR}/{key}")
    except PathTraversalError:
        return None


def prepare_matte(
    mask: Any,
    clip: Any,
    base_dir: Path,
    media: Any,
    project_fps: float,
) -> PreparedMatte:
    """Check a matte mask's artifact before anything renders.

    Order matters: a missing file is BROKEN before its digest is asked about, and a digest
    is trusted before the file is parsed or probed.

    :param mask: The ``MatteMask``.
    :param clip: The clip carrying it.
    :param base_dir: The project directory (``AssetIndex.base_dir``).
    :param media: The asset's ``AssetMedia`` (probed size, PAR, rotation), or ``None``.
    :param project_fps: Sequence fps; the coverage tolerance is half a frame of it.
    :raises MatteRefusal: With the code and remedy for the first failed check.
    """

    def refuse(code: MatteRefusalCode) -> MatteRefusal:
        return MatteRefusal(code, str(mask.id), str(clip.id))

    artifact = mask.artifact
    directory = artifact_directory(base_dir, str(artifact.key))
    if directory is None or not directory.is_dir():
        raise refuse(MatteRefusalCode.MISSING)
    pinned = {entry.name: entry.sha256 for entry in artifact.files}
    wanted = [MATTE_FILE, FRAMES_FILE]
    if mask.decontaminate:
        wanted.append(FOREGROUND_FILE)
    for name in wanted:
        if name not in pinned or not (directory / name).is_file():
            raise refuse(MatteRefusalCode.MISSING)
    for name in wanted:
        if file_sha256(directory / name) != pinned[name]:
            raise refuse(MatteRefusalCode.DIGEST_MISMATCH)
    try:
        frames = read_frames_file(directory / FRAMES_FILE)
        matte_stream = probe_stream(directory / MATTE_FILE)
        foreground_stream = (
            probe_stream(directory / FOREGROUND_FILE) if mask.decontaminate else None
        )
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        # Type name only: OSError text carries the project path (BR4.12 L1).
        _log.warning("matte %s unreadable: %s", artifact.key[:12], type(exc).__name__)
        raise refuse(MatteRefusalCode.UNREADABLE) from exc
    if matte_stream.pixel_format not in MATTE_PIXEL_FORMATS or (
        foreground_stream is not None
        and foreground_stream.pixel_format not in FOREGROUND_PIXEL_FORMATS
    ):
        raise refuse(MatteRefusalCode.UNSUPPORTED_PIXEL_FORMAT)
    for stream in (matte_stream, foreground_stream):
        if stream is None:
            continue
        if stream.frame_count != frames.count:
            raise refuse(MatteRefusalCode.FRAME_MISALIGNED)
        if (stream.width, stream.height) != (artifact.width, artifact.height):
            raise refuse(MatteRefusalCode.SIZE_MISMATCH)
    display = matte_display_size(media)
    if display is not None and display != (artifact.width, artifact.height):
        raise refuse(MatteRefusalCode.SIZE_MISMATCH)
    tolerance = 0.5 / project_fps if project_fps > 0 else 1e-3
    source_start = float(clip.source_start)
    source_end = float(clip.source_end if clip.source_end is not None else clip.source_start)
    coverage = artifact.coverage
    if (
        source_start < float(coverage.source_start) - tolerance
        or source_end > float(coverage.source_end) + tolerance
    ):
        raise refuse(MatteRefusalCode.OUT_OF_COVERAGE)
    maximum = MATTE_PIXEL_FORMATS[matte_stream.pixel_format][1]
    _log.debug(
        "matte %s ready: %d frames from source frame %d, %s",
        artifact.key[:12],
        frames.count,
        frames.first_frame,
        matte_stream.pixel_format,
    )
    return PreparedMatte(
        mask_id=str(mask.id),
        clip_id=str(clip.id),
        directory=directory,
        frames=frames,
        width=int(artifact.width),
        height=int(artifact.height),
        matte_pixel_format=matte_stream.pixel_format,
        matte_maximum=maximum,
        has_foreground=foreground_stream is not None,
    )


def assert_frames_align(
    prepared: PreparedMatte, source_frames: list[int], timing: VideoTiming | None
) -> None:
    """Refuse, before rendering, unless the matte is frame-exact for everything the export reads.

    Two checks. Every decode-order source frame the clip reads must be in the artifact. And each
    matte frame's pts must be the pts of the source frame it claims (``firstFrame + i``), within
    half the coarser of the two time bases' ticks, measured from each clock's own zero: this is
    what catches a matte made from other footage, another frame rate, or a frame dropped or
    duplicated by the pack, on constant- and variable-rate sources alike.

    :param source_frames: Every decode-order source frame number the clip reads.
    :param timing: The source's frame timestamps (:func:`video_timing`), when they could be read.
    :raises MatteRefusal: ``matte_frame_misaligned``.
    """
    frames = prepared.frames
    refusal = MatteRefusal(MatteRefusalCode.FRAME_MISALIGNED, prepared.mask_id, prepared.clip_id)
    for frame in source_frames:
        try:
            frames.index_for_source_frame(frame)
        except MatteFrameMissing as exc:
            raise refusal from exc
    if timing is None:
        return
    if frames.first_frame + frames.count > timing.count:
        raise refusal
    source_tick = float(timing.time_base)
    tolerance = max(source_tick, float(frames.time_base)) / 2.0 + 1e-9
    origin = timing.pts[0]
    for index in range(frames.count):
        source_seconds = float((timing.pts[frames.first_frame + index] - origin) * timing.time_base)
        if abs(source_seconds - frames.source_seconds(index)) > tolerance:
            raise refusal


# --- Decoding -----------------------------------------------------------------------------

UIntArray = npt.NDArray[np.uint8] | npt.NDArray[np.uint16]


@dataclass(frozen=True)
class MatteFrame:
    """One matte frame at the artifact's source resolution."""

    index: int
    alpha: UIntArray
    maximum: int
    foreground: npt.NDArray[np.uint8] | None


class _RawCursor:
    """One forward-only ffmpeg rawvideo pipe over an FFV1 file, starting at a frame."""

    def __init__(
        self,
        path: Path,
        pixel_format: str,
        frame_bytes: int,
        start: int,
        seek_seconds: float | None,
    ) -> None:
        argv = [find_export_ffmpeg(), "-nostdin", "-v", "error"]  # the export's binary (BR2.8)
        if seek_seconds is not None:
            argv += ["-ss", repr(seek_seconds)]
        argv += [
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            pixel_format,
            "-",
        ]
        self._proc: subprocess.Popen[bytes] | None = subprocess.Popen(
            validate_safe_argv(argv),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
        )
        self._frame_bytes = frame_bytes
        self.next_index = start

    def read(self) -> bytes | None:
        """The next frame's bytes, or ``None`` at the end of the file."""
        proc = self._proc
        if proc is None or proc.stdout is None:
            return None
        stdout: IO[bytes] = proc.stdout
        data = stdout.read(self._frame_bytes)
        if len(data) != self._frame_bytes:
            return None
        self.next_index += 1
        return data

    def close(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        if proc.poll() is None:
            proc.kill()
        if proc.stdout is not None:
            proc.stdout.close()
        proc.wait()


class _Track:
    """Frame-indexed access to one artifact file: a forward cursor plus seek points."""

    def __init__(
        self,
        path: Path,
        pixel_format: str,
        width: int,
        height: int,
        channels: int,
        bytes_per_sample: int,
    ) -> None:
        self.path = path
        self.pixel_format = pixel_format
        self.shape = (height, width, channels) if channels > 1 else (height, width)
        self.dtype = np.uint16 if bytes_per_sample == 2 else np.uint8
        self.frame_bytes = width * height * channels * bytes_per_sample
        self._cursor: _RawCursor | None = None
        self._packet_seconds: list[float] | None = None
        self.decoder_starts = 0

    def _seek_seconds(self, index: int) -> float | None:
        """Where ``-ss`` lands exactly on frame ``index``: halfway after the previous frame."""
        if index == 0:
            return None
        if self._packet_seconds is None:
            self._packet_seconds = _packet_seconds(self.path)
        times = self._packet_seconds
        if index >= len(times):
            raise MatteFrameMissing(f"Matte file {self.path.name} has no frame {index}.")
        return (times[index - 1] + times[index]) / 2.0

    def _restart(self, index: int) -> None:
        self.close()
        self._cursor = _RawCursor(
            self.path, self.pixel_format, self.frame_bytes, index, self._seek_seconds(index)
        )
        self.decoder_starts += 1

    def read(self, index: int) -> npt.NDArray[Any]:
        """Frame ``index``, reading forward; the decoder restarts only for a far or back jump."""
        cursor = self._cursor
        if (
            cursor is None
            or index < cursor.next_index
            or index - cursor.next_index > FORWARD_READ_THROUGH
        ):
            self._restart(index)
            cursor = self._cursor
        assert cursor is not None
        while True:
            at = cursor.next_index
            data = cursor.read()
            if data is None:
                raise MatteFrameMissing(f"Matte file {self.path.name} ended before frame {index}.")
            if at == index:
                return np.frombuffer(data, dtype=self.dtype).reshape(self.shape)

    def close(self) -> None:
        if self._cursor is not None:
            self._cursor.close()
            self._cursor = None


def _packet_seconds(path: Path) -> list[float]:
    """Every packet's presentation time in ``path``, relative to the file's start, sorted.

    ``-ss`` on an input is relative to the container start time, so that is subtracted here.
    Demux only (no decode), so it is cheap even for a long matte.
    """
    argv = validate_safe_argv(
        [
            find_ffprobe(),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time:format=start_time",
            "-of",
            "json",
            str(path),
        ]
    )
    completed = subprocess.run(argv, capture_output=True, check=False, timeout=120)
    if completed.returncode != 0:
        raise MatteFrameMissing(f"Could not index matte file {path.name}.")
    document = json.loads(completed.stdout or b"{}")
    start = float((document.get("format") or {}).get("start_time") or 0.0)
    times = sorted(float(packet["pts_time"]) for packet in document.get("packets") or [])
    return [time - start for time in times]


class MatteReader:
    """Decoded matte (and foreground) frames of one prepared artifact.

    Not thread-safe; one reader per compiled clip. Always :meth:`close` it (the compiler
    registers it as a clip resource so ``close_clip_tree`` does).
    """

    def __init__(
        self,
        prepared: PreparedMatte,
        *,
        want_foreground: bool,
        lru_frames: int = DEFAULT_LRU_FRAMES,
    ) -> None:
        self.prepared = prepared
        pixel_format, maximum = MATTE_PIXEL_FORMATS[prepared.matte_pixel_format]
        self._maximum = maximum
        self._matte = _Track(
            prepared.directory / MATTE_FILE,
            pixel_format,
            prepared.width,
            prepared.height,
            1,
            2 if maximum > 255 else 1,
        )
        self._foreground = (
            _Track(
                prepared.directory / FOREGROUND_FILE,
                "rgb24",
                prepared.width,
                prepared.height,
                3,
                1,
            )
            if want_foreground and prepared.has_foreground
            else None
        )
        self._lru: OrderedDict[int, MatteFrame] = OrderedDict()
        self._lru_frames = max(1, lru_frames)

    @property
    def frames(self) -> MatteFrames:
        return self.prepared.frames

    @property
    def decoder_starts(self) -> int:
        """How many decoder processes were started (a test hook for "never re-seek per frame")."""
        starts = self._matte.decoder_starts
        if self._foreground is not None:
            starts += self._foreground.decoder_starts
        return starts

    def frame(self, index: int) -> MatteFrame:
        """Matte frame ``index`` (see :meth:`MatteFrames.index_for_source_frame`).

        :raises MatteFrameMissing: ``index`` is outside the artifact.
        """
        if index < 0 or index >= self.frames.count:
            raise MatteFrameMissing(f"Matte frame {index} is outside the artifact.")
        hit = self._lru.get(index)
        if hit is not None:
            self._lru.move_to_end(index)
            return hit
        alpha = self._matte.read(index)
        foreground = self._foreground.read(index) if self._foreground is not None else None
        frame = MatteFrame(
            index=index,
            alpha=alpha,
            maximum=self._maximum,
            foreground=None if foreground is None else foreground.astype(np.uint8, copy=False),
        )
        self._lru[index] = frame
        while len(self._lru) > self._lru_frames:
            self._lru.popitem(last=False)
        return frame

    def frame_for_source_frame(self, source_frame: int) -> MatteFrame:
        """The matte frame for decode-order source frame ``source_frame``."""
        return self.frame(self.frames.index_for_source_frame(source_frame))

    def close(self) -> None:
        self._matte.close()
        if self._foreground is not None:
            self._foreground.close()
        self._lru.clear()
