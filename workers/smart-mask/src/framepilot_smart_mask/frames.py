"""Decoded frames for one processing window, kept off the heap.

A 300-frame 4K window is 7.4 GB of RGB; holding it in memory would repeat BR0's accumulation
incident. Frames are written once into a scratch memory map inside the job's own staging
directory (``scratch/``) and read back by index, so resident memory stays at the pages being
touched. The map is deleted when the window finishes.
"""

from __future__ import annotations

import logging
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Final

import numpy as np
import numpy.typing as npt

from .backend import MediaTools, VideoInfo
from .protocol import ProtocolError

_log = logging.getLogger(__name__)

#: Free space kept on the volume beyond the scratch file itself.
SCRATCH_HEADROOM_BYTES: Final = 512 * 1024 * 1024

Frame = npt.NDArray[np.uint8]


class FrameStore:
    """Fixed-size RGB frames by index, in a memory map (or in RAM when no directory is given)."""

    def __init__(
        self, directory: Path | None, count: int, height: int, width: int, name: str = "frames"
    ) -> None:
        self.count = count
        self.height = height
        self.width = width
        self.path: Path | None = None
        shape = (count, height, width, 3)
        if directory is None:
            self._frames: Any = np.zeros(shape, dtype=np.uint8)
            return
        needed = count * height * width * 3
        free = shutil.disk_usage(directory).free
        if needed + SCRATCH_HEADROOM_BYTES > free:
            raise ProtocolError(
                "output_unwritable",
                "There is not enough free disk space to decode this clip for background removal.",
                retryable=True,
            )
        self.path = directory / f"{name}.u8"
        self._frames = np.lib.format.open_memmap(self.path, mode="w+", dtype=np.uint8, shape=shape)

    def __len__(self) -> int:
        return self.count

    def __getitem__(self, index: int) -> Frame:
        frame: Frame = self._frames[index]
        return frame

    def __setitem__(self, index: int, frame: Frame) -> None:
        if frame.shape != (self.height, self.width, 3):
            raise ProtocolError(
                "internal_error", "A decoded frame does not have the window's display size."
            )
        self._frames[index] = frame

    def close(self) -> None:
        frames = self._frames
        self._frames = None
        del frames
        if self.path is not None:
            self.path.unlink(missing_ok=True)


def decode_into(
    tools: MediaTools,
    path: str,
    info: VideoInfo,
    first_frame: int,
    store: FrameStore,
    on_frame: Any = None,
) -> None:
    """Decode ``len(store)`` frames starting at source frame ``first_frame`` into ``store``.

    ``on_frame(index)`` runs after each frame (progress and cancellation checks).
    """
    iterator: Iterator[Frame] = tools.frames(path, info, first_frame, len(store))
    written = 0
    for index, frame in enumerate(iterator):
        store[index] = frame
        written += 1
        if on_frame is not None:
            on_frame(index)
    if written != len(store):
        from .backend import MediaUnreadableError

        raise MediaUnreadableError("The media ended before every requested frame decoded.")
    _log.debug("decoded %d frames from source frame %d", written, first_frame)


__all__ = ["FrameStore", "decode_into"]
