"""The frame store keeps decoded windows off the heap and refuses a disk it would fill."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

np = pytest.importorskip("numpy")

from framepilot_smart_mask.backend import MediaUnreadableError, VideoInfo  # noqa: E402
from framepilot_smart_mask.frames import FrameStore, decode_into  # noqa: E402
from framepilot_smart_mask.protocol import ProtocolError  # noqa: E402


class ShortTools:
    def __init__(self, produce: int) -> None:
        self.produce = produce

    def frames(self, path: str, info: VideoInfo, first_frame: int, count: int) -> Iterator[Any]:
        for index in range(min(count, self.produce)):
            yield np.full((4, 6, 3), first_frame + index, np.uint8)


INFO = VideoInfo(6, 4, (1, 1), 0, (1, 24), tuple(range(20)), 0.0)


def test_memory_mapped_store_round_trips_and_deletes(tmp_path: Path) -> None:
    store = FrameStore(tmp_path, 5, 4, 6)
    decode_into(ShortTools(5), "clip", INFO, 10, store)  # type: ignore[arg-type]
    assert int(store[3][0, 0, 0]) == 13
    assert store.path is not None and store.path.exists()
    store.close()
    assert not store.path.exists()


def test_short_decode_is_media_unreadable() -> None:
    store = FrameStore(None, 5, 4, 6)
    with pytest.raises(MediaUnreadableError):
        decode_into(ShortTools(3), "clip", INFO, 0, store)  # type: ignore[arg-type]


def test_wrong_frame_size_is_refused() -> None:
    store = FrameStore(None, 1, 4, 6)
    with pytest.raises(ProtocolError):
        store[0] = np.zeros((4, 7, 3), np.uint8)


def test_scratch_refuses_a_disk_it_would_fill(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import shutil
    from collections import namedtuple

    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(shutil, "disk_usage", lambda _path: usage(10, 10, 1024))
    with pytest.raises(ProtocolError) as caught:
        FrameStore(tmp_path, 300, 2160, 3840)
    assert caught.value.code == "output_unwritable"
