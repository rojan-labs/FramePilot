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
#: ``clips`` is MoviePy's own composite-membership attribute; ``_framepilot_children`` is this
#: module's escape hatch for a clip whose real children are captured in a closure rather than
#: exposed as an attribute (e.g. a blend-mode ``frame_function`` closing over the layers it
#: blends) — those layers are attached here purely so this walk can find and close them too.
_CHILD_SEQUENCE_ATTRS = ("clips", "_framepilot_children")
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


#: Attributes on a MoviePy clip that hold an ffmpeg reader owning OS pipes.
_READER_ATTRS = ("reader", "audio_reader")


def _release_reader_pipes(node: Any) -> None:
    """Close the ffmpeg pipes MoviePy's own ``close()`` leaves open.

    Both `FFMPEG_VideoReader.close()` and `FFMPEG_AudioReader.close()` are written as::

        if self.proc:
            if self.proc.poll() is None:   # only when STILL RUNNING
                self.proc.terminate()
                self.proc.stdout.close()
                self.proc.stderr.close()
                self.proc.wait()
            self.proc = None

    A reader whose ffmpeg has already exited — the normal end of a render, where the
    process finished on its own — therefore drops the reference **without closing
    `stdout`/`stderr`**, and the file descriptors survive until the garbage collector
    happens to run the reader's ``__del__``. Under `-W error::ResourceWarning` that
    surfaces as `unclosed file <_io.BufferedReader>`; in a long-lived sidecar it surfaces
    as RSS that climbs export after export.

    Called BEFORE the node's own ``close()``, because that method nulls ``proc`` and the
    handles become unreachable afterwards.
    """
    for attr in _READER_ATTRS:
        reader = getattr(node, attr, None)
        proc = getattr(reader, "proc", None) if reader is not None else None
        if proc is None:
            continue
        for pipe_name in ("stdout", "stderr", "stdin"):
            pipe = getattr(proc, pipe_name, None)
            if pipe is None or getattr(pipe, "closed", True):
                continue
            try:
                pipe.close()
            except Exception:  # pragma: no cover - teardown must keep walking
                _log.debug("close_clip_tree: %s.%s.close() failed", attr, pipe_name, exc_info=True)


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
            # Before close(), which nulls `proc` and makes the pipes unreachable.
            _release_reader_pipes(node)
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
