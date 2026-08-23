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
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

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
