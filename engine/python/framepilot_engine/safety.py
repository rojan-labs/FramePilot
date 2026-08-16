"""Path-sandbox primitives.

WHY: FramePilot is local-first and the AI/agent layer can request file
operations. Per **PRD §18.1 (Local file safety)** and **§18.2 (Agent safety)**,
all file access MUST be sandboxed to the project directory and MUST prevent path
traversal. This module is a real security primitive (not a stub): every file
operation in the engine should resolve user/agent-supplied paths through
:func:`resolve_within` before touching disk.
"""

from __future__ import annotations

from pathlib import Path


class PathTraversalError(Exception):
    """Raised when a candidate path escapes its sandbox base directory.

    This includes ``..`` traversal, absolute paths pointing outside the base,
    and symlink targets that resolve outside the base.
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

    :param base: The sandbox root directory. Resolved before comparison.
    :param candidate: A relative or absolute path supplied by a caller, the
        user, or the agent. Untrusted input.
    :returns: The resolved, sandbox-checked absolute path.
    :raises PathTraversalError: If the candidate escapes ``base``.
    """
    resolved_base = base.resolve()
    # ``candidate`` may be absolute; Path joining honours that, which is exactly
    # why we must re-check containment after resolving.
    resolved_candidate = (resolved_base / candidate).resolve()

    if resolved_candidate != resolved_base and resolved_base not in resolved_candidate.parents:
        raise PathTraversalError(
            f"Path escapes sandbox. base={resolved_base} candidate={candidate!r} "
            f"resolved={resolved_candidate}"
        )

    return resolved_candidate
