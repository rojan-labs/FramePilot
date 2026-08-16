"""ffmpeg/ffprobe binary discovery and subprocess invocation.

WHY: media inspection (plan 2.1) and render validation (plan 2.3) both shell out
to ``ffprobe``/``ffmpeg``. Centralising *where the binaries come from* and *how
they are run* here keeps that single concern in one place and — crucially — lets
the rest of the engine depend on an injectable :data:`Runner` callable so unit
tests can exercise the parsing/validation logic without the real binaries
installed (dependency inversion).

Binary discovery order (both binaries):

1. An explicit environment override — ``FRAMEPILOT_FFPROBE`` / ``FRAMEPILOT_FFMPEG``.
2. The binary on ``PATH`` (``shutil.which``).
3. For ffmpeg only: the copy bundled with ``imageio-ffmpeg`` (a hard dependency
   of MoviePy), so a render machine always has *an* ffmpeg even without a system
   install. ffprobe is **not** bundled by imageio-ffmpeg, so it must be on PATH
   or set via the override.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Callable, Sequence

# A Runner takes a fully-resolved argv (binary first) and returns captured
# stdout as text, raising FFmpegError on a non-zero exit or timeout. Injecting
# this lets callers/tests substitute a fake without touching subprocess.
Runner = Callable[[Sequence[str]], str]

_FFPROBE_ENV = "FRAMEPILOT_FFPROBE"
_FFMPEG_ENV = "FRAMEPILOT_FFMPEG"


class FFmpegError(RuntimeError):
    """An ffprobe/ffmpeg invocation failed (non-zero exit or timeout)."""


class FFmpegNotFoundError(FFmpegError):
    """The requested ffprobe/ffmpeg binary could not be located."""


class NoAudioStreamError(FFmpegError):
    """An audio-only analysis was asked of media that carries no audio stream.

    Distinguished from a generic :class:`FFmpegError` because it is not a
    failure to fix but a fact about the file: an audio decode of a silent clip
    exits non-zero with ``Output file does not contain any stream``, and pasting
    that ffmpeg dump at a creator (or at the model, which then retries it)
    explains nothing. Callers turn this into "this clip has no audio track".
    """


def _from_env(var: str) -> str | None:
    """Return a usable binary path from environment variable ``var``, if set."""
    raw = os.environ.get(var)
    if not raw or not raw.strip():
        return None
    return raw.strip()


def find_ffprobe() -> str:
    """Locate the ``ffprobe`` binary.

    :returns: An absolute path or bare command name runnable as ffprobe.
    :raises FFmpegNotFoundError: If ffprobe cannot be found.
    """
    override = _from_env(_FFPROBE_ENV)
    if override:
        return override
    found = shutil.which("ffprobe")
    if found:
        return found
    raise FFmpegNotFoundError(
        "ffprobe not found. Install ffmpeg (which ships ffprobe) or set "
        f"{_FFPROBE_ENV} to its path. imageio-ffmpeg does NOT bundle ffprobe."
    )


def find_ffmpeg() -> str:
    """Locate the ``ffmpeg`` binary, falling back to the imageio-ffmpeg copy.

    :returns: An absolute path or bare command name runnable as ffmpeg.
    :raises FFmpegNotFoundError: If ffmpeg cannot be found by any route.
    """
    override = _from_env(_FFMPEG_ENV)
    if override:
        return override
    found = shutil.which("ffmpeg")
    if found:
        return found
    # MoviePy depends on imageio-ffmpeg, so this bundled binary is always present
    # on a render machine even when no system ffmpeg is installed.
    try:
        import imageio_ffmpeg

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception as exc:  # pragma: no cover - exercised only without ffmpeg
        raise FFmpegNotFoundError(
            f"ffmpeg not found on PATH, via {_FFMPEG_ENV}, or via imageio-ffmpeg."
        ) from exc


def _run_checked(argv: Sequence[str], timeout: float | None) -> subprocess.CompletedProcess[bytes]:
    """Run ``argv`` to completion, raising on a missing binary, timeout, or
    non-zero exit. Returns the completed process so callers can read whichever
    stream they need (ffprobe → stdout; ffmpeg filters → stderr)."""
    try:
        completed = subprocess.run(
            list(argv),
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise FFmpegNotFoundError(f"Binary not found: {argv[0]!r}") from exc
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError(f"Timed out after {timeout}s: {argv[0]!r}") from exc

    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace").strip()
        raise FFmpegError(f"{argv[0]!r} exited {completed.returncode}: {stderr or '<no stderr>'}")
    return completed


def run(argv: Sequence[str], *, timeout: float | None = None) -> str:
    """Run ``argv`` capturing **stdout**; raise :class:`FFmpegError` on failure.

    This is the default :data:`Runner` for ffprobe, whose JSON goes to stdout.

    :param argv: Full argument vector with the binary as ``argv[0]``.
    :param timeout: Optional hard timeout in seconds.
    :returns: Captured stdout decoded as UTF-8 (errors replaced).
    :raises FFmpegError: On non-zero exit, timeout, or a missing binary.
    """
    return _run_checked(argv, timeout).stdout.decode("utf-8", errors="replace")


def run_logs(argv: Sequence[str], *, timeout: float | None = None) -> str:
    """Run ``argv`` capturing **stderr**; raise :class:`FFmpegError` on failure.

    ffmpeg analysis filters (``blackdetect``, ``volumedetect``) emit their
    findings on stderr while real output goes to ``-f null`` / a file, so render
    validation reads stderr rather than stdout.

    :param argv: Full argument vector with the binary as ``argv[0]``.
    :param timeout: Optional hard timeout in seconds.
    :returns: Captured stderr decoded as UTF-8 (errors replaced).
    :raises FFmpegError: On non-zero exit, timeout, or a missing binary.
    """
    return _run_checked(argv, timeout).stderr.decode("utf-8", errors="replace")


def run_bytes(argv: Sequence[str], *, timeout: float | None = None) -> bytes:
    """Run ``argv`` capturing **raw stdout bytes**; raise on failure.

    Used when ffmpeg streams binary data (e.g. decoded PCM for waveforms) to
    stdout, which must not be UTF-8 decoded.

    :param argv: Full argument vector with the binary as ``argv[0]``.
    :param timeout: Optional hard timeout in seconds.
    :returns: Captured stdout as raw bytes.
    :raises FFmpegError: On non-zero exit, timeout, or a missing binary.
    """
    return _run_checked(argv, timeout).stdout
