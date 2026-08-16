"""Derived media: proxies, frame stills, and thumbnails (plan 2.1).

WHY: the editor UI never plays the full-resolution source directly (PRD §9.2 —
preview uses proxy media); it needs (a) a fast low-res **proxy** for smooth
scrubbing, (b) single **frames** (e.g. for the playhead / poster), and (c)
evenly spaced **thumbnails** for the timeline filmstrip. All three are thin,
deterministic ffmpeg invocations. The timestamp math for thumbnails is factored
into a pure helper so it is unit-testable without ffmpeg.

Callers are expected to sandbox-resolve input/output paths first (see
:func:`framepilot_engine.safety.resolve_within`).
"""

from __future__ import annotations

from pathlib import Path

from framepilot_engine.media.ffmpeg import Runner, find_ffmpeg, run_logs
from framepilot_engine.media.probe import inspect_media

# Default proxy height — 540p is smooth to scrub while a fraction of source size.
DEFAULT_PROXY_HEIGHT = 540

# CFR target: kills the variable-frame-rate passthrough that made the frame-queue
# math (and any future WebCodecs decode-ahead consumer) unreliable — screen/
# talking-head recordings are the worst VFR offenders.
DEFAULT_PROXY_FPS = 30

# Bumped whenever generate_proxy's ffmpeg args change in a way that affects the
# decoded output (GOP, colorspace, fps, container flags, ...). service.py mixes
# this into the derived-proxy cache digest so an encode change reliably
# re-derives every proxy instead of silently reusing a stale transcode.
PROXY_ENCODE_VERSION = "v2-cfr-cgop-bt709"


def _default_runner(timeout: float | None) -> Runner:
    """A :data:`Runner` that runs ffmpeg with ``timeout`` (stderr captured)."""
    return lambda argv: run_logs(argv, timeout=timeout)


def thumbnail_timestamps(duration_seconds: float, count: int) -> list[float]:
    """Evenly spaced timestamps (segment midpoints) for ``count`` thumbnails (pure).

    Midpoints avoid the very first/last frames (often black or a slate). For
    ``count=4`` over 8s this yields ``[1, 3, 5, 7]``.

    :param duration_seconds: Source duration.
    :param count: Number of thumbnails to place (must be >= 1).
    :returns: ``count`` timestamps in seconds, ascending.
    :raises ValueError: If ``count < 1`` or ``duration_seconds <= 0``.
    """
    if count < 1:
        raise ValueError(f"count must be >= 1, got {count}.")
    if duration_seconds <= 0:
        raise ValueError(f"duration_seconds must be > 0, got {duration_seconds}.")
    segment = duration_seconds / count
    return [segment * (i + 0.5) for i in range(count)]


def generate_proxy(
    source: Path,
    output: Path,
    *,
    height: int = DEFAULT_PROXY_HEIGHT,
    fps: int = DEFAULT_PROXY_FPS,
    runner: Runner | None = None,
    timeout: float | None = 300.0,
) -> Path:
    """Transcode ``source`` to a fast, low-res proxy at ``output`` (plan 2.1, P-1).

    Scales to ``height`` preserving aspect (width rounded to an even number for
    H.264), normalizes to constant frame rate ``fps``, and re-encodes with a
    fast preset. The GOP is a short, closed, B-frame-free half-second interval
    (``max(1, fps // 2)``) with scene-cut keyframe insertion disabled, so a seek
    to an arbitrary cut point never has to decode more than ~0.5s of runway —
    this is what the DOM `<video>` preview pool seeks/pre-rolls against, and
    what a future WebCodecs decode-ahead consumer needs to be cheap. Output is
    explicitly tagged BT.709 (never left for the player to guess) and written
    with a front-loaded ``moov`` atom (``+faststart``) for O(1) random access.

    :param source: Input media path (must exist).
    :param output: Destination proxy path (parent dirs are created).
    :param height: Target proxy height in pixels.
    :param fps: Target constant frame rate.
    :param runner: ffmpeg invoker; defaults to the real subprocess runner.
    :param timeout: Hard timeout for the transcode.
    :returns: ``output``.
    :raises FileNotFoundError: If ``source`` does not exist.
    :raises FFmpegError: If the transcode fails.
    """
    if not source.exists():
        raise FileNotFoundError(f"Source media does not exist: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    invoke = runner or _default_runner(timeout)
    keyframe_interval = max(1, fps // 2)
    invoke(
        [
            find_ffmpeg(),
            "-y",
            "-i",
            str(source),
            "-vf",
            f"scale=-2:{height},fps={fps}",
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-g",
            str(keyframe_interval),
            "-keyint_min",
            str(keyframe_interval),
            "-sc_threshold",
            "0",
            "-flags",
            "+cgop",
            "-bf",
            "0",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-movflags",
            "+faststart",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-b:a",
            "128k",
            str(output),
        ]
    )
    return output


def extract_frame(
    source: Path,
    output: Path,
    *,
    time_seconds: float = 0.0,
    runner: Runner | None = None,
    timeout: float | None = 60.0,
) -> Path:
    """Extract a single frame at ``time_seconds`` to ``output`` (e.g. a PNG).

    :param source: Input media path (must exist).
    :param output: Destination image path (parent dirs are created).
    :param time_seconds: Seek position of the frame.
    :param runner: ffmpeg invoker; defaults to the real subprocess runner.
    :param timeout: Hard timeout for the extraction.
    :returns: ``output``.
    :raises FileNotFoundError: If ``source`` does not exist.
    :raises FFmpegError: If extraction fails.
    """
    if not source.exists():
        raise FileNotFoundError(f"Source media does not exist: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    invoke = runner or _default_runner(timeout)
    invoke(
        [
            find_ffmpeg(),
            "-y",
            "-ss",
            f"{time_seconds}",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-update",
            "1",
            str(output),
        ]
    )
    return output


def generate_thumbnails(
    source: Path,
    output_dir: Path,
    *,
    count: int = 5,
    runner: Runner | None = None,
    timeout: float | None = 120.0,
) -> list[Path]:
    """Extract ``count`` evenly spaced thumbnails into ``output_dir`` (plan 2.1).

    Probes the source for its duration, places thumbnails at segment midpoints
    (see :func:`thumbnail_timestamps`), and writes ``thumb_000.png`` … .

    :param source: Input media path (must exist).
    :param output_dir: Directory to write thumbnails into (created if needed).
    :param count: Number of thumbnails.
    :param runner: ffmpeg invoker; defaults to the real subprocess runner.
    :param timeout: Hard per-frame timeout.
    :returns: The list of written thumbnail paths, ascending by time.
    :raises FileNotFoundError: If ``source`` does not exist.
    :raises FFmpegError: If the source has no probeable duration or extraction fails.
    """
    # Bound the probe with the same timeout so a crafted source cannot hang the
    # duration lookup that precedes frame extraction.
    info = inspect_media(source, timeout=timeout)  # also raises FileNotFoundError if missing
    if not info.duration_seconds:
        from framepilot_engine.media.ffmpeg import FFmpegError

        raise FFmpegError(f"Cannot place thumbnails: {source} has no known duration.")

    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for index, ts in enumerate(thumbnail_timestamps(info.duration_seconds, count)):
        out = output_dir / f"thumb_{index:03d}.png"
        extract_frame(source, out, time_seconds=ts, runner=runner, timeout=timeout)
        paths.append(out)
    return paths
