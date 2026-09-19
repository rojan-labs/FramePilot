"""Bounded per-frame SAM image embeddings: RAM LRU, optional disk spill, else recompute.

One Hiera-L embedding is ~21 MiB (fpn0 8.4 + fpn1 4.2 + fpn2 4.2 + pos2 4.2). A 300-frame
window held in RAM would be 6.3 GB, which is how BR0's unbounded accumulation reached a 16 GB
footprint. The cache holds at most ``max_ram_bytes`` in memory; evicted embeddings are spilled
to the job's scratch directory while ``max_spill_bytes`` allows, and anything else is simply
re-encoded when asked for again (correct, only slower).
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from collections.abc import Callable, Hashable
from pathlib import Path
from typing import Final

import numpy as np

from .backend import ImageFeatures

_log = logging.getLogger(__name__)

_FIELDS: Final = ("fpn0", "fpn1", "fpn2", "pos2")


class EmbeddingCache:
    def __init__(
        self,
        encode: Callable[[Hashable], ImageFeatures],
        *,
        max_ram_bytes: int,
        spill_directory: Path | None = None,
        max_spill_bytes: int = 0,
    ) -> None:
        self._encode = encode
        self._ram: OrderedDict[Hashable, ImageFeatures] = OrderedDict()
        self._ram_bytes = 0
        self._max_ram = max(max_ram_bytes, 0)
        self._spill_dir = spill_directory
        self._max_spill = max(max_spill_bytes, 0) if spill_directory is not None else 0
        self._spilled: dict[Hashable, tuple[Path, int]] = {}
        self._spill_bytes = 0
        self.encodes = 0
        self.hits = 0
        self.spill_hits = 0

    @property
    def ram_bytes(self) -> int:
        return self._ram_bytes

    @property
    def spill_bytes(self) -> int:
        return self._spill_bytes

    def get(self, key: Hashable) -> ImageFeatures:
        hit = self._ram.get(key)
        if hit is not None:
            self._ram.move_to_end(key)
            self.hits += 1
            return hit
        spilled = self._spilled.get(key)
        if spilled is not None:
            features = self._load(spilled[0])
            self.spill_hits += 1
        else:
            features = self._encode(key)
            self.encodes += 1
        self._remember(key, features)
        return features

    def _remember(self, key: Hashable, features: ImageFeatures) -> None:
        size = features.nbytes
        if size > self._max_ram:
            self._spill(key, features)
            return
        self._ram[key] = features
        self._ram_bytes += size
        while self._ram_bytes > self._max_ram and self._ram:
            old_key, old = self._ram.popitem(last=False)
            self._ram_bytes -= old.nbytes
            self._spill(old_key, old)

    def _spill(self, key: Hashable, features: ImageFeatures) -> None:
        if self._spill_dir is None or key in self._spilled:
            return
        size = features.nbytes
        if self._spill_bytes + size > self._max_spill:
            return
        path = self._spill_dir / f"embedding-{len(self._spilled)}.npz"
        np.savez(path, **{name: getattr(features, name) for name in _FIELDS})
        self._spilled[key] = (path, size)
        self._spill_bytes += size

    @staticmethod
    def _load(path: Path) -> ImageFeatures:
        with np.load(path) as data:
            return ImageFeatures(*(np.array(data[name]) for name in _FIELDS))

    def clear(self) -> None:
        self._ram.clear()
        self._ram_bytes = 0
        for path, _size in self._spilled.values():
            path.unlink(missing_ok=True)
        self._spilled.clear()
        self._spill_bytes = 0

    def stats(self) -> dict[str, int]:
        return {
            "encodes": self.encodes,
            "ramHits": self.hits,
            "spillHits": self.spill_hits,
            "spilledBytes": self._spill_bytes,
        }


__all__ = ["EmbeddingCache"]
