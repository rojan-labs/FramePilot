"""Subprocess argv hardening gate.

WHY: the engine launches external binaries (ffmpeg, ffprobe, whisper-cli) with
argument vectors whose values ultimately derive from user or agent input
(media paths, model names, filter parameters) — PRD §18.1/§18.2. Every real
``subprocess`` sink in the engine routes its argv through this gate so there is
one auditable place that validates, before exec:

1. the vector is a non-empty sequence of plain ``str`` (a ``Path`` or ``None``
   slipping through a caller refactor fails here, not obscurely at the OS);
2. no argument embeds a NUL byte;
3. the binary itself is never option-shaped (``argv[0]`` must not start with
   ``-``), so a poisoned binary override cannot become an option of another
   program.

The engine never executes with ``shell=True``, so shell metacharacters are
inert; this gate closes the remaining class — *argument injection*, where an
unvalidated value in an operand position (e.g. a media path shaped like
``--config=…``) would be parsed as an *option* by the target binary. Call sites
that accept potentially-relative operand paths use :func:`safe_operand` to
defuse leading dashes.

Call sites whose operands carry a caller-supplied path launch through
:func:`run_argv` / :func:`popen_argv`: the trusted binary is its own parameter
and reaches ``subprocess`` as the first element of a literal list, never
through a shell.
"""

from __future__ import annotations

import logging
import subprocess
from collections.abc import Sequence
from typing import Any

_log = logging.getLogger("framepilot_engine.subprocess_safety")


class UnsafeArgvError(ValueError):
    """Raised when an argv vector fails subprocess-safety validation."""


def validate_safe_argv(argv: Sequence[str]) -> list[str]:
    """Return ``argv`` as a validated plain-``str`` list safe to hand to
    ``subprocess.run`` (which must always be called without ``shell=True``).

    :param argv: Full argument vector with the binary as ``argv[0]``.
    :returns: A defensive copy as ``list[str]``.
    :raises UnsafeArgvError: If the vector is empty, contains a non-string
        element, embeds a NUL byte anywhere, or has an option-shaped binary.
    """
    args = list(argv)
    if not args:
        raise UnsafeArgvError("Refusing to execute an empty command vector.")
    for index, arg in enumerate(args):
        if not isinstance(arg, str):
            raise UnsafeArgvError(
                f"argv[{index}] must be str, got {type(arg).__name__}: {arg!r}"
            )
        if "\x00" in arg:
            raise UnsafeArgvError(f"argv[{index}] contains a NUL byte: {arg!r}")
    if args[0].startswith("-"):
        _log.warning("Rejected option-shaped binary name %r", args[0])
        raise UnsafeArgvError(f"argv[0] looks like an option, not a binary: {args[0]!r}")
    return args


def safe_operand(value: str) -> str:
    """Defuse a possibly-relative operand path that starts with ``-``.

    A bare ``-`` is meaningful (stdin/stdout convention) and passes through
    untouched; any other dash-leading operand is prefixed with ``./`` so the
    target binary parses it as a path instead of an option. Absolute paths
    (starting with ``/``) cannot be option-shaped and pass through unchanged.
    """
    if value == "-" or not value.startswith("-"):
        return value
    _log.info("Defused dash-leading operand %r as './%s'", value, value)
    return f"./{value}"


def _checked_vector(binary: str, operands: Sequence[str], kwargs: dict[str, Any]) -> list[str]:
    """Validate ``[binary, *operands]`` and refuse a substitute executable."""
    if "executable" in kwargs:
        raise UnsafeArgvError(
            "Refusing executable=: it would run a program other than the validated argv[0]. "
            "Pass the program as the binary instead."
        )
    return validate_safe_argv([binary, *operands])


def run_argv(
    binary: str, operands: Sequence[str], **kwargs: Any
) -> subprocess.CompletedProcess[Any]:
    """``subprocess.run`` of ``binary`` with ``operands``, validated and never through a shell.

    WHY the binary is its own parameter and the call builds a literal list: only
    ``argv[0]`` decides what runs, and it comes from the engine's binary resolvers
    (``find_ffprobe`` and friends), never from a request. A list literal whose first
    element is that binary lets static analysis (CodeQL's command-line-injection
    query) see that a caller-supplied path is an operand, not the command; handing
    ``subprocess`` a variable holding the whole vector reads as "the command is
    tainted". ``executable=`` is refused (it would swap the program) and ``shell``
    is fixed, so ``shell=True`` from a caller is a ``TypeError``.

    :param binary: The program to run, from a trusted resolver.
    :param operands: Everything after ``argv[0]``; may carry sandboxed paths.
    :param kwargs: Passed to :func:`subprocess.run` (``capture_output``, ``timeout``, ...).
    :returns: The completed process.
    :raises UnsafeArgvError: If the vector fails :func:`validate_safe_argv`, or
        ``executable`` is given.
    """
    checked = _checked_vector(binary, operands, kwargs)
    return subprocess.run([binary, *checked[1:]], shell=False, **kwargs)


def popen_argv(binary: str, operands: Sequence[str], **kwargs: Any) -> subprocess.Popen[Any]:
    """``subprocess.Popen`` counterpart of :func:`run_argv`, with the same guarantees.

    :param binary: The program to run, from a trusted resolver.
    :param operands: Everything after ``argv[0]``; may carry sandboxed paths.
    :param kwargs: Passed to :class:`subprocess.Popen` (pipes, ``stdin``, ...).
    :returns: The started process.
    :raises UnsafeArgvError: If the vector fails :func:`validate_safe_argv`, or
        ``executable`` is given.
    """
    checked = _checked_vector(binary, operands, kwargs)
    return subprocess.Popen([binary, *checked[1:]], shell=False, **kwargs)
