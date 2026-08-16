"""Deterministic teardown for a compiled MoviePy composition.

``CompositeVideoClip.close()`` does not close the source clips it composites. FramePilot walks
the full clip graph and also releases compiler-owned temporary resources only after every media
reader has closed, so ffmpeg readers never outlive media and temporary files never disappear
while a reader can still seek them.
"""

from __future__ import annotations

import logging
from typing import Any

_log = logging.getLogger(__name__)

_CHILD_ATTRS = ("audio", "mask", "bg")
_CHILD_SEQUENCE_ATTRS = ("clips",)
_RESOURCE_SEQUENCE_ATTRS = ("_framepilot_resources",)


def _children(clip: Any) -> list[Any]:
    found: list[Any] = []
    for attr in _CHILD_SEQUENCE_ATTRS:
        sequence = getattr(clip, attr, None)
        if isinstance(sequence, (list, tuple)):
            found.extend(child for child in sequence if child is not None)
    for attr in _CHILD_ATTRS:
        child = getattr(clip, attr, None)
        if child is not None:
            found.append(child)
    return found


def _resources(node: Any) -> list[Any]:
    found: list[Any] = []
    for attr in _RESOURCE_SEQUENCE_ATTRS:
        sequence = getattr(node, attr, None)
        if isinstance(sequence, (list, tuple)):
            found.extend(resource for resource in sequence if resource is not None)
    return found


def close_clip_tree(clip: Any) -> int:
    """Close ``clip`` and every composed clip, then release owned external resources.

    Resource teardown is deliberately deferred until after the clip graph. A processed
    ``AudioFileClip`` can still hold an ffmpeg reader on a compiler temporary WAV; deleting the
    workspace first would turn deterministic cleanup into a race with that reader.
    """
    if clip is None:
        return 0

    seen: set[int] = set()
    seen_resources: set[int] = set()
    resources: list[Any] = []
    stack: list[Any] = [clip]
    closed = 0
    while stack:
        node = stack.pop()
        if node is None or id(node) in seen:
            continue
        seen.add(id(node))
        stack.extend(_children(node))
        for resource in _resources(node):
            if id(resource) not in seen_resources:
                seen_resources.add(id(resource))
                resources.append(resource)
        close = getattr(node, "close", None)
        if not callable(close):
            continue
        try:
            close()
            closed += 1
        except Exception:  # pragma: no cover - teardown must keep walking
            _log.debug("close_clip_tree: %r.close() failed", type(node).__name__, exc_info=True)

    for resource in resources:
        close = getattr(resource, "close", None)
        if not callable(close):
            continue
        try:
            close()
        except Exception:  # pragma: no cover - best-effort final cleanup
            _log.debug(
                "close_clip_tree: resource %r.close() failed",
                type(resource).__name__,
                exc_info=True,
            )
    return closed
