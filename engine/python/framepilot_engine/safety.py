"""Path-sandbox primitives.

WHY: FramePilot is local-first and the AI/agent layer can request file
operations. Per **PRD §18.1 (Local file safety)** and **§18.2 (Agent safety)**,
all file access MUST be sandboxed to the project directory and MUST prevent path
traversal. This module is a real security primitive (not a stub): every file
operation in the engine should resolve user/agent-supplied paths through
:func:`resolve_within` before touching disk.
"""

from __future__ import annotations

import os
from pathlib import Path


class PathTraversalError(Exception):
    """Raised when a candidate path escapes its sandbox base directory.

    This includes ``..`` traversal, absolute paths pointing outside the base,
    symlink targets that resolve outside the base, and a NUL byte (which no file
    name can hold).
    """


def resolve_within(base: Path, candidate: str) -> Path:
    """Resolve ``candidate`` and guarantee it stays inside ``base``.

    The returned path is fully resolved (symlinks and ``..`` collapsed). If the
    resolved path is not ``base`` itself or a descendant of it, this raises
    :class:`PathTraversalError`.

    Examples::

        >>> base = Path("/projects/demo").resolve()
        >>> resolve_within(base, "assets/clip.mp4")  # doctest: +SKIP
        PosixPath('/projects/demo/assets/clip.mp4')

        >>> resolve_within(base, "../secret.key")  # doctest: +SKIP
        Traceback (most recent call last):
            ...
        framepilot_engine.safety.PathTraversalError: ...

    WHY this exact shape (``os.path.realpath`` + one ``startswith`` on the value
    that is returned): it is the containment idiom static analysis (CodeQL's
    ``py/path-injection``) recognises as a sanitiser, so the routes that funnel
    through here are seen as checked instead of each needing its own suppression.
    ``Path.resolve()`` + ``base not in path.parents`` is equally correct at runtime
    (on Python 3.13 ``Path.resolve`` IS ``os.path.realpath``) but is not
    recognised. The trailing separator on both sides makes "inside or equal to the
    root" a single prefix test and rules out the sibling-prefix bug (``/projects``
    vs ``/projects-evil``): never compare against a bare root. The test is
    case-sensitive; on Windows ``realpath`` returns the on-disk case of every
    existing component, so a candidate spelled in another case still carries the
    root's exact prefix.

    :param base: The sandbox root directory. Resolved before comparison.
    :param candidate: A relative or absolute path supplied by a caller, the
        user, or the agent. Untrusted input.
    :returns: The resolved, sandbox-checked absolute path.
    :raises PathTraversalError: If the candidate escapes ``base`` or holds a NUL byte.
    """
    if "\x00" in candidate:
        raise PathTraversalError(
            "Path contains a NUL byte, which no file name can hold. Remove it and send "
            "the path again."
        )
    # ``os.path`` on purpose (not ``Path /``): the string idiom is what the analyser
    # models; see the docstring. ``join(x, "")`` appends exactly one separator.
    root = os.path.realpath(base)
    root_prefix = os.path.join(root, "")  # noqa: PTH118
    # ``candidate`` may be absolute; joining honours that, which is exactly why
    # containment is re-checked after resolving.
    real_candidate = os.path.realpath(os.path.join(root, candidate))  # noqa: PTH118
    resolved = os.path.join(real_candidate, "")  # noqa: PTH118
    if not resolved.startswith(root_prefix):
        raise PathTraversalError(
            f"Path escapes sandbox. This engine instance is configured for projects "
            f"root base={root}, candidate={candidate!r} resolved={real_candidate}. "
            "If this path is expected to be valid, this sidecar may have been started "
            "for a different projects root — check which sidecar/port is handling the "
            "request."
        )
    # ``Path`` drops the trailing separator the check needed.
    return Path(resolved)
